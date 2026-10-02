import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

import { Effect } from "effect";

import type { Provider, PublishFile } from "../provider";

export class PublishError extends Error {
  readonly name = "PublishError";
}

export interface PublishEnvironment {
  readonly provider: Provider;
  readonly randomBytes: (length: number) => Uint8Array;
}

const artifactIdFrom = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

const MAX_FILES = 5_000;
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_TOTAL_SIZE = 100 * 1024 * 1024;

const contentTypes: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
};

const contentTypeFor = (path: string): string =>
  contentTypes[extname(path).toLowerCase()] ?? "application/octet-stream";

interface SourceFile {
  readonly absolutePath: string;
  readonly device: number;
  readonly inode: number;
  readonly path: string;
  readonly size: number;
}

const inspectFile = async (
  absolutePath: string,
  path: string,
): Promise<SourceFile> => {
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink()) {
    throw new PublishError(`Source contains a symbolic link: ${path}`);
  }
  if (!metadata.isFile()) {
    throw new PublishError(`Source contains an unsupported entry: ${path}`);
  }
  if (metadata.size > MAX_FILE_SIZE) {
    throw new PublishError(`Source file exceeds 25 MiB: ${path}`);
  }
  return {
    absolutePath,
    device: metadata.dev,
    inode: metadata.ino,
    path,
    size: metadata.size,
  };
};

const readInspectedFile = async (file: SourceFile): Promise<PublishFile> => {
  const content = await readFile(file.absolutePath);
  const metadata = await lstat(file.absolutePath);
  if (
    !metadata.isFile() ||
    metadata.dev !== file.device ||
    metadata.ino !== file.inode ||
    metadata.size !== file.size ||
    content.byteLength !== file.size
  ) {
    throw new PublishError(`Source changed during validation: ${file.path}`);
  }
  return { content, contentType: contentTypeFor(file.path), path: file.path };
};

const readDirectory = async (
  root: string,
): Promise<ReadonlyArray<PublishFile>> => {
  const files: Array<SourceFile> = [];
  let totalSize = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = join(directory, entry.name);
      const path = relative(root, absolutePath).split(sep).join("/");
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new PublishError(`Source contains a symbolic link: ${path}`);
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      const file = await inspectFile(absolutePath, path);
      files.push(file);
      if (files.length > MAX_FILES) {
        throw new PublishError("Source contains more than 5,000 files.");
      }
      totalSize += file.size;
      if (totalSize > MAX_TOTAL_SIZE) {
        throw new PublishError("Source exceeds 100 MiB in total.");
      }
    }
  };

  await visit(root);
  if (!files.some((file) => file.path === "index.html")) {
    throw new PublishError("Directory Source must contain a root index.html.");
  }
  const contents: Array<PublishFile> = [];
  for (const file of files) contents.push(await readInspectedFile(file));
  return contents;
};

const readSource = async (
  path: string,
): Promise<ReadonlyArray<PublishFile>> => {
  if (path === "-" || /^https?:\/\//i.test(path)) {
    throw new PublishError("Source must be a local HTML file or directory.");
  }

  try {
    const sourceStat = await lstat(path);
    if (sourceStat.isSymbolicLink()) {
      throw new PublishError("Source must not be a symbolic link.");
    }
    if (sourceStat.isDirectory()) return await readDirectory(path);
    if (!sourceStat.isFile()) {
      throw new PublishError("Source must be a local HTML file or directory.");
    }
    const extension = extname(path).toLowerCase();
    if (extension !== ".html" && extension !== ".htm") {
      throw new PublishError("Source must be a .html or .htm file.");
    }
    const file = await inspectFile(path, "index.html");
    return [await readInspectedFile(file)];
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
      const files = await readSource(path);
      const randomBytes = environment.randomBytes(24);
      if (randomBytes.byteLength !== 24) {
        throw new PublishError("Could not generate an Artifact ID.");
      }
      return environment.provider.publish({
        artifactId: artifactIdFrom(randomBytes),
        files,
      });
    },
    catch: (error) =>
      error instanceof PublishError
        ? error
        : new PublishError(
            error instanceof Error ? error.message : "Publication failed.",
          ),
  });
