import { afterEach, describe, expect, test } from "bun:test";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
} from "node:fs/promises";
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
    const requests: Array<Parameters<Provider["publish"]>[0]> = [];
    const provider: Provider = {
      publish: async (request) => {
        requests.push(request);
        return `https://arty.example/${request.artifactId}/`;
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
      stderr: "Published Artifact.\n",
      stdout: "https://arty.example/________________________________/\n",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.artifactId).toBe("________________________________");
    expect(requests[0]?.files[0]?.path).toBe("index.html");
    expect(new TextDecoder().decode(requests[0]?.files[0]?.content)).toBe(
      "<h1>Hello from Arty</h1>",
    );
  });

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
        return "https://arty.example/unexpected/";
      },
    };

    const result = await invoke(argv, {}, { provider });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(providerCalls).toBe(0);
  });

  test("rejects more than 5,000 files before transfer", async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), "arty-site-"));
    temporaryDirectories.push(sourceDirectory);
    const indexPath = join(sourceDirectory, "index.html");
    await Bun.write(indexPath, "site");
    for (let index = 0; index < 5_000; index += 1) {
      await link(indexPath, join(sourceDirectory, `${index}.txt`));
    }
    let providerCalls = 0;

    const result = await invoke(
      ["publish", sourceDirectory],
      {},
      {
        provider: {
          publish: async () => {
            providerCalls += 1;
            return "https://arty.example/unexpected/";
          },
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("5,000 files");
    expect(providerCalls).toBe(0);
  });

  test("publishes every eligible file in a directory Source", async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), "arty-site-"));
    temporaryDirectories.push(sourceDirectory);
    await mkdir(join(sourceDirectory, "assets"));
    await mkdir(join(sourceDirectory, ".git"));
    await Bun.write(join(sourceDirectory, "index.html"), "<h1>Site</h1>");
    await Bun.write(join(sourceDirectory, "assets", "app.css"), "body {}\n");
    await Bun.write(
      join(sourceDirectory, "assets", "data.bin"),
      new Uint8Array([0, 255]),
    );
    await Bun.write(join(sourceDirectory, ".git", "config"), "secret");
    await Bun.write(join(sourceDirectory, ".env"), "secret");
    const requests: Array<Parameters<Provider["publish"]>[0]> = [];
    const provider: Provider = {
      publish: async (request) => {
        requests.push(request);
        return `https://arty.example/${request.artifactId}/`;
      },
    };

    const result = await invoke(["publish", sourceDirectory], {}, { provider });

    expect(result.exitCode).toBe(0);
    expect(
      requests[0]?.files.map(({ path, contentType, content }) => ({
        path,
        contentType,
        content: [...content],
      })),
    ).toEqual([
      {
        path: "assets/app.css",
        contentType: "text/css; charset=utf-8",
        content: [...new TextEncoder().encode("body {}\n")],
      },
      {
        path: "assets/data.bin",
        contentType: "application/octet-stream",
        content: [0, 255],
      },
      {
        path: "index.html",
        contentType: "text/html; charset=utf-8",
        content: [...new TextEncoder().encode("<h1>Site</h1>")],
      },
    ]);
  });

  test.each([
    [
      "missing root index",
      async (path: string) => Bun.write(join(path, "page.html"), "page"),
      "root index.html",
    ],
    [
      "a symlink",
      async (path: string) => {
        await Bun.write(join(path, "index.html"), "site");
        await symlink("index.html", join(path, "copy.html"));
      },
      "symbolic link",
    ],
    [
      "an unsupported entry",
      async (path: string) => {
        await Bun.write(join(path, "index.html"), "site");
        const process = Bun.spawn(["mkfifo", join(path, "updates")]);
        expect(await process.exited).toBe(0);
      },
      "unsupported entry",
    ],
    [
      "an oversized file",
      async (path: string) => {
        await Bun.write(join(path, "index.html"), "site");
        await Bun.write(join(path, "large.bin"), "");
        await truncate(join(path, "large.bin"), 25 * 1024 * 1024 + 1);
      },
      "25 MiB",
    ],
    [
      "an oversized total",
      async (path: string) => {
        await Bun.write(join(path, "index.html"), "site");
        for (let index = 0; index < 5; index += 1) {
          await Bun.write(join(path, `${index}.bin`), "");
          await truncate(join(path, `${index}.bin`), 21 * 1024 * 1024);
        }
      },
      "100 MiB",
    ],
  ])(
    "rejects a directory Source containing %s before transfer",
    async (_name, arrange, message) => {
      const sourceDirectory = await mkdtemp(join(tmpdir(), "arty-site-"));
      temporaryDirectories.push(sourceDirectory);
      await arrange(sourceDirectory);
      let providerCalls = 0;

      const result = await invoke(
        ["publish", sourceDirectory],
        {},
        {
          provider: {
            publish: async () => {
              providerCalls += 1;
              return "https://arty.example/unexpected/";
            },
          },
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stdout).toBe("");
      expect(providerCalls).toBe(0);
    },
  );

  test("prints stable help to stdout", async () => {
    expect(await invoke(["--help"])).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `Usage: arty [options] [command] [path]\n\nPublish temporary static Artifacts from local Sources.\n\nArguments:\n  path            local HTML Source to publish\n\nOptions:\n  -V, --version   output the version number\n  -h, --help      display help for command\n\nCommands:\n  publish <path>  Publish one local Source.\n  config          Manage Arty settings.\n`,
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
