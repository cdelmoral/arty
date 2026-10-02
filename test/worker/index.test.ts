import { describe, expect, test } from "bun:test";

import worker, { type WorkerEnvironment } from "../../worker";

class MemoryR2 {
  readonly objects = new Map<string, Uint8Array>();
  readonly operations: Array<string> = [];
  failFileDeletion = false;
  failNextFileDeletion = false;

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

  async delete(keyOrKeys: string | ReadonlyArray<string>) {
    const keys = typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys;
    this.operations.push(`delete:${keys.join(",")}`);
    if (
      (this.failFileDeletion || this.failNextFileDeletion) &&
      keys.some((key) => key.startsWith("staging/"))
    ) {
      this.failNextFileDeletion = false;
      throw new Error("physical cleanup failed");
    }
    for (const key of keys) this.objects.delete(key);
  }

  async list(options?: { cursor?: string; limit?: number; prefix?: string }) {
    this.operations.push(`list:${options?.cursor ?? ""}`);
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options?.prefix ?? ""))
      .sort();
    const start = Number(options?.cursor ?? 0);
    const end = Math.min(start + (options?.limit ?? 1_000), keys.length);
    return {
      cursor: end < keys.length ? String(end) : undefined,
      objects: keys.slice(start, end).map((key) => ({ key })),
      truncated: end < keys.length,
    };
  }
}

const storeArtifact = async (
  bucket: MemoryR2,
  artifactId: string,
  expiresAt: string,
  fileCount = 1,
) => {
  const files = Array.from({ length: fileCount }, (_, index) => ({
    contentType: "text/plain",
    path: `file-${index}.txt`,
  }));
  await bucket.put(
    `manifests/${artifactId}.json`,
    JSON.stringify({
      createdAt: "2026-10-01T00:00:00.000Z",
      expiresAt,
      files,
      version: 1,
    }),
  );
  for (const file of files) {
    await bucket.put(`staging/${artifactId}/${file.path}`, "content");
  }
};

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

describe("Worker scheduled interface", () => {
  test("removes expired manifests before their files and leaves live Artifacts unchanged", async () => {
    const bucket = new MemoryR2();
    const expiredId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const liveId = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    await storeArtifact(bucket, expiredId, "2026-10-02T11:59:59.999Z", 2);
    await storeArtifact(bucket, liveId, "2026-10-02T12:00:00.001Z");

    await worker.scheduled(
      { scheduledTime: Date.parse("2026-10-02T12:00:00.000Z") },
      { ARTIFACTS: bucket, MANAGEMENT_SECRET: "local-secret" },
    );

    expect(bucket.objects.has(`manifests/${expiredId}.json`)).toBe(false);
    expect(bucket.objects.has(`staging/${expiredId}/file-0.txt`)).toBe(false);
    expect(bucket.objects.has(`staging/${expiredId}/file-1.txt`)).toBe(false);
    expect(bucket.objects.has(`manifests/${liveId}.json`)).toBe(true);
    expect(bucket.objects.has(`staging/${liveId}/file-0.txt`)).toBe(true);
    expect(
      bucket.operations.indexOf(`delete:manifests/${expiredId}.json`),
    ).toBeLessThan(
      bucket.operations.indexOf(
        `delete:staging/${expiredId}/file-0.txt,staging/${expiredId}/file-1.txt`,
      ),
    );
  });

  test("paginates manifest scans but bounds one invocation", async () => {
    const bucket = new MemoryR2();
    for (let index = 0; index < 20; index += 1) {
      await storeArtifact(
        bucket,
        index.toString(36).padStart(32, "0"),
        "2026-10-03T00:00:00.000Z",
      );
    }

    await worker.scheduled(
      { scheduledTime: Date.parse("2026-10-02T12:00:00.000Z") },
      { ARTIFACTS: bucket, MANAGEMENT_SECRET: "local-secret" },
    );

    expect(
      bucket.operations.filter((operation) => operation.startsWith("list:")),
    ).toEqual(["list:", "list:4", "list:8", "list:12"]);
  });

  test("caps expired Artifact cleanup and batches file deletion", async () => {
    const bucket = new MemoryR2();
    for (let index = 0; index < 6; index += 1) {
      await storeArtifact(
        bucket,
        index.toString(36).padStart(32, "0"),
        "2026-10-01T00:00:00.000Z",
        1_001,
      );
    }

    await worker.scheduled(
      { scheduledTime: Date.parse("2026-10-02T12:00:00.000Z") },
      { ARTIFACTS: bucket, MANAGEMENT_SECRET: "local-secret" },
    );

    expect(
      [...bucket.objects.keys()].filter((key) => key.startsWith("manifests/")),
    ).toHaveLength(1);
    const fileDeletions = bucket.operations
      .filter((operation) => operation.startsWith("delete:staging/"))
      .map((operation) => operation.slice("delete:".length).split(",").length);
    expect(fileDeletions).toEqual([
      1_000, 1, 1_000, 1, 1_000, 1, 1_000, 1, 1_000, 1,
    ]);
  });

  test("keeps cleanup safe after a file deletion failure and on repeated runs", async () => {
    const bucket = new MemoryR2();
    const artifactId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    await storeArtifact(bucket, artifactId, "2026-10-01T00:00:00.000Z");
    bucket.failNextFileDeletion = true;

    await worker.scheduled(
      { scheduledTime: Date.parse("2026-10-02T12:00:00.000Z") },
      { ARTIFACTS: bucket, MANAGEMENT_SECRET: "local-secret" },
    );
    await worker.scheduled(
      { scheduledTime: Date.parse("2026-10-02T12:00:00.000Z") },
      { ARTIFACTS: bucket, MANAGEMENT_SECRET: "local-secret" },
    );

    expect(bucket.objects.has(`manifests/${artifactId}.json`)).toBe(false);
    expect(bucket.objects.has(`staging/${artifactId}/file-0.txt`)).toBe(true);
  });
});
