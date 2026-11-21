import assert from "node:assert/strict";
import test from "node:test";
import {
  assertD1TriggerDefinitions,
  exclusiveMigrationTriggerDefinitions,
  runCloudflareDeployment,
  runCloudflareRecovery,
  type DeploymentOperations,
} from "./cloudflare-deploy";
import { createMaintenanceWranglerConfig, type WranglerConfig } from "./cloudflare-wrangler-config";

const exclusiveMigration = "0040_exclusive_settings_locale_preference.sql";

interface OperationFixture {
  active?: string;
  applied?: boolean;
  derivedBackfillPending?: boolean;
  failAt?: string | readonly string[];
  maintenanceVersion?: string;
  normalVersion?: string;
  recovery?: { workerVersion: string; bookmark?: string };
}

function operationsFixture(options: OperationFixture = {}): { events: string[]; operations: DeploymentOperations } {
  const events: string[] = [];
  let maintenanceSequence = 0;
  const event = async (name: string): Promise<void> => {
    events.push(name);
    const failures = typeof options.failAt === "string" ? [options.failAt] : options.failAt ?? [];
    if (failures.includes(name)) throw new Error(`${name} failed`);
  };
  return {
    events,
    operations: {
      async prepare() { await event("prepare"); },
      async ensureQueues() { await event("ensure-queues"); },
      async readActiveDeployment() {
        await event("read-active");
        return options.active ? { versionId: options.active, ...(options.recovery && { maintenance: options.recovery }) } : undefined;
      },
      async readAppliedExclusiveMigrations() {
        await event("read-migrations");
        return options.applied ? new Set([exclusiveMigration]) : new Set();
      },
      async readPendingDerivedBackfill() { return options.derivedBackfillPending ?? false; },
      async captureBookmark() {
        await event("checkpoint");
        return "bookmark-1";
      },
      async deployMaintenance() {
        maintenanceSequence += 1;
        await event(maintenanceSequence === 1 ? "deploy-maintenance" : maintenanceSequence === 2 ? "seal-maintenance" : "redeploy-maintenance");
        return { versionId: options.maintenanceVersion ?? `maintenance-${maintenanceSequence}` };
      },
      async waitForBackgroundDrain() { await event("drain"); },
      async applyMigrations() { await event("migrate"); },
      async verifyDatabase() { await event("verify-db"); },
      async deployNormal() {
        await event("deploy-normal");
        return { versionId: options.normalVersion ?? "normal-new" };
      },
      async restoreWorker(versionId) { await event(`restore-worker:${versionId}`); },
      async restoreDatabase(bookmark) { await event(`restore-db:${bookmark}`); },
      recordCheckpoint(bookmark, versionId) { events.push(`record:${bookmark}:${versionId ?? "none"}`); },
      recordRecoveryHint(bookmark, versionId) { events.push(`recovery:${bookmark}:${versionId ?? "none"}`); },
    },
  };
}

test("first install applies migrations without a maintenance window", async () => {
  const fixture = operationsFixture();

  await runCloudflareDeployment(fixture.operations, [exclusiveMigration]);

  assert.deepEqual(fixture.events, [
    "prepare",
    "ensure-queues",
    "read-active",
    "read-migrations",
    "checkpoint",
    "record:bookmark-1:none",
    "migrate",
    "verify-db",
    "deploy-normal",
    "verify-db",
  ]);
});

test("an already migrated database keeps the fast deployment path", async () => {
  const fixture = operationsFixture({ active: "old", applied: true });

  await runCloudflareDeployment(fixture.operations, [exclusiveMigration]);

  assert.equal(fixture.events.includes("deploy-maintenance"), false);
  assert.equal(fixture.events.includes("drain"), false);
  assert.deepEqual(fixture.events.slice(-4), ["migrate", "verify-db", "deploy-normal", "verify-db"]);
});

test("a pending exclusive migration drains background executions before its first write", async () => {
  const fixture = operationsFixture({ active: "old" });

  await runCloudflareDeployment(fixture.operations, [exclusiveMigration]);

  assert.deepEqual(fixture.events.slice(4), [
    "deploy-maintenance",
    "drain",
    "checkpoint",
    "seal-maintenance",
    "record:bookmark-1:old",
    "migrate",
    "verify-db",
    "deploy-normal",
    "verify-db",
  ]);
});

test("a pending v5 derived backfill drains background executions without a new exclusive migration", async () => {
  const fixture = operationsFixture({ active: "old", applied: true, derivedBackfillPending: true });

  await runCloudflareDeployment(fixture.operations, [exclusiveMigration]);

  assert.deepEqual(fixture.events.slice(4), [
    "deploy-maintenance",
    "drain",
    "checkpoint",
    "seal-maintenance",
    "record:bookmark-1:old",
    "migrate",
    "verify-db",
    "deploy-normal",
    "verify-db",
  ]);
});

