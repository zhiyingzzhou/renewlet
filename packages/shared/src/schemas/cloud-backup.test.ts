// 云备份 schema 测试保护 Docker/Worker/前端三端共用契约，尤其是 write-only 凭据和 ZIP 快照完整性边界。
import { describe, expect, it } from "vitest";
import {
  CLOUD_BACKUP_RAW_RESPONSE_TEXT_MAX_CHARS,
  cloudBackupCreateSnapshotRequestSchema,
  cloudBackupCreateSnapshotResponseSchema,
  cloudBackupConfigResponseSchema,
  cloudBackupConfigUpdateSchema,
  cloudBackupErrorDetailsSchema,
  cloudBackupPolicySchema,
  cloudBackupScheduleTimeSchema,
  cloudBackupScheduleWeekdaySchema,
  cloudBackupSnapshotManifestSchema,
} from "./cloud-backup";
import {
  fromRenewletExportSettingsV1,
  importPayloadSchema,
  renewletExportManifestV1Schema,
  renewletExportV1Schema,
  toRenewletExportSettingsV1,
} from "./import-export";

const success = <T>(data: T) => ({ ok: true, data });

describe("cloud backup schemas", () => {
  it("accepts WebDAV updates and normalizes remote paths", () => {
    const parsed = cloudBackupConfigUpdateSchema.parse({
      provider: "webdav",
      webdav: {
        url: "https://dav.example.com/remote.php/dav/files/user",
        username: "alice",
        path: "/renewlet/backups/",
      },
      credentials: { webdavPassword: "secret" },
      policy: {
        scheduleEnabled: true,
        scheduleFrequency: "daily",
        scheduleTime: "03:00",
        scheduleWeekday: "monday",
        retention: 7,
      },
    });

    expect(parsed.webdav?.path).toBe("renewlet/backups");
    expect(parsed.policy.scheduleTime).toBe("03:00");
  });

  it("requires HTTPS endpoints and rejects parent directory prefixes", () => {
    expect(cloudBackupConfigUpdateSchema.safeParse({
      provider: "webdav",
      policy: cloudBackupPolicySchema.parse({}),
    }).success).toBe(false);

    expect(cloudBackupConfigUpdateSchema.safeParse({
      provider: "webdav",
      webdav: {
        url: "http://dav.example.com",
        path: "renewlet",
      },
      policy: cloudBackupPolicySchema.parse({}),
    }).success).toBe(false);

    expect(cloudBackupConfigUpdateSchema.safeParse({
      provider: "s3",
      s3: {
        endpoint: "https://storage.example.com",
        bucket: "renewlet",
        region: "auto",
        prefix: "../renewlet",
        accessKeyId: "access",
      },
      policy: cloudBackupPolicySchema.parse({ scheduleFrequency: "weekly" }),
    }).success).toBe(false);

    expect(cloudBackupConfigUpdateSchema.safeParse({
      provider: "s3",
      s3: {
        endpoint: "https://storage.example.com",
        bucket: "renewlet",
        region: "",
        prefix: "renewlet",
        accessKeyId: "access",
      },
      policy: cloudBackupPolicySchema.parse({}),
    }).success).toBe(false);
  });

  it("strips deprecated S3 addressing style from old payloads", () => {
    const parsed = cloudBackupConfigUpdateSchema.parse({
      provider: "s3",
      s3: {
        endpoint: "https://cos.ap-guangzhou.myqcloud.com",
        region: "ap-guangzhou",
        bucket: "renewlet-1251530225",
        prefix: "snapshots",
        accessKeyId: "access",
        addressingStyle: "pathStyle",
      },
      policy: cloudBackupPolicySchema.parse({}),
    });

    expect(parsed.s3).toEqual({
      endpoint: "https://cos.ap-guangzhou.myqcloud.com",
      region: "ap-guangzhou",
      bucket: "renewlet-1251530225",
      prefix: "snapshots",
      accessKeyId: "access",
    });
  });

  it("normalizes empty remote prefixes to the same default as the Go runtime", () => {
    const webdav = cloudBackupConfigUpdateSchema.parse({
      provider: "webdav",
      webdav: {
        url: "https://dav.example.com/remote.php/dav/files/alice",
        path: "",
      },
      policy: cloudBackupPolicySchema.parse({}),
    });
    const s3 = cloudBackupConfigUpdateSchema.parse({
      provider: "s3",
      s3: {
        endpoint: "https://storage.example.com",
        bucket: "renewlet",
        region: "auto",
        prefix: "",
      },
      policy: cloudBackupPolicySchema.parse({}),
    });

    expect(webdav.webdav?.path).toBe("renewlet");
    expect(s3.s3?.prefix).toBe("renewlet");
  });

  it("validates provider-level policy and create requests", () => {
    expect(cloudBackupScheduleTimeSchema.parse("23:59")).toBe("23:59");
    expect(cloudBackupScheduleTimeSchema.safeParse("24:00").success).toBe(false);
    expect(cloudBackupScheduleWeekdaySchema.parse("sunday")).toBe("sunday");

    const policy = cloudBackupPolicySchema.parse({
      scheduleEnabled: true,
      scheduleFrequency: "weekly",
      scheduleTime: "03:30",
      scheduleWeekday: "friday",
      retention: 9,
    });
    expect(policy).toEqual({
      scheduleEnabled: true,
      scheduleFrequency: "weekly",
      scheduleTime: "03:30",
      scheduleWeekday: "friday",
      retention: 9,
    });

    expect(cloudBackupCreateSnapshotRequestSchema.parse({ provider: "s3" }).provider).toBe("s3");
    expect(cloudBackupCreateSnapshotRequestSchema.safeParse({}).success).toBe(false);
  });

  it("keeps config responses provider-scoped, redacted and rejects credential echo", () => {
    expect(cloudBackupConfigResponseSchema.parse(success({
      config: {
        provider: "s3",
        webdav: {
          url: "https://dav.example.com/remote.php/dav/files/alice",
          username: "alice",
          path: "renewlet",
        },
        s3: {
          endpoint: "https://storage.example.com",
          region: "us-east-1",
          bucket: "renewlet",
          prefix: "snapshots",
          accessKeyId: "access",
        },
        credentialSet: true,
        credentialSetByProvider: { webdav: true, s3: true },
        policyByProvider: {
          webdav: cloudBackupPolicySchema.parse({ scheduleTime: "02:00", retention: 3 }),
          s3: cloudBackupPolicySchema.parse({ scheduleFrequency: "weekly", scheduleWeekday: "friday", scheduleTime: "04:30", retention: 9 }),
        },
        statusByProvider: {
          webdav: {
            lastBackupAt: null,
            lastStatus: "idle",
            lastError: null,
            updatedAt: null,
          },
          s3: {
            lastBackupAt: "2026-06-09T00:00:00.000Z",
            lastStatus: "success",
            lastError: null,
            updatedAt: "2026-06-09T00:00:00.000Z",
          },
        },
        updatedAt: "2026-06-09T00:00:00.000Z",
      },
    })).data.config.credentialSet).toBe(true);

    expect(cloudBackupConfigResponseSchema.parse(success({
      config: {
        provider: "webdav",
        webdav: {
          url: "https://dav.example.com/remote.php/dav/files/alice",
          username: "alice",
          path: "renewlet",
        },
        s3: {
          endpoint: "https://storage.example.com",
          region: "us-east-1",
          bucket: "renewlet",
          prefix: "snapshots",
          accessKeyId: "access",
        },
        credentialSet: true,
        credentialSetByProvider: { webdav: true, s3: false },
        policyByProvider: {
          webdav: cloudBackupPolicySchema.parse({}),
          s3: cloudBackupPolicySchema.parse({}),
        },
        statusByProvider: {
          webdav: {
            lastBackupAt: null,
            lastStatus: "idle",
            lastError: null,
            updatedAt: null,
          },
          s3: {
            lastBackupAt: null,
            lastStatus: "idle",
            lastError: null,
            updatedAt: null,
          },
        },
        updatedAt: null,
      },
    })).data.config.s3?.bucket).toBe("renewlet");

    expect(cloudBackupConfigResponseSchema.safeParse(success({
      config: {
        provider: "s3",
        credentialSet: true,
        credentialSetByProvider: { webdav: false, s3: true },
        credentials: { s3SecretAccessKey: "secret" },
        policyByProvider: {
          webdav: cloudBackupPolicySchema.parse({}),
          s3: cloudBackupPolicySchema.parse({}),
        },
        statusByProvider: {
          webdav: {
            lastBackupAt: null,
            lastStatus: "idle",
            lastError: null,
            updatedAt: null,
          },
          s3: {
            lastBackupAt: null,
            lastStatus: "idle",
            lastError: null,
            updatedAt: null,
          },
        },
        updatedAt: null,
      },
    })).success).toBe(false);
    expect(cloudBackupConfigResponseSchema.safeParse({ config: { provider: "s3" } }).success).toBe(false);
  });

  it("validates multi-target create snapshot responses", () => {
    const id = "renewlet-export-v1-20260609T000000Z-abcd1234";
    const parsed = cloudBackupCreateSnapshotResponseSchema.parse(success({
      snapshots: [
        {
          id,
          filename: `${id}.zip`,
          provider: "webdav",
          createdAt: "2026-06-09T00:00:00.000Z",
          sizeBytes: 1024,
          sha256: "a".repeat(64),
        },
        {
          id,
          filename: `${id}.zip`,
          provider: "s3",
          createdAt: "2026-06-09T00:00:00.000Z",
          sizeBytes: 1024,
          sha256: "a".repeat(64),
        },
      ],
    })).data;

    expect(parsed.snapshots.map((snapshot) => snapshot.provider)).toEqual(["webdav", "s3"]);
  });

  it("validates snapshot manifests with sha256 integrity metadata", () => {
    expect(cloudBackupSnapshotManifestSchema.parse({
      kind: "renewlet-cloud-backup-snapshot",
      schemaVersion: 1,
      id: "renewlet-export-v1-20260609T000000Z-abcd1234",
      filename: "renewlet-export-v1-20260609T000000Z-abcd1234.zip",
      createdAt: "2026-06-09T00:00:00.000Z",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
      exportKind: "renewlet-export",
      exportSchemaVersion: 1,
    }).sha256).toHaveLength(64);

    expect(cloudBackupSnapshotManifestSchema.safeParse({
      kind: "renewlet-cloud-backup-snapshot",
      schemaVersion: 1,
      id: "bad",
      filename: "bad.zip",
      createdAt: "2026-06-09T00:00:00.000Z",
      sizeBytes: 1024,
      sha256: "not-a-sha",
      exportKind: "renewlet-export",
      exportSchemaVersion: 1,
    }).success).toBe(false);
  });

  it("validates raw upstream error details without accepting oversized bodies", () => {
    const parsed = cloudBackupErrorDetailsSchema.parse({
      rawResponseText: "<Error><Code>AccessDenied</Code></Error>",
    });

    expect(parsed.rawResponseText).toContain("AccessDenied");

    const local = cloudBackupErrorDetailsSchema.parse({
      rawResponseText: "Value out of range. Must be between -2147483648 and 2147483647 (inclusive).",
    });

    expect(local.rawResponseText).toContain("Value out of range");

    expect(cloudBackupErrorDetailsSchema.safeParse({
      rawResponseText: "x".repeat(CLOUD_BACKUP_RAW_RESPONSE_TEXT_MAX_CHARS + 1),
    }).success).toBe(false);
  });
});

