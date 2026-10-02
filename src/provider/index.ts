export interface PublishRequest {
  readonly artifactId: string;
  readonly content: Uint8Array;
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
  publish: async ({ artifactId, content }) => {
    if (workerUrl === undefined || managementSecret === undefined) {
      throw new ProviderError(
        "ARTY_WORKER_URL and ARTY_MANAGEMENT_SECRET are required to publish.",
      );
    }

    const baseUrl = workerUrl.replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/_arty/artifacts/${artifactId}`, {
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
