import { MANAGEMENT_PROTOCOL_VERSION } from "../src/shared/protocol";

interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface R2BucketBinding {
  delete(key: string | ReadonlyArray<string>): Promise<void>;
  get(key: string): Promise<R2ObjectBody | null>;
  list(options: { cursor?: string; limit: number; prefix: string }): Promise<{
    readonly cursor?: string;
    readonly objects: ReadonlyArray<{ readonly key: string }>;
    readonly truncated: boolean;
  }>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { onlyIf?: { etagDoesNotMatch?: string } },
  ): Promise<unknown | null>;
}

export interface WorkerEnvironment {
  readonly ARTIFACTS: R2BucketBinding;
  readonly MANAGEMENT_SECRET: string;
  readonly now?: () => number;
}

interface ArtifactManifest {
  readonly files: ReadonlyArray<{
    readonly contentType: string;
    readonly path: string;
  }>;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly version: number;
}

interface PublishFilePayload {
  readonly content: string;
  readonly contentType: string;
  readonly path: string;
}

const artifactIdPattern = /^[A-Za-z0-9_-]{32}$/;
const managementPattern = /^\/_arty\/artifacts\/([^/]+)$/;
const minimumLifetimeMilliseconds = 60_000;
const maximumLifetimeMilliseconds = 30 * 86_400_000;
const cleanupPageSize = 4;
const maximumCleanupPages = 4;
const maximumExpiredArtifacts = 5;
const deleteBatchSize = 1_000;

const notFound = (): Response => new Response("Not found", { status: 404 });
const validPath = (path: string): boolean =>
  path !== "" &&
  !path.startsWith("/") &&
  !path.endsWith("/") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

const decodeBase64 = (value: string): Uint8Array => {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

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
        await Promise.all(
          manifest.files.map((file) =>
            environment.ARTIFACTS.delete(`staging/${artifactId}/${file.path}`),
          ),
        );
      } catch {
        // The missing manifest has already ended Viewer access.
      }
      return new Response(null, { status: 204 });
    }
    const lifetimeMilliseconds = Number(
      request.headers.get("x-arty-lifetime-ms"),
    );
    if (
      !Number.isInteger(lifetimeMilliseconds) ||
      lifetimeMilliseconds < minimumLifetimeMilliseconds ||
      lifetimeMilliseconds > maximumLifetimeMilliseconds
    ) {
      return new Response("Invalid Lifetime", { status: 400 });
    }
    let payload: { files?: ReadonlyArray<PublishFilePayload> };
    try {
      payload = (await request.json()) as typeof payload;
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!Array.isArray(payload.files) || payload.files.length > 5_000) {
      return new Response(null, { status: 400 });
    }
    const paths = new Set<string>();
    const files: Array<PublishFilePayload & { bytes: Uint8Array }> = [];
    let totalSize = 0;
    try {
      for (const file of payload.files) {
        if (
          typeof file?.content !== "string" ||
          typeof file?.contentType !== "string" ||
          typeof file?.path !== "string" ||
          !validPath(file.path) ||
          paths.has(file.path)
        ) {
          return new Response(null, { status: 400 });
        }
        const bytes = decodeBase64(file.content);
        if (bytes.byteLength > 25 * 1024 * 1024) {
          return new Response(null, { status: 400 });
        }
        totalSize += bytes.byteLength;
        if (totalSize > 100 * 1024 * 1024) {
          return new Response(null, { status: 400 });
        }
        paths.add(file.path);
        files.push({ ...file, bytes });
      }
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!paths.has("index.html")) return new Response(null, { status: 400 });

    for (const file of files) {
      const staged = await environment.ARTIFACTS.put(
        `staging/${artifactId}/${file.path}`,
        file.bytes,
        { onlyIf: { etagDoesNotMatch: "*" } },
      );
      if (staged === null) return new Response(null, { status: 409 });
    }
    const createdAtMilliseconds = (environment.now ?? Date.now)();
    const manifest: ArtifactManifest = {
      files: files.map(({ contentType, path }) => ({ contentType, path })),
      createdAt: new Date(createdAtMilliseconds).toISOString(),
      expiresAt: new Date(
        createdAtMilliseconds + lifetimeMilliseconds,
      ).toISOString(),
      version: MANAGEMENT_PROTOCOL_VERSION,
    };
    const committed = await environment.ARTIFACTS.put(
      `manifests/${artifactId}.json`,
      JSON.stringify(manifest),
      { onlyIf: { etagDoesNotMatch: "*" } },
    );
    if (committed === null) return new Response(null, { status: 409 });
    return Response.json(
      { createdAt: manifest.createdAt, expiresAt: manifest.expiresAt },
      { status: 201 },
    );
  }

  const viewerMatch = /^\/([^/]+)\/(.*)$/.exec(url.pathname);
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
  if ((environment.now ?? Date.now)() >= Date.parse(manifest.expiresAt)) {
    return notFound();
  }
  if (request.method !== "GET") {
    return new Response(null, { status: 405 });
  }
  let requestedPath: string;
  try {
    requestedPath = decodeURIComponent(viewerMatch?.[2] ?? "") || "index.html";
  } catch {
    return notFound();
  }
  const file = manifest.files.find(({ path }) => path === requestedPath);
  if (file === undefined) return notFound();
  const source = await environment.ARTIFACTS.get(
    `staging/${artifactId}/${file.path}`,
  );
  if (source === null) return notFound();
  return new Response(await source.arrayBuffer(), {
    headers: {
      "cache-control": "private, no-cache",
      "content-type": file.contentType,
    },
  });
};

const scheduled = async (
  controller: { readonly scheduledTime: number },
  environment: WorkerEnvironment,
): Promise<void> => {
  let cursor: string | undefined;
  const manifestKeys: Array<string> = [];

  for (let page = 0; page < maximumCleanupPages; page += 1) {
    const listed = await environment.ARTIFACTS.list({
      ...(cursor === undefined ? {} : { cursor }),
      limit: cleanupPageSize,
      prefix: "manifests/",
    });
    manifestKeys.push(...listed.objects.map(({ key }) => key));
    if (!listed.truncated || listed.cursor === undefined) break;
    cursor = listed.cursor;
  }

  let expiredArtifacts = 0;
  for (const manifestKey of manifestKeys) {
    if (expiredArtifacts >= maximumExpiredArtifacts) return;
    try {
      const manifestObject = await environment.ARTIFACTS.get(manifestKey);
      if (manifestObject === null) continue;
      const manifest = JSON.parse(
        new TextDecoder().decode(await manifestObject.arrayBuffer()),
      ) as ArtifactManifest;
      if (controller.scheduledTime < Date.parse(manifest.expiresAt)) continue;

      const artifactId = manifestKey.slice(
        "manifests/".length,
        -".json".length,
      );
      await environment.ARTIFACTS.delete(manifestKey);
      expiredArtifacts += 1;
      const fileKeys = manifest.files.map(
        (file) => `staging/${artifactId}/${file.path}`,
      );
      for (let index = 0; index < fileKeys.length; index += deleteBatchSize) {
        await environment.ARTIFACTS.delete(
          fileKeys.slice(index, index + deleteBatchSize),
        );
      }
    } catch {
      // A later run or the lifecycle rule handles data left by partial cleanup.
    }
  }
};

export default { fetch, scheduled };
