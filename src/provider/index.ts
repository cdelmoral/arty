export interface PublishRequest {
  readonly artifactId: string;
  readonly content: Uint8Array;
}

export interface DeleteRequest {
  readonly artifactId: string;
  readonly operationId: string;
}

export interface Provider {
  readonly delete: (request: DeleteRequest) => Promise<void>;
  readonly publish: (request: PublishRequest) => Promise<string>;
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
  publish: async ({ artifactId, content }) => {
    if (workerUrl === undefined || managementSecret === undefined) {
      throw new ProviderError(
        "ARTY_WORKER_URL and ARTY_MANAGEMENT_SECRET are required to publish.",
      );
    }

    const baseUrl = workerUrl.replace(/\/$/, "");
    const response = await request(`${baseUrl}/_arty/artifacts/${artifactId}`, {
      body: Uint8Array.from(content).buffer,
      headers: {
        authorization: `Bearer ${managementSecret}`,
        "content-type": "text/html; charset=utf-8",
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
