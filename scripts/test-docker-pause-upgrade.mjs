import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testFile = join(root, "apps/docker-server/cmd/renewlet/testdata/pause_release_upgrade_test.go");
const releases = [
  ["v0.3.28", "2b3e89dbf7168b5266370c3095676f32f12cbeea"],
  ["v0.3.37", "2aa8c8e1134d2d9670e888e03e9222c2ce00fbed"],
  ["v0.3.38", "91e81f7b435132d2be2d380f4ab81068753f92ba"],
];
for (const [tag, commit] of releases) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "renewlet-pause-upgrade-")));
  try {
    const pinned = execFileSync("git", ["rev-parse", `${tag}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
    if (pinned !== commit) throw new Error(`Unexpected commit for ${tag}`);
    const archive = join(scratch, "release.tar");
    execFileSync("git", ["archive", "-o", archive, commit, "apps/docker-server"], { cwd: root });
    execFileSync("tar", ["-xf", archive, "-C", scratch]);
    const data = join(scratch, "pb_data");
    mkdirSync(data);
    for (const phase of ["seed", "upgrade", "restart"]) {
      const cwd = join(phase === "seed" ? scratch : root, "apps/docker-server");
      const overlay = join(scratch, "overlay.json");
      writeFileSync(overlay, JSON.stringify({ Replace: { [join(cwd, "cmd/renewlet/pause_release_upgrade_test.go")]: testFile } }));
      const output = execFileSync("go", ["test", "-v", "-count=1", "-overlay", overlay, "./cmd/renewlet", "-run", "^TestReleasedPauseDatabaseUpgrade$"], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, RENEWLET_TEST_PAUSE_PHASE: phase, RENEWLET_TEST_PAUSE_DATA: data },
      });
      process.stdout.write(output);
      if (!output.includes("--- PASS: TestReleasedPauseDatabaseUpgrade")) throw new Error(`Missing ${tag} ${phase} test`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
