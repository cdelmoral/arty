import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, type CliOutput, type CliRuntime } from "../../src/cli/app";
import type { CredentialStore } from "../../src/credentials";
import type { Provider } from "../../src/provider";

const temporaryDirectories: Array<string> = [];
const unusedCredentialStore: CredentialStore = {
  delete: async () => {},
  get: async () => undefined,
  set: async () => {},
};
const unusedProvider: Provider = {
  publish: async () => {
    throw new Error("Provider should not be called");
  },
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
    provider: unusedProvider,
    randomBytes: (length) => new Uint8Array(length),
    ...runtime,
  });

  return { exitCode, stderr, stdout };
};

describe("CLI application", () => {
  test.each([
    ["explicit", ["publish"]],
    ["implicit", []],
  ])("publishes one HTML Source with the %s command", async (_name, prefix) => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), "arty-source-test-"));
    temporaryDirectories.push(sourceDirectory);
    const sourcePath = join(sourceDirectory, "prototype.html");
    await Bun.write(sourcePath, "<h1>Hello from Arty</h1>");
    const requests: Array<{
      artifactId: string;
      content: Uint8Array;
      lifetimeMilliseconds: number;
    }> = [];
    const provider: Provider = {
      publish: async (request) => {
        requests.push(request);
        return {
          accessUrl: `https://arty.example/${request.artifactId}/`,
          expiresAt: "2026-10-09T12:00:00.000Z",
        };
      },
    };

    const result = await invoke(
      [...prefix, sourcePath],
      {},
      {
        provider,
        randomBytes: () => new Uint8Array(24).fill(255),
      },
    );

    expect(result).toEqual({
      exitCode: 0,
      stderr: "Published Artifact. Expires at 2026-10-09T12:00:00.000Z.\n",
      stdout: "https://arty.example/________________________________/\n",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.artifactId).toBe("________________________________");
    expect(requests[0]?.lifetimeMilliseconds).toBe(7 * 86_400_000);
    expect(new TextDecoder().decode(requests[0]?.content)).toBe(
      "<h1>Hello from Arty</h1>",
    );
  });

  test.each([
    ["minimum", "1m", 60_000],
    ["maximum", "30d", 30 * 86_400_000],
  ])(
    "uses the %s per-command Lifetime override",
    async (_name, lifetime, lifetimeMilliseconds) => {
      const sourceDirectory = await mkdtemp(
        join(tmpdir(), "arty-source-test-"),
      );
      temporaryDirectories.push(sourceDirectory);
      const sourcePath = join(sourceDirectory, "prototype.html");
      await Bun.write(sourcePath, "<h1>Temporary</h1>");
      const requests: Array<number> = [];
      const provider: Provider = {
        publish: async (request) => {
          requests.push(request.lifetimeMilliseconds);
          return {
            accessUrl: `https://arty.example/${request.artifactId}/`,
            expiresAt: "2026-11-01T00:00:00.000Z",
          };
        },
      };

      const result = await invoke(
        ["publish", "--lifetime", lifetime, sourcePath],
        {},
        { provider },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        "https://arty.example/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/\n",
      );
      expect(result.stderr).toContain("Expires at 2026-11-01T00:00:00.000Z.");
      expect(requests).toEqual([lifetimeMilliseconds]);
    },
  );

  test("uses the configured default Lifetime", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "arty-config-test-"));
    const sourceDirectory = await mkdtemp(join(tmpdir(), "arty-source-test-"));
    temporaryDirectories.push(configHome, sourceDirectory);
    const sourcePath = join(sourceDirectory, "prototype.html");
    await Bun.write(sourcePath, "<h1>Configured</h1>");
    await mkdir(join(configHome, "arty"), { recursive: true });
    await Bun.write(
      join(configHome, "arty", "config.json"),
      '{"defaultLifetime":"90m"}',
    );
    const requests: Array<number> = [];
    const provider: Provider = {
      publish: async (request) => {
        requests.push(request.lifetimeMilliseconds);
        return {
          accessUrl: `https://arty.example/${request.artifactId}/`,
          expiresAt: "2026-10-02T13:30:00.000Z",
        };
      },
    };

    const result = await invoke(
      ["publish", sourcePath],
      { XDG_CONFIG_HOME: configHome },
      { provider },
    );

    expect(result.exitCode).toBe(0);
    expect(requests).toEqual([90 * 60_000]);
  });

  test.each(["59s", "31d", "forever"])(
    "rejects an invalid publish Lifetime before calling the Provider: %s",
    async (lifetime) => {
      let providerCalls = 0;
      const provider: Provider = {
        publish: async () => {
          providerCalls += 1;
          throw new Error("Provider should not be called");
        },
      };

      const result = await invoke(
        ["publish", "--lifetime", lifetime, "prototype.html"],
        {},
        { provider },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "Lifetime must be between 1 minute and 30 days",
      );
      expect(providerCalls).toBe(0);
    },
  );

  test.each([
    ["no Source", []],
    ["missing Source", ["publish", "/missing/prototype.html"]],
    ["non-HTML Source", ["publish", import.meta.filename]],
    ["standard input", ["publish", "-"]],
    ["remote URL", ["publish", "https://example.com/prototype.html"]],
    ["multiple Sources", ["publish", "one.html", "two.html"]],
  ])("rejects %s before calling the Provider", async (_name, argv) => {
    let providerCalls = 0;
    const provider: Provider = {
      publish: async () => {
        providerCalls += 1;
        return {
          accessUrl: "https://arty.example/unexpected/",
          expiresAt: "2026-10-09T12:00:00.000Z",
        };
      },
    };

    const result = await invoke(argv, {}, { provider });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(providerCalls).toBe(0);
  });

  test("rejects a directory before calling the Provider", async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), "arty-site.html-"));
    temporaryDirectories.push(sourceDirectory);
    let providerCalls = 0;
    const provider: Provider = {
      publish: async () => {
        providerCalls += 1;
        return {
          accessUrl: "https://arty.example/unexpected/",
          expiresAt: "2026-10-09T12:00:00.000Z",
        };
      },
    };

    const result = await invoke(["publish", sourceDirectory], {}, { provider });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(providerCalls).toBe(0);
  });

  test("prints stable help to stdout", async () => {
    expect(await invoke(["--help"])).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `Usage: arty [options] [command] [path]\n\nPublish temporary static Artifacts from local Sources.\n\nArguments:\n  path                   local HTML Source to publish\n\nOptions:\n  -V, --version          output the version number\n  --lifetime <duration>  Lifetime for this Artifact\n  -h, --help             display help for command\n\nCommands:\n  publish <path>         Publish one local Source.\n  config                 Manage Arty settings.\n`,
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
