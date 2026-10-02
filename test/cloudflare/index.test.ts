import { describe, expect, test } from "bun:test";

import {
  createCloudflareProvisioner,
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
          id: "arty-storage-backstop",
        },
      ],
    });
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
});
