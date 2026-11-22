import assert from "node:assert/strict";
import test from "node:test";
import { assertWorkerCrons, maintenanceCheckpoint } from "./cloudflare-maintenance";

const normal = "12345678-abcd-4321-abcd-1234567890ab";
function version(vars: Record<string, string>) {
  return { resources: { bindings: Object.entries(vars).map(([name, text]) => ({ type: "plain_text", name, text })) } };
}

test("only a complete maintenance context can reuse a recovery bookmark", () => {
  assert.equal(maintenanceCheckpoint(version({ RENEWLET_MAINTENANCE_MODE: "false" })), undefined);
  const vars = { RENEWLET_MAINTENANCE_MODE: "true", RENEWLET_RECOVERY_WORKER: normal };
  assert.deepEqual(maintenanceCheckpoint(version(vars)), { workerVersion: normal });
  assert.deepEqual(maintenanceCheckpoint(version({ ...vars, RENEWLET_RECOVERY_BOOKMARK: "point-1" })), { workerVersion: normal, bookmark: "point-1" });
  assert.throws(() => maintenanceCheckpoint(version({ RENEWLET_MAINTENANCE_MODE: "true" })), /original deployment/);
  assert.throws(() => maintenanceCheckpoint({ resources: {} }), /bindings unavailable/);
});

test("Cron readback checks the actual expressions including a truly empty list", () => {
  assertWorkerCrons({ schedules: [] }, []);
  assertWorkerCrons({ schedules: [{ cron: "*/5 * * * *" }] }, ["*/5 * * * *"]);
  assert.throws(() => assertWorkerCrons({ schedules: [{ cron: "* * * * *" }] }, []));
  assert.throws(() => assertWorkerCrons({}, []));
});
