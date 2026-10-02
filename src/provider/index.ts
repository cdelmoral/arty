import type { ConfigEnvironment } from "../config";
import { getCloudflareConfig } from "../config";
import { managementSecretAccount } from "../cloudflare";
import type { CredentialStore } from "../credentials";
import { resolveCredential } from "../credentials";

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

type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const createLocalWorkerProvider = (
  workerUrl: string | undefined,
  managementSecret: string | undefined,
  fetchImplementation: ProviderFetch = fetch,
): Provider => ({
  publish: async ({ artifactId, content }) => {
    if (workerUrl === undefined || managementSecret === undefined) {
      throw new ProviderError(
        "ARTY_WORKER_URL and ARTY_MANAGEMENT_SECRET are required to publish.",
      );
    }

    const baseUrl = workerUrl.replace(/\/$/, "");
    const response = await fetchImplementation(
      `${baseUrl}/_arty/artifacts/${artifactId}`,
      {
        body: Uint8Array.from(content).buffer,
        headers: {
          authorization: `Bearer ${managementSecret}`,
          "content-type": "text/html; charset=utf-8",
        },
        method: "PUT",
      },
    );
    if (!response.ok) {
      throw new ProviderError(
        `Provider rejected publication (${response.status}).`,
      );
    }

    return `${baseUrl}/${artifactId}/`;
  },
});

export const createConfiguredCloudflareProvider = (
  runtime: ConfigEnvironment & {
    readonly credentialStore: CredentialStore;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly fetch?: ProviderFetch;
  },
): Provider => ({
  publish: async (request) => {
    const config = await getCloudflareConfig(runtime);
    if (config === undefined) {
      throw new ProviderError("Run `arty init cloudflare` before publishing.");
    }
    const managementSecret = await resolveCredential(
      managementSecretAccount(config.accountId),
      "ARTY_MANAGEMENT_SECRET",
      { environment: runtime.environment, store: runtime.credentialStore },
    );
    return createLocalWorkerProvider(
      config.workerUrl,
      managementSecret,
      runtime.fetch,
    ).publish(request);
  },
});
