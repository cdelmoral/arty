import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setCloudflareConfig } from "../../src/config";
import type { CredentialStore } from "../../src/credentials";
import {
  createConfiguredCloudflareProvider,
  createLocalWorkerProvider,
  ProviderError,
} from "../../src/provider";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("configured Cloudflare Provider", () => {
  test("publishes with the management secret and never sends the API token", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "arty-provider-test-"));
    temporaryDirectories.push(configHome);
    const runtime: {
      credentialStore: CredentialStore;
      environment: Readonly<Record<string, string | undefined>>;
      fetch: (
        input: string | URL | Request,
        init?: RequestInit,
      ) => Promise<Response>;
      platform: "linux";
    } = {
      credentialStore: {
        delete: async () => {},
        get: async (account: string) =>
          account.endsWith(":management-secret")
            ? "management-secret"
            : "cloudflare-api-token",
        set: async () => {},
      } satisfies CredentialStore,
      environment: { XDG_CONFIG_HOME: configHome },
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.url).toStartWith(
          "https://arty.publisher.workers.dev/_arty/artifacts/________________________________",
        );
        expect(request.headers.get("authorization")).toBe(
          "Bearer management-secret",
        );
        expect(request.headers.get("authorization")).not.toContain(
          "cloudflare-api-token",
        );
        expect(request.headers.get("x-arty-protocol-version")).toBe("1");
        return request.url.endsWith("/commit")
          ? Response.json(
              { expiresAt: "2026-10-09T12:00:00.000Z" },
              { status: 201 },
            )
          : new Response(null, { status: 204 });
      },
      platform: "linux",
    };
    await setCloudflareConfig(runtime, {
      accountId: "account-123",
      bucketName: "arty-content",
      protocolVersion: 1,
      workerName: "arty",
      workerUrl: "https://arty.publisher.workers.dev",
    });

    const accessUrl = await createConfiguredCloudflareProvider(runtime).publish(
      {
        artifactId: "________________________________",
        files: [
          {
            content: new TextEncoder().encode("<h1>Remote</h1>"),
            contentType: "text/html; charset=utf-8",
            path: "index.html",
          },
        ],
        lifetimeMilliseconds: 604_800_000,
      },
    );

    expect(accessUrl).toEqual({
      accessUrl:
        "https://arty.publisher.workers.dev/________________________________/",
      expiresAt: "2026-10-09T12:00:00.000Z",
    });
  });
});

describe("Publish resilience", () => {
  const publishRequest = {
    artifactId: "________________________________",
    files: [
      {
        content: new TextEncoder().encode("artifact"),
        contentType: "text/html; charset=utf-8",
        path: "index.html",
      },
    ],
    lifetimeMilliseconds: 60_000,
  };

  test("honors Retry-After and reuses the Artifact ID after a transient response", async () => {
    const urls: Array<string> = [];
    const delays: Array<number> = [];
    let stagingAttempts = 0;
    const provider = createLocalWorkerProvider(
      "https://arty.example",
      "secret",
      async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/commit")) {
          return Response.json({ expiresAt: "2026-10-02T12:01:00.000Z" });
        }
        stagingAttempts += 1;
        return stagingAttempts === 1
          ? new Response(null, { headers: { "retry-after": "2" }, status: 429 })
          : new Response(null, { status: 204 });
      },
      { random: () => 0, sleep: async (delay) => void delays.push(delay) },
    );

    await provider.publish(publishRequest);

    expect(delays).toEqual([2_000]);
    expect(urls).toEqual([
      "https://arty.example/_arty/artifacts/________________________________/files/index.html",
      "https://arty.example/_arty/artifacts/________________________________/files/index.html",
      "https://arty.example/_arty/artifacts/________________________________/commit",
    ]);
  });

  test("does not retry authentication failures and attempts staged cleanup", async () => {
    const methods: Array<string | undefined> = [];
    const provider = createLocalWorkerProvider(
      "https://arty.example",
      "secret",
      async (_input, init) => {
        methods.push(init?.method);
        return new Response(null, { status: 401 });
      },
      { sleep: async () => {} },
    );

    await expect(provider.publish(publishRequest)).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(methods).toEqual(["PUT", "DELETE"]);
  });

  test("directs the Publisher to reinitialize on protocol mismatch", async () => {
    const provider = createLocalWorkerProvider(
      "https://arty.example",
      "secret",
      async (_input, init) =>
        new Response(null, { status: init?.method === "DELETE" ? 204 : 426 }),
    );

    await expect(provider.publish(publishRequest)).rejects.toThrow(
      "Run `arty init cloudflare`",
    );
  });

  test("reconciles a commit whose successful response was lost", async () => {
    let commits = 0;
    const provider = createLocalWorkerProvider(
      "https://arty.example",
      "secret",
      async (input) => {
        if (!String(input).endsWith("/commit")) {
          return new Response(null, { status: 204 });
        }
        commits += 1;
        if (commits === 1) throw new TypeError("connection closed");
        return Response.json(
          { expiresAt: "2026-10-02T12:01:00.000Z" },
          { status: 200 },
        );
      },
      { random: () => 0, sleep: async () => {} },
    );

    const result = await provider.publish(publishRequest);

    expect(commits).toBe(2);
    expect(result.accessUrl).toBe(
      "https://arty.example/________________________________/",
    );
  });

  test("fails and cleans up when a Source changes after streaming", async () => {
    const methods: Array<string | undefined> = [];
    const provider = createLocalWorkerProvider(
      "https://arty.example",
      "secret",
      async (_input, init) => {
        methods.push(init?.method);
        return new Response(null, { status: 204 });
      },
    );

    await expect(
      provider.publish({
        ...publishRequest,
        files: [
          {
            ...publishRequest.files[0]!,
            verify: async () => {
              throw new Error("Source changed while publishing");
            },
          },
        ],
      }),
    ).rejects.toThrow("Source changed while publishing");
    expect(methods).toEqual(["PUT", "DELETE"]);
  });
});
