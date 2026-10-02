import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import { Effect } from "effect";

import type { Provider } from "../provider";

export class PublishError extends Error {
  readonly name = "PublishError";
}

export interface PublishEnvironment {
  readonly provider: Provider;
  readonly randomBytes: (length: number) => Uint8Array;
}

const artifactIdFrom = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

const readSource = async (path: string): Promise<Uint8Array> => {
  if (path === "-" || /^https?:\/\//i.test(path)) {
    throw new PublishError("Source must be a local HTML file.");
  }

  const extension = extname(path).toLowerCase();
  if (extension !== ".html" && extension !== ".htm") {
    throw new PublishError("Source must be a .html or .htm file.");
  }

  try {
    const sourceStat = await stat(path);
    if (!sourceStat.isFile()) {
      throw new PublishError("Source must be a local HTML file.");
    }
    return await readFile(path);
  } catch (error) {
    if (error instanceof PublishError) throw error;
    throw new PublishError(`Source does not exist: ${path}`);
  }
};

export const publish = (
  path: string,
  environment: PublishEnvironment,
): Effect.Effect<string, PublishError> =>
  Effect.tryPromise({
    try: async () => {
      const content = await readSource(path);
      const randomBytes = environment.randomBytes(24);
      if (randomBytes.byteLength !== 24) {
        throw new PublishError("Could not generate an Artifact ID.");
      }
      return environment.provider.publish({
        artifactId: artifactIdFrom(randomBytes),
        content,
      });
    },
    catch: (error) =>
      error instanceof PublishError
        ? error
        : new PublishError(
            error instanceof Error ? error.message : "Publication failed.",
          ),
  });
