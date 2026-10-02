import { MANAGEMENT_PROTOCOL_VERSION } from "../src/shared/protocol";

interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface R2BucketBinding {
  delete(key: string): Promise<void>;
  get(key: string): Promise<R2ObjectBody | null>;
  list(options: {
    prefix: string;
  }): Promise<{ objects: ReadonlyArray<{ key: string }> }>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
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

interface CommitFilePayload {
  readonly contentType: string;
  readonly path: string;
  readonly size: number;
}

const artifactIdPattern = /^[A-Za-z0-9_-]{32}$/;
const managementPattern = /^\/_arty\/artifacts\/([^/]+)$/;
const stagingPattern = /^\/_arty\/artifacts\/([^/]+)\/files\/(.+)$/;
const commitPattern = /^\/_arty\/artifacts\/([^/]+)\/commit$/;
const minimumLifetimeMilliseconds = 60_000;
const maximumLifetimeMilliseconds = 30 * 86_400_000;

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

const authenticated = (
  request: Request,
  environment: WorkerEnvironment,
): boolean =>
  !request.headers.has("origin") &&
  request.headers.get("authorization") ===
    `Bearer ${environment.MANAGEMENT_SECRET}`;

const compatibleProtocol = (request: Request): boolean =>
  request.headers.get("x-arty-protocol-version") ===
  String(MANAGEMENT_PROTOCOL_VERSION);

const fetch = async (
  request: Request,
  environment: WorkerEnvironment,
): Promise<Response> => {
  const url = new URL(request.url);
  const stagingMatch = stagingPattern.exec(url.pathname);
  const commitMatch = commitPattern.exec(url.pathname);
  if (stagingMatch !== null || commitMatch !== null) {
    if (!authenticated(request, environment))
      return new Response(null, { status: 401 });
    if (!compatibleProtocol(request))
      return new Response(null, { status: 426 });
    const artifactId = (stagingMatch ?? commitMatch)?.[1] ?? "";
    if (!artifactIdPattern.test(artifactId)) return notFound();
    const manifestKey = `manifests/${artifactId}.json`;

    if (stagingMatch !== null) {
      if (request.method !== "PUT" || request.body === null) {
        return new Response(null, { status: 405 });
      }
      let path: string;
      try {
        path = decodeURIComponent(stagingMatch[2] ?? "");
      } catch {
        return new Response(null, { status: 400 });
      }
      const size = Number(request.headers.get("x-arty-file-size"));
      if (
        !validPath(path) ||
        !Number.isInteger(size) ||
        size < 0 ||
        size > 25 * 1024 * 1024
      ) {
        return new Response(null, { status: 400 });
      }
      if (await environment.ARTIFACTS.get(manifestKey)) {
        return new Response(null, { status: 409 });
      }
      let received = 0;
      const counted = request.body.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            received += chunk.byteLength;
            if (received > size) throw new Error("File exceeds declared size");
            controller.enqueue(chunk);
          },
        }),
      );
      try {
        await environment.ARTIFACTS.put(
          `staging/${artifactId}/${path}`,
          counted,
        );
      } catch {
        return new Response(null, { status: 400 });
      }
      if (received !== size) {
        await environment.ARTIFACTS.delete(`staging/${artifactId}/${path}`);
        return new Response(null, { status: 400 });
      }
      return new Response(null, { status: 204 });
    }

    if (request.method !== "POST") return new Response(null, { status: 405 });
    const existing = await environment.ARTIFACTS.get(manifestKey);
    if (existing !== null) {
      const manifest = JSON.parse(
        new TextDecoder().decode(await existing.arrayBuffer()),
      ) as ArtifactManifest;
      return Response.json(
        { createdAt: manifest.createdAt, expiresAt: manifest.expiresAt },
        { status: 200 },
      );
    }
    const lifetimeMilliseconds = Number(
      request.headers.get("x-arty-lifetime-ms"),
    );
    if (
      !Number.isInteger(lifetimeMilliseconds) ||
      lifetimeMilliseconds < minimumLifetimeMilliseconds ||
      lifetimeMilliseconds > maximumLifetimeMilliseconds
    ) {
      return new Response(null, { status: 400 });
    }
    let payload: { files?: ReadonlyArray<CommitFilePayload> };
    try {
      payload = (await request.json()) as typeof payload;
    } catch {
      return new Response(null, { status: 400 });
    }
    if (
      !Array.isArray(payload.files) ||
      payload.files.length === 0 ||
      payload.files.length > 5_000
    ) {
      return new Response(null, { status: 400 });
    }
    const paths = new Set<string>();
    let totalSize = 0;
    for (const file of payload.files) {
      if (
        typeof file?.path !== "string" ||
        typeof file?.contentType !== "string" ||
        !Number.isInteger(file?.size) ||
        file.size < 0 ||
        file.size > 25 * 1024 * 1024 ||
        !validPath(file.path) ||
        paths.has(file.path)
      ) {
        return new Response(null, { status: 400 });
      }
      totalSize += file.size;
      if (totalSize > 100 * 1024 * 1024)
        return new Response(null, { status: 400 });
      if (
        (await environment.ARTIFACTS.get(
          `staging/${artifactId}/${file.path}`,
        )) === null
      ) {
        return new Response(null, { status: 400 });
      }
      paths.add(file.path);
    }
    if (!paths.has("index.html")) return new Response(null, { status: 400 });
    const createdAtMilliseconds = (environment.now ?? Date.now)();
    const manifest: ArtifactManifest = {
      files: payload.files.map(({ contentType, path }) => ({
        contentType,
        path,
      })),
      createdAt: new Date(createdAtMilliseconds).toISOString(),
      expiresAt: new Date(
        createdAtMilliseconds + lifetimeMilliseconds,
      ).toISOString(),
      version: MANAGEMENT_PROTOCOL_VERSION,
    };
    const committed = await environment.ARTIFACTS.put(
      manifestKey,
      JSON.stringify(manifest),
      {
        onlyIf: { etagDoesNotMatch: "*" },
      },
    );
    if (committed === null) return new Response(null, { status: 409 });
    return Response.json(
      { createdAt: manifest.createdAt, expiresAt: manifest.expiresAt },
      { status: 201 },
    );
  }
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
        const priorDeletions = await environment.ARTIFACTS.list({
          prefix: `deletions/${artifactId}/`,
        });
        if (priorDeletions.objects.length > 0) {
          return (await environment.ARTIFACTS.get(receiptKey)) === null
            ? notFound()
            : new Response(null, { status: 204 });
        }
        const staged = await environment.ARTIFACTS.list({
          prefix: `staging/${artifactId}/`,
        });
        if (staged.objects.length > 0) {
          await environment.ARTIFACTS.put(receiptKey, "deleted", {
            onlyIf: { etagDoesNotMatch: "*" },
          });
          try {
            await Promise.all(
              staged.objects.map(({ key }) =>
                environment.ARTIFACTS.delete(key),
              ),
            );
          } catch {
            // Staged files are inaccessible and lifecycle cleanup is the backstop.
          }
          return new Response(null, { status: 204 });
        }
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

export default { fetch };