describe("renewlet export schema", () => {
  it("validates export manifests with missing private asset audit entries", () => {
    const manifest = {
      kind: "renewlet-export",
      schemaVersion: 1,
      exportedAt: "2026-06-09T00:00:00.000Z",
      subscriptions: 2,
      assets: 1,
      missingAssets: [{
        assetId: "asset_missing",
        path: "/api/app/assets/asset_missing",
        reference: "subscription.logo",
        referenceId: "sub_1",
        reason: "file_missing",
      }],
    };

    expect(renewletExportManifestV1Schema.parse(manifest).missingAssets[0]?.reason).toBe("file_missing");
    expect(renewletExportManifestV1Schema.safeParse({
      ...manifest,
      missingAssets: [{ ...manifest.missingAssets[0], reason: "permission_denied" }],
    }).success).toBe(false);
    expect(renewletExportManifestV1Schema.safeParse({
      ...manifest,
      missingAssets: [{ ...manifest.missingAssets[0], reference: "settings.logo" }],
    }).success).toBe(false);
    expect(renewletExportManifestV1Schema.safeParse({
      ...manifest,
      missingAssets: [{ ...manifest.missingAssets[0], path: "assets/asset_missing.svg" }],
    }).success).toBe(false);
  });

  it("allows ZIP-internal asset logo paths without loosening subscription API paths", () => {
    expect(renewletExportV1Schema.safeParse({
      kind: "renewlet-export",
      schemaVersion: 1,
      exportedAt: "2026-06-09T00:00:00.000Z",
      data: {
        subscriptions: [{
          id: "sub_1",
          name: "Renewlet",
          logo: "assets/logo.svg",
          price: "9",
          currency: "USD",
          billingCycle: "monthly",
          category: "tools",
          status: "active",
          pinned: false,
          publicHidden: false,
          startDate: "2026-01-01",
          nextBillingDate: "2026-07-01",
          autoRenew: false,
          autoCalculateNextBillingDate: true,
          tags: [],
          reminderDays: -1,
          repeatReminderEnabled: false,
          repeatReminderInterval: "24h",
          repeatReminderWindow: "full",
          extra: {},
        }],
        assets: [{ id: "logo", path: "assets/logo.svg", mimeType: "image/svg+xml", sizeBytes: 128 }],
      },
    }).success).toBe(true);

    expect(renewletExportV1Schema.safeParse({
      kind: "renewlet-export",
      schemaVersion: 1,
      exportedAt: "2026-06-09T00:00:00.000Z",
      data: {
        subscriptions: [{
          id: "sub_1",
          name: "Renewlet",
          logo: "../logo.svg",
          price: "9",
          currency: "USD",
          billingCycle: "monthly",
          category: "tools",
          status: "active",
          pinned: false,
          publicHidden: false,
          startDate: "2026-01-01",
          nextBillingDate: "2026-07-01",
          autoRenew: false,
          autoCalculateNextBillingDate: true,
          tags: [],
          reminderDays: -1,
          repeatReminderEnabled: false,
          repeatReminderInterval: "24h",
          repeatReminderWindow: "full",
          extra: {},
        }],
      },
    }).success).toBe(false);
  });

  it("accepts exchange-rate snapshots only when they match the export and import schema", () => {
    const snapshot = {
      schemaVersion: 1,
      month: "2026-08",
      base: "USD",
      rates: { USD: 1, CNY: 7 },
      requestedProvider: "frankfurter",
      provider: "frankfurter",
      sourceDate: "2026-08-01",
      capturedAt: "2026-08-06T00:00:00.000Z",
    };

    expect(renewletExportV1Schema.safeParse({
      kind: "renewlet-export",
      schemaVersion: 1,
      exportedAt: "2026-08-06T00:00:00.000Z",
      data: {
        subscriptions: [],
        exchangeRateSnapshots: [snapshot],
      },
    }).success).toBe(true);
    expect(importPayloadSchema.safeParse({
      source: "renewlet",
      subscriptions: [],
      exchangeRateSnapshots: [snapshot],
    }).success).toBe(true);
    expect(renewletExportV1Schema.safeParse({
      kind: "renewlet-export",
      schemaVersion: 1,
      exportedAt: "2026-08-06T00:00:00.000Z",
      data: {
        subscriptions: [],
        exchangeRateSnapshots: [{ ...snapshot, provider: "builtin" }],
      },
    }).success).toBe(false);
  });

  it.each(["zh-CN", "en-US"] as const)("maps explicit %s preferences through the v1 locale field", (localePreference) => {
    const exported = toRenewletExportSettingsV1({ localePreference, defaultCurrency: "USD" });

    expect(exported).toEqual({ locale: localePreference, defaultCurrency: "USD" });
    expect(fromRenewletExportSettingsV1(exported)).toEqual({ localePreference, defaultCurrency: "USD" });
  });

  it("preserves the optional lunar display preference in v1 backups", () => {
    const exported = toRenewletExportSettingsV1({
      localePreference: "auto",
      defaultCurrency: "USD",
      showLunarCalendar: true,
    });

    expect(exported.showLunarCalendar).toBe(true);
    expect(fromRenewletExportSettingsV1({ defaultCurrency: "CNY" })).toEqual({ defaultCurrency: "CNY" });
  });

  it("omits auto from v1 exports and leaves an absent v1 locale out of the import patch", () => {
    expect(toRenewletExportSettingsV1({ localePreference: "auto", defaultCurrency: "USD" })).toEqual({
      defaultCurrency: "USD",
    });
    expect(fromRenewletExportSettingsV1({ defaultCurrency: "CNY" })).toEqual({ defaultCurrency: "CNY" });
  });
});
