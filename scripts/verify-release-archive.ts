import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [archive, expectedVersion] = Bun.argv.slice(2);
if (archive === undefined || expectedVersion === undefined) {
  throw new Error("Usage: verify-release-archive <archive> <version>");
}

const directory = await mkdtemp(join(tmpdir(), "arty-release-"));
try {
  const extracted = Bun.spawnSync(["tar", "-xzf", archive, "-C", directory]);
  if (extracted.exitCode !== 0) {
    throw new Error(extracted.stderr.toString());
  }

  const executable = join(directory, "arty");
  await chmod(executable, 0o755);
  const result = Bun.spawnSync([executable, "--version"], {
    cwd: directory,
    env: { PATH: "/usr/bin:/bin" },
  });
  const output = result.stdout.toString().trim();
  if (result.exitCode !== 0 || output !== expectedVersion) {
    throw new Error(
      `Expected standalone Arty ${expectedVersion}, received ${JSON.stringify(output)}`,
    );
  }
} finally {
  await rm(directory, { force: true, recursive: true });
}
