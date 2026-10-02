import { MANAGEMENT_PROTOCOL_VERSION } from "../src/shared/protocol";

interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface R2BucketBinding {
  delete(key: string): Promise<void>;
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { onlyIf?: { etagDoesNotMatch?: string } },
  ): Promise<unknown | null>;
}

export interface WorkerEnvironment {
  readonly ARTIFACTS: R2BucketBinding;
  readonly MANAGEMENT_SECRET: string;
}

interface ArtifactManifest {
  readonly contentType: "text/html; charset=utf-8";
  readonly path: "index.html";
  readonly version: number;
}

const artifactIdPattern = /^[A-Za-z0-9_-]{32}$/;
const managementPattern = /^\/_arty\/artifacts\/([^/]+)$/;

const notFound = (): Response => new Response("Not found", { status: 404 });

const fetch = async (
  request: Request,
  environment: WorkerEnvironment,
): Promise<Response> => {
  const url = new URL(request.url);
  const managementMatch = managementPattern.exec(url.pathname);
  if (managementMatch !== null) {
    if (request.headers.has("origin"))
      return new Response(null, { status: 403 });
    if (
      !["DELETE", "PUT"].includes(request.method) ||
      request.headers.get("authorization") !==
        `Bearer ${environment.MANAGEMENT_SECRET}`
    ) {
      return new Response(null, { status: 401 });
    }

    const artifactId = managementMatch[1] ?? "";
    if (!artifactIdPattern.test(artifactId)) return notFound();
    if (request.method === "DELETE") {
      const operationId = request.headers.get("x-arty-operation-id") ?? "";
      if (!artifactIdPattern.test(operationId)) {
        return new Response(null, { status: 400 });
      }
      const receiptKey = `deletions/${artifactId}/${operationId}`;
      const manifestKey = `manifests/${artifactId}.json`;
      const manifestObject = await environment.ARTIFACTS.get(manifestKey);
      if (manifestObject === null) {
        return (await environment.ARTIFACTS.get(receiptKey)) === null
          ? notFound()
          : new Response(null, { status: 204 });
      }
      const manifest = JSON.parse(
        new TextDecoder().decode(await manifestObject.arrayBuffer()),
      ) as ArtifactManifest;
      await environment.ARTIFACTS.put(receiptKey, "deleted", {
        onlyIf: { etagDoesNotMatch: "*" },
      });
      await environment.ARTIFACTS.delete(manifestKey);
      try {
        await environment.ARTIFACTS.delete(
          `staging/${artifactId}/${manifest.path}`,
        );
      } catch {
        // The missing manifest has already ended Viewer access.
      }
      return new Response(null, { status: 204 });
    }
    const content = await request.arrayBuffer();
    const staged = await environment.ARTIFACTS.put(
      `staging/${artifactId}/index.html`,
      content,
      { onlyIf: { etagDoesNotMatch: "*" } },
    );
    if (staged === null) return new Response(null, { status: 409 });
    const manifest: ArtifactManifest = {
      contentType: "text/html; charset=utf-8",
      path: "index.html",
      version: MANAGEMENT_PROTOCOL_VERSION,
    };
    const committed = await environment.ARTIFACTS.put(
      `manifests/${artifactId}.json`,
      JSON.stringify(manifest),
      { onlyIf: { etagDoesNotMatch: "*" } },
    );
    return new Response(null, { status: committed === null ? 409 : 201 });
  }

  if (request.method !== "GET") {
    return new Response(null, { status: 405 });
  }
  const viewerMatch = /^\/([^/]+)\/$/.exec(url.pathname);
  const artifactId = viewerMatch?.[1];
  if (artifactId === undefined || !artifactIdPattern.test(artifactId)) {
    return notFound();
  }
  const manifestObject = await environment.ARTIFACTS.get(
    `manifests/${artifactId}.json`,
  );
  if (manifestObject === null) return notFound();
  const manifest = JSON.parse(
    new TextDecoder().decode(await manifestObject.arrayBuffer()),
  ) as ArtifactManifest;
  const source = await environment.ARTIFACTS.get(
    `staging/${artifactId}/${manifest.path}`,
  );
  if (source === null) return notFound();
  return new Response(await source.arrayBuffer(), {
    headers: { "content-type": manifest.contentType },
  });
};

export default { fetch };
