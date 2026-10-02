import { MANAGEMENT_PROTOCOL_VERSION } from "../src/shared/protocol";

interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface R2BucketBinding {
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
  readonly now?: () => number;
}

interface ArtifactManifest {
  readonly contentType: "text/html; charset=utf-8";
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly path: "index.html";
  readonly version: number;
}

const artifactIdPattern = /^[A-Za-z0-9_-]{32}$/;
const managementPattern = /^\/_arty\/artifacts\/([^/]+)$/;
const minimumLifetimeMilliseconds = 60_000;
const maximumLifetimeMilliseconds = 30 * 86_400_000;

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
      request.method !== "PUT" ||
      request.headers.get("authorization") !==
        `Bearer ${environment.MANAGEMENT_SECRET}`
    ) {
      return new Response(null, { status: 401 });
    }

    const artifactId = managementMatch[1] ?? "";
    if (!artifactIdPattern.test(artifactId)) return notFound();
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
    const content = await request.arrayBuffer();
    const staged = await environment.ARTIFACTS.put(
      `staging/${artifactId}/index.html`,
      content,
      { onlyIf: { etagDoesNotMatch: "*" } },
    );
    if (staged === null) return new Response(null, { status: 409 });
    const createdAtMilliseconds = (environment.now ?? Date.now)();
    const manifest: ArtifactManifest = {
      contentType: "text/html; charset=utf-8",
      createdAt: new Date(createdAtMilliseconds).toISOString(),
      expiresAt: new Date(
        createdAtMilliseconds + lifetimeMilliseconds,
      ).toISOString(),
      path: "index.html",
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
  if ((environment.now ?? Date.now)() >= Date.parse(manifest.expiresAt)) {
    return notFound();
  }
  if (request.method !== "GET") {
    return new Response(null, { status: 405 });
  }
  const source = await environment.ARTIFACTS.get(
    `staging/${artifactId}/${manifest.path}`,
  );
  if (source === null) return notFound();
  return new Response(await source.arrayBuffer(), {
    headers: {
      "cache-control": "private, no-cache",
      "content-type": manifest.contentType,
    },
  });
};

export default { fetch };