test("failure before D1 writes restores the previous Worker and triggers", async () => {
  const fixture = operationsFixture({ active: "old", failAt: "drain" });

  await assert.rejects(
    runCloudflareDeployment(fixture.operations, [exclusiveMigration]),
    /drain failed/,
  );

  assert.equal(fixture.events.includes("migrate"), false);
  assert.equal(fixture.events.at(-1), "restore-worker:old");
  assert.equal(fixture.events.some((value) => value.startsWith("recovery:")), false);
});

test("an unchanged or failed maintenance deployment restores the previous Worker", async () => {
  const unchanged = operationsFixture({ active: "old", maintenanceVersion: "old" });
  await assert.rejects(
    runCloudflareDeployment(unchanged.operations, [exclusiveMigration]),
    /did not replace the previous Worker version/,
  );
  assert.equal(unchanged.events.at(-1), "restore-worker:old");
  assert.equal(unchanged.events.includes("migrate"), false);

  const failed = operationsFixture({ active: "old", failAt: "deploy-maintenance" });
  await assert.rejects(
    runCloudflareDeployment(failed.operations, [exclusiveMigration]),
    /deploy-maintenance failed/,
  );
  assert.equal(failed.events.at(-1), "restore-worker:old");
  assert.equal(failed.events.includes("migrate"), false);
});

test("a failed pre-write Worker restore reports both failures", async () => {
  const fixture = operationsFixture({ active: "old", failAt: ["drain", "restore-worker:old"] });

  await assert.rejects(
    runCloudflareDeployment(fixture.operations, [exclusiveMigration]),
    /drain failed\nRestoring the previous Worker also failed: restore-worker:old failed/,
  );
});

test("migration failure records recovery evidence and keeps maintenance mode", async () => {
  const fixture = operationsFixture({ active: "old", failAt: "migrate" });

  await assert.rejects(
    runCloudflareDeployment(fixture.operations, [exclusiveMigration]),
    /migrate failed/,
  );

  assert.deepEqual(fixture.events.slice(-2), ["recovery:bookmark-1:old", "redeploy-maintenance"]);
  assert.equal(fixture.events.includes("restore-worker:old"), false);
});

test("final deployment failure also returns to maintenance mode", async () => {
  const fixture = operationsFixture({ active: "old", failAt: "deploy-normal" });

  await assert.rejects(
    runCloudflareDeployment(fixture.operations, [exclusiveMigration]),
    /deploy-normal failed/,
  );

  assert.deepEqual(fixture.events.slice(-2), ["recovery:bookmark-1:old", "redeploy-maintenance"]);
});

test("first-install failures never attempt a rollback without a previous Worker", async () => {
  for (const failAt of ["migrate", "deploy-normal"] as const) {
    const fixture = operationsFixture({ failAt });
    await assert.rejects(runCloudflareDeployment(fixture.operations, [exclusiveMigration]), new RegExp(`${failAt} failed`));
    assert.equal(fixture.events.some((value) => value.startsWith("restore-worker:")), false);
    assert.equal(fixture.events.includes("redeploy-maintenance"), false);
    assert.equal(fixture.events.some((value) => value.startsWith("recovery:")), false);
  }
});

test("post-write containment reports a maintenance redeploy failure without rolling back", async () => {
  const fixture = operationsFixture({ active: "old", failAt: ["migrate", "redeploy-maintenance"] });

  await assert.rejects(
    runCloudflareDeployment(fixture.operations, [exclusiveMigration]),
    /migrate failed\nRe-deploying maintenance mode also failed: redeploy-maintenance failed/,
  );
  assert.equal(fixture.events.includes("restore-worker:old"), false);
  assert.equal(fixture.events.includes("recovery:bookmark-1:old"), true);
});

test("a final deployment that remains on maintenance is contained", async () => {
  const fixture = operationsFixture({ active: "old", normalVersion: "maintenance-2" });

  await assert.rejects(
    runCloudflareDeployment(fixture.operations, [exclusiveMigration]),
    /still serving the maintenance Worker version/,
  );
  assert.deepEqual(fixture.events.slice(-2), ["recovery:bookmark-1:old", "redeploy-maintenance"]);
});

test("retry after a committed marker keeps the original checkpoint and normal version", async () => {
  const fixture = operationsFixture({ active: "maintenance-old", applied: true,
    recovery: { workerVersion: "normal-original", bookmark: "bookmark-original" } });
  await runCloudflareDeployment(fixture.operations, [exclusiveMigration]);
  assert.ok(!fixture.events.includes("checkpoint"));
  assert.ok(fixture.events.includes("record:bookmark-original:normal-original"));
  assert.ok(fixture.events.indexOf("drain") < fixture.events.indexOf("migrate"));
});

