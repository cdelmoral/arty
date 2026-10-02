import { managementSecretAccount } from "../cloudflare";
import type { ConfigEnvironment } from "../config";
import { getCloudflareConfig } from "../config";
import type { CredentialStore } from "../credentials";
import { resolveCredential } from "../credentials";

export interface PublishFile {
  readonly content: Uint8Array;
  readonly contentType: string;
  readonly path: string;
}

export interface PublishRequest {
  readonly artifactId: string;
  readonly files: ReadonlyArray<PublishFile>;
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

type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const retryableStatus = (status: number): boolean =>
  status === 429 || [500, 502, 503, 504].includes(status);

export const createLocalWorkerProvider = (
  workerUrl: string | undefined,
  managementSecret: string | undefined,
  request: ProviderFetch = fetch,
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
  publish: async ({ artifactId, files }) => {
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

export const createConfiguredCloudflareProvider = (
  runtime: ConfigEnvironment & {
    readonly credentialStore: CredentialStore;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly fetch?: ProviderFetch;
  },
): Provider => {
  const configuredProvider = async (): Promise<Provider> => {
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
    );
  };

  return {
    delete: async (request) => (await configuredProvider()).delete(request),
    publish: async (request) => (await configuredProvider()).publish(request),
  };
};
