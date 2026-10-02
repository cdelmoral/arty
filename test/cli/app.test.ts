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
import type {
  CloudflareProvisionRequest,
  CloudflareProvisioner,
} from "../../src/cloudflare";
import type { CredentialStore } from "../../src/credentials";
import {
  createLocalWorkerProvider,
  ProviderNotFoundError,
  type Provider,
} from "../../src/provider";

const temporaryDirectories: Array<string> = [];
const unusedCredentialStore: CredentialStore = {
  delete: async () => {},
  get: async () => undefined,
  set: async () => {},
};
const unusedProvider: Provider = {
  delete: async () => {
    throw new Error("Provider should not be called");
  },
  publish: async () => {
    throw new Error("Provider should not be called");
  },
};
const unusedProvisioner: CloudflareProvisioner = {
  getWorkersSubdomain: async () => {
    throw new Error("Cloudflare should not be called");
  },
  provision: async () => {
    throw new Error("Cloudflare should not be called");
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
    initialization: {
      confirm: async () => false,
      promptSecret: async () => "",
      promptText: async () => "",
    },
    platform: "linux",
    provisioner: unusedProvisioner,
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
      delete: unusedProvider.delete,
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
    expect(requests[0]?.files[0]?.path).toBe("index.html");
    expect(new TextDecoder().decode(requests[0]?.files[0]?.content)).toBe(
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
        delete: unusedProvider.delete,
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
      delete: unusedProvider.delete,
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
        delete: unusedProvider.delete,
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
      delete: unusedProvider.delete,
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

  test("reports an unknown or already deleted Artifact as not found", async () => {
    const provider: Provider = {
      delete: async () => {
        throw new ProviderNotFoundError("Artifact was not found.");
      },
      publish: unusedProvider.publish,
    };

    const result = await invoke(
      ["delete", "________________________________"],
      {},
      { provider },
    );

    expect(result).toEqual({
      exitCode: 1,
      stderr: "error: Artifact was not found.\n",
      stdout: "",
    });
  });

  test("retries transient deletion responses without exposing credentials", async () => {
    const secret = "do-not-print-me";
    const requests: Array<{ input: string; init: RequestInit | undefined }> =
      [];
    const request = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({ input: String(input), init });
      return new Response(null, { status: requests.length < 3 ? 503 : 204 });
    }) as typeof fetch;
    const provider = createLocalWorkerProvider(
      "https://arty.example/",
      secret,
      request,
    );

    const result = await invoke(
      ["delete", "________________________________"],
      {},
      {
        provider,
        randomBytes: () => new Uint8Array(24).fill(255),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(requests).toHaveLength(3);
    expect(requests.map(({ input }) => input)).toEqual(
      Array(3).fill(`https://arty.example/_arty/artifacts/${"_".repeat(32)}`),
    );
    expect(
      requests.map(({ init }) =>
        new Headers(init?.headers).get("authorization"),
      ),
    ).toEqual(Array(3).fill(`Bearer ${secret}`));
    expect(
      requests.map(({ init }) =>
        new Headers(init?.headers).get("x-arty-operation-id"),
      ),
    ).toEqual(Array(3).fill("_".repeat(32)));
    expect(result.stdout + result.stderr).not.toContain(secret);
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
          delete: unusedProvider.delete,
          publish: async () => {
            providerCalls += 1;
            return {
              accessUrl: "https://arty.example/unexpected/",
              expiresAt: "2026-10-09T12:00:00.000Z",
            };
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
      delete: unusedProvider.delete,
      publish: async (request) => {
        requests.push(request);
        return {
          accessUrl: `https://arty.example/${request.artifactId}/`,
          expiresAt: "2026-10-09T12:00:00.000Z",
        };
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
            delete: unusedProvider.delete,
            publish: async () => {
              providerCalls += 1;
              return {
                accessUrl: "https://arty.example/unexpected/",
                expiresAt: "2026-10-09T12:00:00.000Z",
              };
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
      stdout: `Usage: arty [options] [command] [path]\n\nPublish temporary static Artifacts from local Sources.\n\nArguments:\n  path                       local HTML Source to publish\n\nOptions:\n  -V, --version              output the version number\n  --lifetime <duration>      Lifetime for this Artifact\n  -h, --help                 display help for command\n\nCommands:\n  publish <path>             Publish one local Source.\n  init [options] <provider>  Initialize a Provider account.\n  delete <url-or-id>         Delete an Artifact before expiry.\n  config                     Manage Arty settings.\n`,
    });
  });

  test.each([
    ["Artifact ID", "________________________________"],
    ["Access URL", "https://arty.example/________________________________/"],
  ])("deletes an Artifact by %s", async (_name, target) => {
    const requests: Array<{ artifactId: string; operationId: string }> = [];
    const provider: Provider = {
      delete: async (request) => {
        requests.push(request);
      },
      publish: unusedProvider.publish,
    };

    const result = await invoke(
      ["delete", target],
      {},
      {
        provider,
        randomBytes: () => new Uint8Array(24).fill(255),
      },
    );

    expect(result).toEqual({
      exitCode: 0,
      stderr: `Deleted Artifact ${"_".repeat(32)}.\n`,
      stdout: "",
    });
    expect(requests).toEqual([
      {
        artifactId: "________________________________",
        operationId: "________________________________",
      },
    ]);
    expect(result.stderr).not.toContain("https://arty.example");
  });

  test.each([
    "short",
    "https://arty.example/not-an-artifact/",
    "https://arty.example/________________________________/extra",
    "ftp://arty.example/________________________________/",
  ])("rejects malformed deletion target %s", async (target) => {
    let providerCalls = 0;
    const provider: Provider = {
      delete: async () => {
        providerCalls += 1;
      },
      publish: unusedProvider.publish,
    };

    const result = await invoke(["delete", target], {}, { provider });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("error: Invalid Artifact ID or Access URL.\n");
    expect(providerCalls).toBe(0);
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

  test("initializes Cloudflare after informed automated consent", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "arty-init-test-"));
    temporaryDirectories.push(configHome);
    const credentials = new Map<string, string>();
    const credentialStore: CredentialStore = {
      delete: async (account) => {
        credentials.delete(account);
      },
      get: async (account) => credentials.get(account),
      set: async (account, value) => {
        credentials.set(account, value);
      },
    };
    const requests: Array<CloudflareProvisionRequest> = [];
    const provisioner: CloudflareProvisioner = {
      getWorkersSubdomain: async (accountId, token) => {
        expect(accountId).toBe("account-123");
        expect(token).toBe("cloudflare-secret-token");
        return "publisher";
      },
      provision: async (request) => {
        requests.push(request);
        return { workerUrl: "https://arty.publisher.workers.dev" };
      },
    };

    const result = await invoke(
      ["init", "cloudflare", "--yes"],
      {
        CLOUDFLARE_ACCOUNT_ID: "account-123",
        CLOUDFLARE_API_TOKEN: "cloudflare-secret-token",
        XDG_CONFIG_HOME: configHome,
      },
      {
        credentialStore,
        provisioner,
        randomBytes: () => new Uint8Array(32).fill(7),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("private R2 bucket");
    expect(result.stderr).toContain("Cloudflare charges");
    expect(result.stderr).toContain("Sources may execute JavaScript");
    expect(result.stderr).not.toContain("cloudflare-secret-token");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      accountId: "account-123",
      bucketName: "arty-content",
      subdomain: "publisher",
      token: "cloudflare-secret-token",
      workerName: "arty",
    });
    expect(requests[0]?.managementSecret).toHaveLength(43);
    expect(credentials.get("cloudflare:account-123:api-token")).toBe(
      "cloudflare-secret-token",
    );
    expect(credentials.get("cloudflare:account-123:management-secret")).toBe(
      requests[0]?.managementSecret,
    );
    expect(
      JSON.parse(
        await readFile(join(configHome, "arty", "config.json"), "utf8"),
      ),
    ).toEqual({
      cloudflare: {
        accountId: "account-123",
        bucketName: "arty-content",
        protocolVersion: 1,
        workerName: "arty",
        workerUrl: "https://arty.publisher.workers.dev",
      },
    });
  });

  test("asks for a missing workers.dev subdomain and explains its account scope", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "arty-init-test-"));
    temporaryDirectories.push(configHome);
    const prompts: Array<string> = [];
    const provisioner: CloudflareProvisioner = {
      getWorkersSubdomain: async () => undefined,
      provision: async (request) => ({
        workerUrl: `https://${request.workerName}.${request.subdomain}.workers.dev`,
      }),
    };

    const result = await invoke(
      ["init", "cloudflare", "--yes"],
      {
        CLOUDFLARE_ACCOUNT_ID: "account-123",
        CLOUDFLARE_API_TOKEN: "token",
        XDG_CONFIG_HOME: configHome,
      },
      {
        initialization: {
          confirm: async () => true,
          promptSecret: async () => "unused",
          promptText: async (message) => {
            prompts.push(message);
            return "new-publisher";
          },
        },
        provisioner,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("account-wide");
    expect(prompts).toEqual(["Choose a workers.dev subdomain: "]);
  });

  test("cancels before reading credentials or changing Cloudflare", async () => {
    let secretPrompts = 0;
    let cloudflareCalls = 0;

    const result = await invoke(
      ["init", "cloudflare"],
      {},
      {
        initialization: {
          confirm: async () => false,
          promptSecret: async () => {
            secretPrompts += 1;
            return "unused";
          },
          promptText: async () => "unused",
        },
        provisioner: {
          getWorkersSubdomain: async () => {
            cloudflareCalls += 1;
            return "unused";
          },
          provision: async () => {
            cloudflareCalls += 1;
            return { workerUrl: "https://unused.example" };
          },
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Cloudflare charges");
    expect(result.stderr).toContain("Initialization cancelled");
    expect(secretPrompts).toBe(0);
    expect(cloudflareCalls).toBe(0);
  });

  test("accepts a prompted token and alternate resource names", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "arty-init-test-"));
    temporaryDirectories.push(configHome);
    const requests: Array<CloudflareProvisionRequest> = [];

    const result = await invoke(
      [
        "init",
        "cloudflare",
        "--yes",
        "--worker-name",
        "review-worker",
        "--bucket-name",
        "review-content",
      ],
      {
        CLOUDFLARE_ACCOUNT_ID: "account-123",
        XDG_CONFIG_HOME: configHome,
      },
      {
        initialization: {
          confirm: async () => true,
          promptSecret: async (message) => {
            expect(message).toBe("Cloudflare API token: ");
            return "prompted-token";
          },
          promptText: async () => "unused",
        },
        provisioner: {
          getWorkersSubdomain: async () => "publisher",
          provision: async (request) => {
            requests.push(request);
            return {
              workerUrl: "https://review-worker.publisher.workers.dev",
            };
          },
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(requests[0]).toMatchObject({
      bucketName: "review-content",
      token: "prompted-token",
      workerName: "review-worker",
    });
    expect(result.stderr).not.toContain("prompted-token");
  });

  test("rejects a legacy Global API Key before calling Cloudflare", async () => {
    let cloudflareCalls = 0;
    const result = await invoke(
      ["init", "cloudflare", "--yes"],
      {
        CLOUDFLARE_ACCOUNT_ID: "account-123",
        CLOUDFLARE_API_TOKEN: "token",
        CLOUDFLARE_GLOBAL_API_KEY: "legacy-key",
      },
      {
        provisioner: {
          getWorkersSubdomain: async () => {
            cloudflareCalls += 1;
            return "publisher";
          },
          provision: async () => {
            cloudflareCalls += 1;
            return { workerUrl: "https://unused.example" };
          },
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Global API Key is not supported");
    expect(result.stderr).not.toContain("legacy-key");
    expect(cloudflareCalls).toBe(0);
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
