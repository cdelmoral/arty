import { describe, expect, test } from "bun:test";

import worker, { type WorkerEnvironment } from "../../worker";

class MemoryR2 {
  readonly objects = new Map<string, Uint8Array>();

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
}

describe("Worker HTTP interface", () => {
  test("commits and serves only files declared by a directory Artifact", async () => {
    const bucket = new MemoryR2();
    const environment: WorkerEnvironment = {
      ARTIFACTS: bucket,
      MANAGEMENT_SECRET: "local-secret",
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
        },
        method: "PUT",
      }),
      environment,
    );

    expect(publishResponse.status).toBe(201);
    const viewerResponse = await worker.fetch(
      new Request(`https://arty.test/${artifactId}/`),
      environment,
    );
    expect(viewerResponse.status).toBe(200);
    expect(viewerResponse.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
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
          headers: { authorization: "Bearer local-secret" },
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
});
