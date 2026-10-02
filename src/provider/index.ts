export interface PublishFile {
  readonly content: Uint8Array;
  readonly contentType: string;
  readonly path: string;
}

export interface PublishRequest {
  readonly artifactId: string;
  readonly files: ReadonlyArray<PublishFile>;
}

export interface Provider {
  readonly publish: (request: PublishRequest) => Promise<string>;
}

export class ProviderError extends Error {
  readonly name = "ProviderError";
}

export const createLocalWorkerProvider = (
  workerUrl: string | undefined,
  managementSecret: string | undefined,
): Provider => ({
  publish: async ({ artifactId, files }) => {
    if (workerUrl === undefined || managementSecret === undefined) {
      throw new ProviderError(
        "ARTY_WORKER_URL and ARTY_MANAGEMENT_SECRET are required to publish.",
      );
    }

    const baseUrl = workerUrl.replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/_arty/artifacts/${artifactId}`, {
      body: JSON.stringify({
        files: files.map((file) => ({
          content: Buffer.from(file.content).toString("base64"),
          contentType: file.contentType,
          path: file.path,
        })),
      }),
      headers: {
        authorization: `Bearer ${managementSecret}`,
        "content-type": "application/json",
      },
      method: "PUT",
    });
    if (!response.ok) {
      throw new ProviderError(
        `Provider rejected publication (${response.status}).`,
      );
    }

    return `${baseUrl}/${artifactId}/`;
  },
});
