import { describe, expect, test } from "bun:test";

import worker, { type WorkerEnvironment } from "../../worker";

class MemoryR2 {
  readonly objects = new Map<string, Uint8Array>();
  failFileDeletion = false;

  async get(key: string) {
    const value = this.objects.get(key);
    return value === undefined
      ? null
      : { arrayBuffer: async () => Uint8Array.from(value).buffer };
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { onlyIf?: { etagDoesNotMatch?: string } },
  ) {
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) {
      return null;
    }
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.objects.set(key, bytes.slice());
    return { etag: "test-etag" };
  }

  async delete(key: string) {
    if (this.failFileDeletion && key.startsWith("staging/")) {
      throw new Error("physical cleanup failed");
    }
    this.objects.delete(key);
  }
}

describe("Worker HTTP interface", () => {
  test("commits and serves only files declared by a directory Artifact", async () => {
    const bucket = new MemoryR2();
    const environment: WorkerEnvironment = {
      ARTIFACTS: bucket,
      MANAGEMENT_SECRET: "local-secret",
      now: () => Date.parse("2026-10-02T12:00:00.000Z"),
    };
    const artifactId = "________________________________";

    const publishResponse = await worker.fetch(
      new Request(`https://arty.test/_arty/artifacts/${artifactId}`, {
        body: JSON.stringify({
          files: [
            {
              content: Buffer.from("body {}\n").toString("base64"),
              contentType: "text/css; charset=utf-8",
              path: "assets/app.css",
            },
            {
              content: Buffer.from("<h1>Hello from Arty</h1>").toString(
                "base64",
              ),
              contentType: "text/html; charset=utf-8",
              path: "index.html",
            },
          ],
        }),
        headers: {
          authorization: "Bearer local-secret",
          "content-type": "text/html; charset=utf-8",
          "x-arty-lifetime-ms": String(7 * 86_400_000),
        },
        method: "PUT",
      }),
      environment,
    );

    expect(publishResponse.status).toBe(201);
    expect(await publishResponse.json()).toEqual({
      createdAt: "2026-10-02T12:00:00.000Z",
      expiresAt: "2026-10-09T12:00:00.000Z",
    });
    const viewerResponse = await worker.fetch(
      new Request(`https://arty.test/${artifactId}/`),
      environment,
    );
    expect(viewerResponse.status).toBe(200);
    expect(viewerResponse.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(viewerResponse.headers.get("cache-control")).toBe(
      "private, no-cache",
    );
    expect(await viewerResponse.text()).toBe("<h1>Hello from Arty</h1>");

    const assetResponse = await worker.fetch(
      new Request(`https://arty.test/${artifactId}/assets/app.css`),
      environment,
    );
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("content-type")).toBe(
      "text/css; charset=utf-8",
    );
    expect(await assetResponse.text()).toBe("body {}\n");
    expect(
      (
        await worker.fetch(
          new Request(`https://arty.test/${artifactId}/missing.css`),
          environment,
        )
      ).status,
    ).toBe(404);
  });

  test("rejects unauthenticated and browser management requests", async () => {
    const environment: WorkerEnvironment = {
      ARTIFACTS: new MemoryR2(),
      MANAGEMENT_SECRET: "local-secret",
    };
    const url =
      "https://arty.test/_arty/artifacts/________________________________";

    expect(
      (await worker.fetch(new Request(url, { method: "PUT" }), environment))
        .status,
    ).toBe(401);
    expect(
      (
        await worker.fetch(
          new Request(url, {
            headers: {
              authorization: "Bearer local-secret",
              origin: "https://browser.example",
            },
            method: "PUT",
          }),
          environment,
        )
      ).status,
    ).toBe(403);
  });

  test("refuses to replace an existing Artifact", async () => {
    const environment: WorkerEnvironment = {
      ARTIFACTS: new MemoryR2(),
      MANAGEMENT_SECRET: "local-secret",
    };
    const artifactId = "________________________________";
    const url = `https://arty.test/_arty/artifacts/${artifactId}`;
    const publish = (body: string) =>
      worker.fetch(
        new Request(url, {
          body: JSON.stringify({
            files: [
              {
                content: Buffer.from(body).toString("base64"),
                contentType: "text/html; charset=utf-8",
                path: "index.html",
              },
            ],
          }),
          headers: {
            authorization: "Bearer local-secret",
            "x-arty-lifetime-ms": "60000",
          },
          method: "PUT",
        }),
        environment,
      );

    expect((await publish("original")).status).toBe(201);
    expect((await publish("replacement")).status).toBe(409);
    const viewerResponse = await worker.fetch(
      new Request(`https://arty.test/${artifactId}/`),
      environment,
    );
    expect(await viewerResponse.text()).toBe("original");
  });

  test.each([
    ["missing", undefined],
    ["below minimum", "59999"],
    ["above maximum", String(30 * 86_400_000 + 1)],
    ["not an integer", "60000.5"],
  ])(
    "rejects a %s Lifetime before reading the body",
    async (_name, lifetime) => {
      const environment: WorkerEnvironment = {
        ARTIFACTS: new MemoryR2(),
        MANAGEMENT_SECRET: "local-secret",
      };
      const headers: Record<string, string> = {
        authorization: "Bearer local-secret",
      };
      if (lifetime !== undefined) headers["x-arty-lifetime-ms"] = lifetime;

      const response = await worker.fetch(
        new Request(
          "https://arty.test/_arty/artifacts/________________________________",
          { body: "content", headers, method: "PUT" },
        ),
        environment,
      );

      expect(response.status).toBe(400);
    },
  );

  test.each([
    ["minimum", 60_000],
    ["maximum", 30 * 86_400_000],
  ])("accepts the %s Lifetime", async (_name, lifetime) => {
    const environment: WorkerEnvironment = {
      ARTIFACTS: new MemoryR2(),
      MANAGEMENT_SECRET: "local-secret",
      now: () => 0,
    };

    const response = await worker.fetch(
      new Request(
        "https://arty.test/_arty/artifacts/________________________________",
        {
          body: JSON.stringify({
            files: [
              {
                content: Buffer.from("content").toString("base64"),
                contentType: "text/html; charset=utf-8",
                path: "index.html",
              },
            ],
          }),
          headers: {
            authorization: "Bearer local-secret",
            "x-arty-lifetime-ms": String(lifetime),
          },
          method: "PUT",
        },
      ),
      environment,
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: new Date(lifetime).toISOString(),
    });
  });

  test("uses the Worker clock at commit and denies access at the instant of expiry", async () => {
    const bucket = new MemoryR2();
    let now = Date.parse("2026-10-02T12:00:00.000Z");
    const environment: WorkerEnvironment = {
      ARTIFACTS: bucket,
      MANAGEMENT_SECRET: "local-secret",
      now: () => now,
    };
    const artifactId = "________________________________";
    const publishResponse = await worker.fetch(
      new Request(`https://arty.test/_arty/artifacts/${artifactId}`, {
        body: JSON.stringify({
          files: [
            {
              content: Buffer.from("temporary").toString("base64"),
              contentType: "text/html; charset=utf-8",
              path: "index.html",
            },
          ],
        }),
        headers: {
          authorization: "Bearer local-secret",
          "x-arty-lifetime-ms": "60000",
        },
        method: "PUT",
      }),
      environment,
    );
    expect(await publishResponse.json()).toEqual({
      createdAt: "2026-10-02T12:00:00.000Z",
      expiresAt: "2026-10-02T12:01:00.000Z",
    });

    now += 59_999;
    expect(
      (
        await worker.fetch(
          new Request(`https://arty.test/${artifactId}/`),
          environment,
        )
      ).status,
    ).toBe(200);
    now += 1;
    const expired = await worker.fetch(
      new Request(`https://arty.test/${artifactId}/`),
      environment,
    );
    const unknown = await worker.fetch(
      new Request("https://arty.test/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/"),
      environment,
    );
    expect({ status: expired.status, body: await expired.text() }).toEqual({
      status: unknown.status,
      body: await unknown.text(),
    });
    const expiredPost = await worker.fetch(
      new Request(`https://arty.test/${artifactId}/`, { method: "POST" }),
      environment,
    );
    expect({
      status: expiredPost.status,
      body: await expiredPost.text(),
    }).toEqual({ status: unknown.status, body: "Not found" });
  });

  test("deletes the manifest before physical cleanup and makes retries idempotent", async () => {
    const bucket = new MemoryR2();
    const environment: WorkerEnvironment = {
      ARTIFACTS: bucket,
      MANAGEMENT_SECRET: "local-secret",
    };
    const artifactId = "________________________________";
    const managementUrl = `https://arty.test/_arty/artifacts/${artifactId}`;
    await worker.fetch(
      new Request(managementUrl, {
        body: JSON.stringify({
          files: [
            {
              content: Buffer.from("artifact").toString("base64"),
              contentType: "text/html; charset=utf-8",
              path: "index.html",
            },
          ],
        }),
        headers: {
          authorization: "Bearer local-secret",
          "x-arty-lifetime-ms": "60000",
        },
        method: "PUT",
      }),
      environment,
    );
    bucket.failFileDeletion = true;
    const remove = (operationId: string) =>
      worker.fetch(
        new Request(managementUrl, {
          headers: {
            authorization: "Bearer local-secret",
            "x-arty-operation-id": operationId,
          },
          method: "DELETE",
        }),
        environment,
      );

    expect((await remove("________________________________")).status).toBe(204);
    expect(
      (
        await worker.fetch(
          new Request(`https://arty.test/${artifactId}/`),
          environment,
        )
      ).status,
    ).toBe(404);
    expect((await remove("________________________________")).status).toBe(204);
    expect((await remove("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
  });
});
