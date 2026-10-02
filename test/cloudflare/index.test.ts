import { describe, expect, test } from "bun:test";

import {
  createCloudflareDestroyer,
  createCloudflareProvisioner,
  DestructionError,
  InitializationError,
} from "../../src/cloudflare";

const success = (result: unknown = {}): Response =>
  Response.json({ result, success: true });

describe("Cloudflare provisioning interface", () => {
  test("creates private Arty resources and configures production access", async () => {
    const requests: Array<Request> = [];
    const provisioner = createCloudflareProvisioner(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (
        request.method === "GET" &&
        (request.url.endsWith("/workers/scripts/arty") ||
          request.url.endsWith("/r2/buckets/arty-content"))
      ) {
        return new Response(null, { status: 404 });
      }
      return success();
    });

    const result = await provisioner.provision({
      accountId: "account-123",
      allowExisting: false,
      bucketName: "arty-content",
      createSubdomain: false,
      managementSecret: "management-secret",
      subdomain: "publisher",
      token: "api-token",
      workerName: "arty",
    });

    expect(result).toEqual({
      workerUrl: "https://arty.publisher.workers.dev",
    });
    expect(
      requests.every(
        (request) =>
          request.headers.get("authorization") === "Bearer api-token",
      ),
    ).toBe(true);
    expect(
      requests.some(
        (request) =>
          request.method === "POST" && request.url.endsWith("/r2/buckets"),
      ),
    ).toBe(true);
    expect(
      requests.some(
        (request) =>
          request.method === "PUT" &&
          request.url.endsWith("/workers/scripts/arty"),
      ),
    ).toBe(true);
    expect(
      requests.some(
        (request) =>
          request.method === "PUT" &&
          request.url.endsWith("/workers/scripts/arty/secrets"),
      ),
    ).toBe(true);
    expect(
      requests.some(
        (request) =>
          request.method === "PATCH" &&
          request.url.endsWith("/environments/production/settings"),
      ),
    ).toBe(true);
    expect(
      requests.some(
        (request) =>
          request.method === "PUT" &&
          request.url.endsWith("/workers/scripts/arty/schedules"),
      ),
    ).toBe(true);
    expect(
      requests.some(
        (request) =>
          request.method === "PUT" &&
          request.url.endsWith("/r2/buckets/arty-content/lifecycle"),
      ),
    ).toBe(true);
    const scheduleRequest = requests.find((request) =>
      request.url.endsWith("/workers/scripts/arty/schedules"),
    );
    expect(scheduleRequest).toBeDefined();
    expect(await scheduleRequest?.json()).toEqual({ cron: "0 0 * * *" });
    const lifecycleRequest = requests.find((request) =>
      request.url.endsWith("/r2/buckets/arty-content/lifecycle"),
    );
    expect(lifecycleRequest).toBeDefined();
    expect(await lifecycleRequest?.json()).toEqual({
      rules: [
        {
          conditions: { prefix: "" },
          deleteObjectsTransition: {
            condition: { maxAge: 35, type: "Age" },
          },
          enabled: true,
          id: "arty-owner-v1-storage-backstop",
        },
      ],
    });
    const workerRequest = requests.find(
      (request) =>
        request.method === "PUT" &&
        request.url.endsWith("/workers/scripts/arty"),
    );
    const workerForm = await workerRequest?.formData();
    const deployedWorker = await (workerForm?.get("index.js") as File).text();
    expect(deployedWorker).toContain("stagingPattern");
    expect(deployedWorker).toContain("commitPattern");
    expect(deployedWorker).toContain("x-arty-protocol-version");
  });

  test("does not claim a bucket after an ambiguous create response", async () => {
    let bucketExists = false;
    const mutations: Array<string> = [];
    const provisioner = createCloudflareProvisioner(async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "GET") mutations.push(request.url);
      if (request.url.endsWith("/workers/scripts/arty")) {
        return new Response(null, { status: 404 });
      }
      if (request.url.endsWith("/r2/buckets/arty-content")) {
        return new Response(null, { status: bucketExists ? 200 : 404 });
      }
      if (request.method === "POST" && request.url.endsWith("/r2/buckets")) {
        bucketExists = true;
        throw new TypeError("connection closed");
      }
      return success();
    });

    await expect(
      provisioner.provision({
        accountId: "account-123",
        allowExisting: false,
        bucketName: "arty-content",
        createSubdomain: false,
        managementSecret: "management-secret",
        subdomain: "publisher",
        token: "api-token",
        workerName: "arty",
      }),
    ).rejects.toThrow("could not prove ownership");
    expect(
      mutations.some((url) => url.endsWith("/arty-content/lifecycle")),
    ).toBe(false);
  });

  test("refuses resource collisions that local configuration does not own", async () => {
    const provisioner = createCloudflareProvisioner(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") return success();
      throw new Error("Cloudflare must not be changed");
    });

    await expect(
      provisioner.provision({
        accountId: "account-123",
        allowExisting: false,
        bucketName: "arty-content",
        createSubdomain: false,
        managementSecret: "management-secret",
        subdomain: "publisher",
        token: "api-token",
        workerName: "arty",
      }),
    ).rejects.toBeInstanceOf(InitializationError);
  });

  test("reconciles owned resources without creating duplicates and upgrades the Worker", async () => {
    const requests: Array<Request> = [];
    const provisioner = createCloudflareProvisioner(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (
        request.method === "GET" &&
        request.url.endsWith("/workers/scripts/arty")
      ) {
        return new Response('const ARTY_OWNER = "arty";');
      }
      if (
        request.method === "GET" &&
        request.url.endsWith("/r2/buckets/arty-content/lifecycle")
      ) {
        return success({
          rules: [{ id: "arty-owner-v1-storage-backstop" }],
        });
      }
      return success();
    });

    const result = await provisioner.provision({
      accountId: "account-123",
      allowExisting: true,
      bucketName: "arty-content",
      createSubdomain: false,
      managementSecret: "management-secret",
      subdomain: "publisher",
      token: "api-token",
      workerName: "arty",
    });

    expect(
      requests.some(
        (request) =>
          request.method === "POST" && request.url.endsWith("/r2/buckets"),
      ),
    ).toBe(false);
    expect(
      requests.some(
        (request) =>
          request.method === "PUT" &&
          request.url.endsWith("/workers/scripts/arty"),
      ),
    ).toBe(true);
    expect(result.warnings).toEqual([
      "The Arty Worker was upgraded to the current management protocol.",
    ]);
  });
});

