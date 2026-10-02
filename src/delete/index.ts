import { Effect } from "effect";

import type { Provider } from "../provider";

const artifactIdPattern = /^[A-Za-z0-9_-]{32}$/;

export class DeleteError extends Error {
  readonly name = "DeleteError";
}

export interface DeleteEnvironment {
  readonly provider: Provider;
  readonly randomBytes: (length: number) => Uint8Array;
}

const parseArtifactId = (target: string): string => {
  if (artifactIdPattern.test(target)) return target;

  try {
    const url = new URL(target);
    const match = /^\/([A-Za-z0-9_-]{32})\/$/.exec(url.pathname);
    if (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      match !== null
    ) {
      return match[1] ?? "";
    }
  } catch {
    // The shared validation error below covers malformed URLs.
  }

  throw new DeleteError("Invalid Artifact ID or Access URL.");
};

const operationIdFrom = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

export const deleteArtifact = (
  target: string,
  environment: DeleteEnvironment,
): Effect.Effect<string, DeleteError> =>
  Effect.tryPromise({
    try: async () => {
      const artifactId = parseArtifactId(target);
      const randomBytes = environment.randomBytes(24);
      if (randomBytes.byteLength !== 24) {
        throw new DeleteError("Could not generate a deletion operation ID.");
      }
      await environment.provider.delete({
        artifactId,
        operationId: operationIdFrom(randomBytes),
      });
      return artifactId;
    },
    catch: (error) =>
      error instanceof DeleteError
        ? error
        : new DeleteError(
            error instanceof Error ? error.message : "Deletion failed.",
          ),
  });