test("manual recovery restores D1 before the previous Worker", async () => {
  const fixture = operationsFixture({ active: "maintenance" });

  await runCloudflareRecovery(fixture.operations, {
    configPath: "normal.jsonc",
    maintenanceConfigPath: "maintenance.jsonc",
    bookmark: "bookmark-1",
    workerVersion: "worker-old-version",
  });

  assert.deepEqual(fixture.events, [
    "prepare",
    "ensure-queues",
    "deploy-maintenance",
    "drain",
    "restore-db:bookmark-1",
    "restore-worker:worker-old-version",
  ]);
});

test("manual recovery never rolls back the Worker when D1 restore fails", async () => {
  const fixture = operationsFixture({ active: "maintenance", failAt: "restore-db:bookmark-1" });

  await assert.rejects(
    runCloudflareRecovery(fixture.operations, {
      configPath: "normal.jsonc",
      maintenanceConfigPath: "maintenance.jsonc",
      bookmark: "bookmark-1",
      workerVersion: "worker-old-version",
    }),
    /restore-db:bookmark-1 failed/,
  );
  assert.equal(fixture.events.includes("restore-worker:worker-old-version"), false);
});

test("manual recovery returns to maintenance when restoring the old Worker fails", async () => {
  const fixture = operationsFixture({ active: "maintenance", failAt: "restore-worker:worker-old-version" });

  await assert.rejects(
    runCloudflareRecovery(fixture.operations, {
      configPath: "normal.jsonc",
      maintenanceConfigPath: "maintenance.jsonc",
      bookmark: "bookmark-1",
      workerVersion: "worker-old-version",
    }),
    /restore-worker:worker-old-version failed/,
  );
  assert.deepEqual(fixture.events.slice(-2), ["restore-worker:worker-old-version", "seal-maintenance"]);
});

test("manual recovery reports both Worker restore and maintenance containment failures", async () => {
  const fixture = operationsFixture({
    active: "maintenance",
    failAt: ["restore-worker:worker-old-version", "seal-maintenance"],
  });

  await assert.rejects(
    runCloudflareRecovery(fixture.operations, {
      configPath: "normal.jsonc",
      maintenanceConfigPath: "maintenance.jsonc",
      bookmark: "bookmark-1",
      workerVersion: "worker-old-version",
    }),
    /restore-worker:worker-old-version failed\nRe-deploying maintenance mode after recovery also failed/,
  );
});

test("exclusive migration verification rejects same-name trigger definition drift", () => {
  const expected = exclusiveMigrationTriggerDefinitions([exclusiveMigration]);
  const actual = [...expected].map(([name, sql]) => ({ name, sql }));
  assert.equal(actual.length, 2);
  assert.doesNotThrow(() => assertD1TriggerDefinitions(expected, actual));

  const drifted = actual.map((trigger, index) => index === 0
    ? { ...trigger, sql: trigger.sql.replace("RAISE(ABORT", "RAISE(IGNORE") }
    : trigger);
  assert.throws(() => assertD1TriggerDefinitions(expected, drifted), /definition drifted/);
});

test("maintenance config preserves assets, storage, and producer while disabling background triggers", () => {
  const normal: WranglerConfig = {
    name: "renewlet",
    assets: { binding: "ASSETS", directory: "dist" },
    d1_databases: [{ binding: "DB", database_id: "db" }],
    r2_buckets: [{ binding: "ASSETS_BUCKET", bucket_name: "assets" }],
    triggers: { crons: ["* * * * *"] },
    queues: {
      producers: [{ binding: "QUEUE", queue: "refresh" }],
      consumers: [{ queue: "refresh", max_batch_size: 1 }],
    },
    vars: { SETUP_ENABLED: "true", RENEWLET_MAINTENANCE_MODE: "false" },
  };

  const maintenance = createMaintenanceWranglerConfig(normal);

  assert.deepEqual(maintenance["assets"], normal["assets"]);
  assert.deepEqual(maintenance["d1_databases"], normal["d1_databases"]);
  assert.deepEqual(maintenance["r2_buckets"], normal["r2_buckets"]);
  assert.equal(maintenance["triggers"], undefined);
  assert.deepEqual((maintenance["queues"] as WranglerConfig)["producers"], (normal["queues"] as WranglerConfig)["producers"]);
  assert.deepEqual((maintenance["queues"] as WranglerConfig)["consumers"], []);
  assert.equal((maintenance["vars"] as WranglerConfig)["RENEWLET_MAINTENANCE_MODE"], "true");
});