describe("Cloudflare destruction interface", () => {
  test("stops access before removing every owned resource without changing the subdomain", async () => {
    const requests: Array<Request> = [];
    const destroyer = createCloudflareDestroyer(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (
        request.method === "GET" &&
        request.url.endsWith("/workers/scripts/arty")
      ) {
        return new Response('const ARTY_OWNER = "arty";');
      }
      if (
        request.method === "GET" &&
        request.url.endsWith("/r2/buckets/arty-content")
      ) {
        return success({ name: "arty-content" });
      }
      if (request.method === "GET" && request.url.endsWith("/lifecycle")) {
        return success({ rules: [{ id: "arty-owner-v1-storage-backstop" }] });
      }
      return success();
    });

    await destroyer.destroy({
      accountId: "account-123",
      bucketName: "arty-content",
      token: "api-token",
      workerName: "arty",
    });

    const mutations = requests.filter((request) => request.method !== "GET");
    expect(
      mutations.map((request) => [
        request.method,
        new URL(request.url).pathname,
      ]),
    ).toEqual([
      [
        "PATCH",
        "/client/v4/accounts/account-123/workers/services/arty/environments/production/settings",
      ],
      [
        "DELETE",
        "/client/v4/accounts/account-123/workers/scripts/arty/schedules",
      ],
      [
        "DELETE",
        "/client/v4/accounts/account-123/r2/buckets/arty-content/objects",
      ],
      [
        "DELETE",
        "/client/v4/accounts/account-123/r2/buckets/arty-content/lifecycle",
      ],
      ["DELETE", "/client/v4/accounts/account-123/r2/buckets/arty-content"],
      [
        "DELETE",
        "/client/v4/accounts/account-123/workers/scripts/arty/secrets/MANAGEMENT_SECRET",
      ],
      ["DELETE", "/client/v4/accounts/account-123/workers/scripts/arty"],
    ]);
    expect(
      requests.some((request) => request.url.endsWith("/workers/subdomain")),
    ).toBe(false);
  });

  test("refuses drift before changing any resource", async () => {
    let mutations = 0;
    const destroyer = createCloudflareDestroyer(async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "GET") mutations += 1;
      if (request.url.endsWith("/workers/scripts/arty")) {
        return new Response("unrelated worker");
      }
      if (request.url.endsWith("/r2/buckets/arty-content")) return success();
      if (request.url.endsWith("/lifecycle")) {
        return success({ rules: [{ id: "arty-owner-v1-storage-backstop" }] });
      }
      return success();
    });

    await expect(
      destroyer.destroy({
        accountId: "account-123",
        bucketName: "arty-content",
        token: "api-token",
        workerName: "arty",
      }),
    ).rejects.toBeInstanceOf(DestructionError);
    expect(mutations).toBe(0);
  });

  test("resumes when earlier destruction stages already removed resources", async () => {
    const mutations: Array<string> = [];
    const destroyer = createCloudflareDestroyer(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") return new Response(null, { status: 404 });
      mutations.push(request.url);
      return new Response(null, { status: 404 });
    });

    await destroyer.destroy({
      accountId: "account-123",
      bucketName: "arty-content",
      token: "api-token",
      workerName: "arty",
    });

    expect(mutations).toEqual([]);
  });

  test.each([
    "/environments/production/settings",
    "/schedules",
    "/objects",
    "/lifecycle",
    "/r2/buckets/arty-content",
    "/secrets/MANAGEMENT_SECRET",
    "/workers/scripts/arty",
  ])(
    "stops at a failed destruction stage and reports it: %s",
    async (failedPath) => {
      let failed = false;
      const destroyer = createCloudflareDestroyer(async (input, init) => {
        const request = new Request(input, init);
        if (
          request.method === "GET" &&
          request.url.endsWith("/workers/scripts/arty")
        ) {
          return new Response('const ARTY_OWNER = "arty";');
        }
        if (
          request.method === "GET" &&
          request.url.endsWith("/r2/buckets/arty-content")
        ) {
          return success();
        }
        if (request.method === "GET" && request.url.endsWith("/lifecycle")) {
          return success({ rules: [{ id: "arty-owner-v1-storage-backstop" }] });
        }
        if (!failed && request.url.endsWith(failedPath)) {
          failed = true;
          return new Response(null, { status: 503 });
        }
        return success();
      });

      await expect(
        destroyer.destroy({
          accountId: "account-123",
          bucketName: "arty-content",
          token: "api-token",
          workerName: "arty",
        }),
      ).rejects.toBeInstanceOf(DestructionError);
      expect(failed).toBe(true);
    },
  );
});
