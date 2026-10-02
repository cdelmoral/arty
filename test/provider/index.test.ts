import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setCloudflareConfig } from "../../src/config";
import type { CredentialStore } from "../../src/credentials";
import { createConfiguredCloudflareProvider } from "../../src/provider";

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
        expect(request.url).toBe(
          "https://arty.publisher.workers.dev/_arty/artifacts/________________________________",
        );
        expect(request.headers.get("authorization")).toBe(
          "Bearer management-secret",
        );
        expect(request.headers.get("authorization")).not.toContain(
          "cloudflare-api-token",
        );
        return new Response(null, { status: 201 });
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
      },
    );

    expect(accessUrl).toBe(
      "https://arty.publisher.workers.dev/________________________________/",
    );
  });
});
