import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allowedNextVersions } from "./release.mjs";

const englishNotes = "# Renewlet v0.3.36\n\nEnglish release description.\n\n[中文 ->](./v0.3.36-zh.md)\n\n---\n\n## Fixes\n\n- Preserve account balances.\n";
const chineseNotes = "# Renewlet v0.3.36\n\n中文发布说明。\n\n[English ->](./v0.3.36-en.md)\n\n## 修复\n\n- 保留账户余额。\n";

function releaseFixture(t, overrides = {}) {
  // macOS 临时目录含 /var → /private/var 别名；CLI 参数与 import.meta.url 必须使用同一真实路径。
  const root = realpathSync(mkdtempSync(join(tmpdir(), "renewlet-release-notes-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "docs", "release-notes"), { recursive: true });
  cpSync(new URL("./release.mjs", import.meta.url), join(root, "scripts", "release.mjs"));
  for (const [locale, content] of Object.entries({ en: englishNotes, zh: chineseNotes, ...overrides })) {
    if (content !== undefined) writeFileSync(join(root, "docs", "release-notes", `v0.3.36-${locale}.md`), content);
  }
  return (command, version = "0.3.36") => spawnSync(process.execPath, [
    join(root, "scripts", "release.mjs"), command, "--version", version, "--previous", "v0.3.35",
  ], { cwd: root, encoding: "utf8", timeout: 10_000 });
}

for (const version of ["0.3.36", "v0.3.36", "0.3.36-rc.1", "v0.3.36-rc.2"]) {
  test(`generates English release notes and a tag-pinned Chinese link for ${version}`, (t) => {
    const run = releaseFixture(t);
    const normalized = version.replace(/^v/, "");
    const isRC = normalized.includes("-rc.");
    const expectedTags = isRC ? [normalized, "rc"] : [normalized, "0.3", "latest"];
    for (const command of ["notes", "release-body"]) {
      const result = run(command, version);
      assert.equal(result.status, 0, result.stderr || String(result.error));
      assert.equal(result.stderr, "");
      assert.ok(result.stdout.startsWith(`[简体中文](https://github.com/zhiyingzzhou/renewlet/blob/v${normalized}/docs/release-notes/v0.3.36-zh.md)\n\n`));
      assert.match(result.stdout, /English release description\./);
      assert.match(result.stdout, /## Fixes\n\n- Preserve account balances\./);
      assert.doesNotMatch(result.stdout, /中文发布说明|保留账户余额|^# Renewlet|\]\(\.\/|blob\/main\/|Docker 镜像/m);
      assert.equal(result.stdout.match(/Full Changelog/g)?.length, 1);
      assert.ok(result.stdout.includes(`https://github.com/zhiyingzzhou/renewlet/compare/v0.3.35...v${normalized}`));
      if (command === "release-body") {
        assert.match(result.stdout, /## Docker Images\n/);
        assert.deepEqual([...result.stdout.matchAll(/^  - `(.+)`$/gm)].map(match => match[1]), [
          ...expectedTags.map(tag => `zhiyingzzhou/renewlet:${tag}`),
          ...expectedTags.map(tag => `ghcr.io/zhiyingzzhou/renewlet:${tag}`),
        ]);
      } else {
        assert.doesNotMatch(result.stdout, /Docker Images|ghcr\.io/);
      }
    }
  });
}

for (const [label, content] of [
  ["missing", undefined],
  ["empty", ""],
  ["whitespace", " \n\t\r\n"],
  ["title only", "# Renewlet v0.3.36\n"],
  ["title and language link only", "# Renewlet v0.3.36\n\n[中文 ->](./v0.3.36-zh.md)"],
]) {
  test(`rejects ${label} English notes even when Chinese notes exist`, (t) => {
    const run = releaseFixture(t, { en: content });
    for (const command of ["notes", "release-body"]) {
      const result = run(command);
      assert.equal(result.status, 1, result.stderr || String(result.error));
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Missing or empty release notes: docs\/release-notes\/v0\.3\.36-en\.md/);
    }
  });
}

test("omits the Chinese link when no Chinese body is available", (t) => {
  for (const zh of [undefined, "", "# Renewlet v0.3.36\n"]) {
    const run = releaseFixture(t, { zh });
    for (const command of ["notes", "release-body"]) {
      const result = run(command);
      assert.equal(result.status, 0, result.stderr || String(result.error));
      assert.ok(result.stdout.startsWith("English release description."));
      assert.doesNotMatch(result.stdout, /简体中文|\[中文|v0\.3\.36-zh\.md/);
    }
  }
});

test("handles CRLF notes and a language link at end of file", (t) => {
  const run = releaseFixture(t, { en: "# Renewlet v0.3.36\r\n\r\nEnglish release description.\r\n\r\n[中文 ->](./v0.3.36-zh.md)" });
  const result = run("release-body");
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.match(result.stdout, /English release description\./);
  assert.doesNotMatch(result.stdout, /^# Renewlet|\]\(\.\//m);
});

test("allows standard patch and hotfix patch after 0.2.9", () => {
  assert.deepEqual(allowedNextVersions("0.2.9"), ["0.2.10", "0.2.91", "0.3.0", "1.0.0"]);
});

test("keeps next release choices based on the latest stable tag", () => {
  const allowed = allowedNextVersions("0.2.10");

  assert.deepEqual(allowed, ["0.2.11", "0.2.101", "0.3.0", "1.0.0"]);
  assert.equal(allowed.includes("0.2.91"), false);
});

test("allows standard and hotfix patch lines after an early minor patch", () => {
  assert.deepEqual(allowedNextVersions("0.3.2"), ["0.3.3", "0.3.21", "0.4.0", "1.0.0"]);
});

test("continues an existing hotfix patch line through standard patch increment", () => {
  const allowed = allowedNextVersions("0.3.21");

  assert.equal(allowed.includes("0.3.22"), true);
});

test("deduplicates standard and hotfix patch choices after patch zero", () => {
  assert.deepEqual(allowedNextVersions("0.1.0"), ["0.1.1", "0.2.0", "1.0.0"]);
});
