export interface PublishRequest {
  readonly artifactId: string;
  readonly content: Uint8Array;
  readonly lifetimeMilliseconds: number;
}

export interface PublishResult {
  readonly accessUrl: string;
  readonly expiresAt: string;
}

export interface Provider {
  readonly publish: (request: PublishRequest) => Promise<PublishResult>;
}

export class ProviderError extends Error {
  readonly name = "ProviderError";
}

export const createLocalWorkerProvider = (
  workerUrl: string | undefined,
  managementSecret: string | undefined,
): Provider => ({
  publish: async ({ artifactId, content, lifetimeMilliseconds }) => {
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
