import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, type CliOutput, type CliRuntime } from "../../src/cli/app";
import type { CredentialStore } from "../../src/credentials";

const temporaryDirectories: Array<string> = [];
const unusedCredentialStore: CredentialStore = {
  delete: async () => {},
  get: async () => undefined,
  set: async () => {},
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

const invoke = async (
  argv: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>> = {},
  runtime: Partial<CliRuntime> = {},
) => {
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

  const exitCode = await runCli(argv, output, {
    credentialStore: unusedCredentialStore,
    environment,
    platform: "linux",
    ...runtime,
  });

  return { exitCode, stderr, stdout };
};

describe("CLI application", () => {
  test("prints stable help to stdout", async () => {
    expect(await invoke(["--help"])).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `Usage: arty [options] [command]\n\nPublish temporary static Artifacts from local Sources.\n\nOptions:\n  -V, --version   output the version number\n  -h, --help      display help for command\n\nCommands:\n  config          Manage Arty settings.\n  help [command]  display help for command\n`,
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

  test("reports the seven-day default Lifetime", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "arty-config-test-"));
    temporaryDirectories.push(configHome);

    expect(
      await invoke(["config", "get", "default-lifetime"], {
        XDG_CONFIG_HOME: configHome,
      }),
    ).toEqual({ exitCode: 0, stderr: "", stdout: "7d\n" });
  });

  test("persists a configured default Lifetime in the platform config directory", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "arty-config-test-"));
    temporaryDirectories.push(configHome);
    const environment = { XDG_CONFIG_HOME: configHome };

    expect(
      await invoke(["config", "set", "default-lifetime", "90m"], environment),
    ).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    expect(
      await invoke(["config", "get", "default-lifetime"], environment),
    ).toEqual({ exitCode: 0, stderr: "", stdout: "90m\n" });
    expect(
      await readFile(join(configHome, "arty", "config.json"), "utf8"),
    ).toBe('{\n  "defaultLifetime": "90m"\n}\n');
  });

  test.each(["59s", "31d", "forever"])(
    "rejects an invalid default Lifetime: %s",
    async (lifetime) => {
      const configHome = await mkdtemp(join(tmpdir(), "arty-config-test-"));
      temporaryDirectories.push(configHome);

      const result = await invoke(
        ["config", "set", "default-lifetime", lifetime],
        { XDG_CONFIG_HOME: configHome },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "Lifetime must be between 1 minute and 30 days",
      );
    },
  );

  test("runs the credential set, get, and delete smoke test without exposing the secret", async () => {
    const calls: Array<string> = [];
    let storedValue: string | undefined;
    const credentialStore: CredentialStore = {
      delete: async () => {
        calls.push("delete");
        storedValue = undefined;
      },
      get: async () => {
        calls.push("get");
        return storedValue;
      },
      set: async (_account, value) => {
        calls.push("set");
        storedValue = value;
      },
    };

    const result = await invoke(
      ["_credential-smoke-test", "ci"],
      { ARTY_CREDENTIAL_SMOKE_VALUE: "do-not-print-me" },
      { credentialStore },
    );

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    expect(calls).toEqual(["set", "get", "delete"]);
  });

  test("redacts credential-store failures", async () => {
    const credentialStore: CredentialStore = {
      delete: async () => {},
      get: async () => undefined,
      set: async (_account, value) => {
        throw new Error(`native failure contained ${value}`);
      },
    };

    const result = await invoke(
      ["_credential-smoke-test", "ci"],
      { ARTY_CREDENTIAL_SMOKE_VALUE: "do-not-print-me" },
      { credentialStore },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error: The operating system credential store is unavailable.\n",
    );
    expect(result.stderr).not.toContain("do-not-print-me");
  });
});
