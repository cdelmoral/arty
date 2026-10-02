export interface PublishFile {
  readonly content: Uint8Array;
  readonly contentType: string;
  readonly path: string;
}

export interface PublishRequest {
  readonly artifactId: string;
  readonly files: ReadonlyArray<PublishFile>;
  readonly lifetimeMilliseconds: number;
}

export interface PublishResult {
  readonly accessUrl: string;
  readonly expiresAt: string;
}

export interface DeleteRequest {
  readonly artifactId: string;
  readonly operationId: string;
}

export interface Provider {
  readonly delete: (request: DeleteRequest) => Promise<void>;
  readonly publish: (request: PublishRequest) => Promise<PublishResult>;
}

export class ProviderError extends Error {
  readonly name: string = "ProviderError";
}

export class ProviderNotFoundError extends ProviderError {
  readonly name = "ProviderNotFoundError";
}

const retryableStatus = (status: number): boolean =>
  status === 429 || [500, 502, 503, 504].includes(status);

export const createLocalWorkerProvider = (
  workerUrl: string | undefined,
  managementSecret: string | undefined,
  request: typeof fetch = fetch,
): Provider => ({
  delete: async ({ artifactId, operationId }) => {
    if (workerUrl === undefined || managementSecret === undefined) {
      throw new ProviderError(
        "ARTY_WORKER_URL and ARTY_MANAGEMENT_SECRET are required to delete an Artifact.",
      );
    }

    const baseUrl = workerUrl.replace(/\/$/, "");
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await request(`${baseUrl}/_arty/artifacts/${artifactId}`, {
          headers: {
            authorization: `Bearer ${managementSecret}`,
            "x-arty-operation-id": operationId,
          },
          method: "DELETE",
        });
      } catch (error) {
        if (attempt === 2) {
          throw new ProviderError("Provider deletion request failed.", {
            cause: error,
          });
        }
        continue;
      }
      if (!retryableStatus(response.status) || attempt === 2) break;
    }

    if (response?.status === 404) {
      throw new ProviderNotFoundError("Artifact was not found.");
    }
    if (response === undefined || !response.ok) {
      throw new ProviderError(
        `Provider rejected deletion (${response?.status ?? "network error"}).`,
      );
    }
  },
  publish: async ({ artifactId, files, lifetimeMilliseconds }) => {
    if (workerUrl === undefined || managementSecret === undefined) {
      throw new ProviderError(
        "ARTY_WORKER_URL and ARTY_MANAGEMENT_SECRET are required to publish.",
      );
    }

    const baseUrl = workerUrl.replace(/\/$/, "");
    const response = await request(`${baseUrl}/_arty/artifacts/${artifactId}`, {
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
        "x-arty-lifetime-ms": String(lifetimeMilliseconds),
      },
      method: "PUT",
    });
    if (!response.ok) {
      throw new ProviderError(
        `Provider rejected publication (${response.status}).`,
      );
    }

    const result = (await response.json()) as {
      readonly expiresAt?: unknown;
    };
    if (typeof result.expiresAt !== "string") {
      throw new ProviderError(
        "Provider returned an invalid publication result.",
      );
    }

    return {
      accessUrl: `${baseUrl}/${artifactId}/`,
      expiresAt: result.expiresAt,
    };
  },
});
