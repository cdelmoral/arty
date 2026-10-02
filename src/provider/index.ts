import { managementSecretAccount } from "../cloudflare";
import type { ConfigEnvironment } from "../config";
import { getCloudflareConfig } from "../config";
import type { CredentialStore } from "../credentials";
import { resolveCredential } from "../credentials";
import { MANAGEMENT_PROTOCOL_VERSION } from "../shared/protocol";

export interface PublishFile {
  readonly content?: Uint8Array;
  readonly contentType: string;
  readonly open?: () => ReadableStream<Uint8Array>;
  readonly path: string;
  readonly size?: number;
  readonly verify?: () => Promise<void>;
}

export interface PublishRequest {
  readonly artifactId: string;
  readonly files: ReadonlyArray<PublishFile>;
  readonly lifetimeMilliseconds: number;
  readonly signal?: AbortSignal;
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

type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ProviderRetryOptions {
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const retryableStatus = (status: number): boolean =>
  status === 429 || [500, 502, 503, 504].includes(status);

export const createLocalWorkerProvider = (
  workerUrl: string | undefined,
  managementSecret: string | undefined,
  request: ProviderFetch = fetch,
  retryOptions: ProviderRetryOptions = {},
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
  publish: async ({ artifactId, files, lifetimeMilliseconds, signal }) => {
    if (workerUrl === undefined || managementSecret === undefined) {
      throw new ProviderError(
        "ARTY_WORKER_URL and ARTY_MANAGEMENT_SECRET are required to publish.",
      );
    }

    const baseUrl = workerUrl.replace(/\/$/, "");
    const commonHeaders = {
      authorization: `Bearer ${managementSecret}`,
      "x-arty-protocol-version": String(MANAGEMENT_PROTOCOL_VERSION),
    };
    const sleep =
      retryOptions.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
    const random = retryOptions.random ?? Math.random;
    const now = retryOptions.now ?? Date.now;
    const send = async (
      url: string,
      init: () => RequestInit,
    ): Promise<Response> => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        let response: Response;
        const requestInit = init();
        try {
          response = await request(url, requestInit);
        } catch (error) {
          lastError = error;
          if (requestInit.signal?.aborted) throw error;
          if (attempt === 3) break;
          await sleep(100 * 2 ** attempt * (0.5 + random()));
          continue;
        }
        if (!retryableStatus(response.status) || attempt === 3) return response;
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
        const date = retryAfter === null ? Number.NaN : Date.parse(retryAfter);
        const delay = Number.isFinite(seconds)
          ? seconds * 1_000
          : Number.isFinite(date)
            ? Math.max(0, date - now())
            : 100 * 2 ** attempt * (0.5 + random());
        await sleep(delay);
      }
      throw new ProviderError("Provider publish request failed.", {
        cause: lastError,
      });
    };
    const reject = async (response: Response): Promise<never> => {
      if (response.status === 426) {
        throw new ProviderError(
          "Management protocol mismatch. Run `arty init cloudflare`.",
        );
      }
      throw new ProviderError(
        `Provider rejected Artifact publish (${response.status}).`,
      );
    };

    try {
      for (const file of files) {
        const size = file.size ?? file.content?.byteLength;
        if (size === undefined)
          throw new ProviderError("Source file size is unavailable.");
        const response = await send(
          `${baseUrl}/_arty/artifacts/${artifactId}/files/${encodeURIComponent(file.path)}`,
          () => ({
            body:
              file.open?.() ??
              (file.content === undefined
                ? undefined
                : new Blob([Uint8Array.from(file.content)])),
            headers: {
              ...commonHeaders,
              "content-type": file.contentType,
              "x-arty-file-size": String(size),
            },
            method: "PUT",
            signal,
          }),
        );
        if (!response.ok) await reject(response);
        await file.verify?.();
      }

      const response = await send(
        `${baseUrl}/_arty/artifacts/${artifactId}/commit`,
        () => ({
          body: JSON.stringify({
            files: files.map(({ contentType, path, size, content }) => ({
              contentType,
              path,
              size: size ?? content?.byteLength,
            })),
          }),
          headers: {
            ...commonHeaders,
            "content-type": "application/json",
            "x-arty-lifetime-ms": String(lifetimeMilliseconds),
          },
          method: "POST",
          signal,
        }),
      );
      if (!response.ok) await reject(response);

      const result = (await response.json()) as {
        readonly expiresAt?: unknown;
      };
      if (typeof result.expiresAt !== "string") {
        throw new ProviderError(
          "Provider returned an invalid Artifact result.",
        );
      }

      return {
        accessUrl: `${baseUrl}/${artifactId}/`,
        expiresAt: result.expiresAt,
      };
    } catch (error) {
      try {
        await request(`${baseUrl}/_arty/artifacts/${artifactId}`, {
          headers: { ...commonHeaders, "x-arty-operation-id": artifactId },
          method: "DELETE",
        });
      } catch {
        // Cleanup is best effort; preserve the publish failure.
      }
      throw error;
    }
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
