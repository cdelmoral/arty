import { describe, expect, test } from "bun:test";

import { runCli, type CliOutput } from "../../src/cli/app";

const invoke = async (argv: ReadonlyArray<string>) => {
  let stdout = "";
  let stderr = "";
  const output: CliOutput = {
    writeStderr: (text) => {
      stderr += text;
    },
    writeStdout: (text) => {
      stdout += text;
    },
  };

  const exitCode = await runCli(argv, output);

  return { exitCode, stderr, stdout };
};

describe("CLI application", () => {
  test("prints stable help to stdout", async () => {
    expect(await invoke(["--help"])).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `Usage: arty [options]\n\nPublish temporary static Artifacts from local Sources.\n\nOptions:\n  -V, --version  output the version number\n  -h, --help     display help for command\n`,
    });
  });

  test("prints only the version to stdout", async () => {
    expect(await invoke(["--version"])).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "0.1.0\n",
    });
  });

  test("reports invalid arguments on stderr", async () => {
    const result = await invoke(["--unknown"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: unknown option '--unknown'");
  });
});
