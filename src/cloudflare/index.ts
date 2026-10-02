import type { CloudflareConfig, ConfigEnvironment } from "../config";
import { getCloudflareConfig, setCloudflareConfig } from "../config";
import type { CredentialStore } from "../credentials";
import { MANAGEMENT_PROTOCOL_VERSION } from "../shared/protocol";

export const cloudflareApiTokenAccount = (accountId: string): string =>
  `cloudflare:${accountId}:api-token`;
export const managementSecretAccount = (accountId: string): string =>
  `cloudflare:${accountId}:management-secret`;

export class InitializationError extends Error {
  readonly name = "InitializationError";
}

export interface InitializationIO {
  readonly confirm: (message: string) => Promise<boolean>;
  readonly promptSecret: (message: string) => Promise<string>;
  readonly promptText: (message: string) => Promise<string>;
}

export interface CloudflareProvisionRequest {
  readonly accountId: string;
  readonly allowExisting: boolean;
  readonly bucketName: string;
  readonly createSubdomain: boolean;
  readonly managementSecret: string;
  readonly subdomain: string;
  readonly token: string;
  readonly workerName: string;
}

export interface CloudflareProvisioner {
  readonly getWorkersSubdomain: (
    accountId: string,
    token: string,
  ) => Promise<string | undefined>;
  readonly provision: (
    request: CloudflareProvisionRequest,
  ) => Promise<{ readonly workerUrl: string }>;
}

export interface InitializeEnvironment extends ConfigEnvironment {
  readonly credentialStore: CredentialStore;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly initialization: InitializationIO;
  readonly provisioner: CloudflareProvisioner;
  readonly randomBytes: (length: number) => Uint8Array;
}

export interface InitializeOptions {
  readonly bucketName: string;
  readonly workerName: string;
  readonly yes: boolean;
}

const required = (value: string, label: string): string => {
  const trimmed = value.trim();
  if (trimmed === "") throw new InitializationError(`${label} is required.`);
  return trimmed;
};

export const initializeCloudflare = async (
  options: InitializeOptions,
  output: { readonly writeStderr: (text: string) => void },
  runtime: InitializeEnvironment,
): Promise<void> => {
  output.writeStderr(
    "Arty will create or update a Worker, a private R2 bucket, and future daily cleanup resources in your Cloudflare account. Cloudflare charges are your responsibility.\n",
  );
  if (
    !options.yes &&
    !(await runtime.initialization.confirm("Continue with initialization? "))
  ) {
    throw new InitializationError("Initialization cancelled.");
  }

  const accountId = required(
    runtime.environment.CLOUDFLARE_ACCOUNT_ID ??
      (await runtime.initialization.promptText("Cloudflare account ID: ")),
    "Cloudflare account ID",
  );
  if (runtime.environment.CLOUDFLARE_GLOBAL_API_KEY !== undefined) {
    throw new InitializationError(
      "The legacy Cloudflare Global API Key is not supported. Use an account-scoped API token.",
    );
  }
  const token = required(
    runtime.environment.CLOUDFLARE_API_TOKEN ??
      (await runtime.initialization.promptSecret("Cloudflare API token: ")),
    "Cloudflare API token",
  );

  const existingConfig = await getCloudflareConfig(runtime);
  const existingSubdomain = await runtime.provisioner.getWorkersSubdomain(
    accountId,
    token,
  );
  const createSubdomain = existingSubdomain === undefined;
  let subdomain: string;
  if (createSubdomain) {
    output.writeStderr(
      "This account has no workers.dev subdomain. Choosing one changes an account-wide setting; Arty will never rename an existing subdomain.\n",
    );
    subdomain = required(
      await runtime.initialization.promptText(
        "Choose a workers.dev subdomain: ",
      ),
      "workers.dev subdomain",
    );
  } else {
    subdomain = existingSubdomain;
  }

  const secretBytes = runtime.randomBytes(32);
  if (secretBytes.byteLength !== 32) {
    throw new InitializationError("Could not generate a management secret.");
  }
  const managementSecret = Buffer.from(secretBytes).toString("base64url");
  const allowExisting =
    existingConfig?.accountId === accountId &&
    existingConfig.workerName === options.workerName &&
    existingConfig.bucketName === options.bucketName;
  const { workerUrl } = await runtime.provisioner.provision({
    accountId,
    allowExisting,
    bucketName: options.bucketName,
    createSubdomain,
    managementSecret,
    subdomain,
    token,
    workerName: options.workerName,
  });

  const config: CloudflareConfig = {
    accountId,
    bucketName: options.bucketName,
    protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
    workerName: options.workerName,
    workerUrl,
  };
  try {
    await runtime.credentialStore.set(
      cloudflareApiTokenAccount(accountId),
      token,
    );
    await runtime.credentialStore.set(
      managementSecretAccount(accountId),
      managementSecret,
    );
    await setCloudflareConfig(runtime, config);
  } catch {
    throw new InitializationError(
      "Cloudflare resources were created, but local credentials or configuration could not be stored.",
    );
  }

  output.writeStderr(
    "Initialized Cloudflare. Sources may execute JavaScript, and all Artifacts in this account share a browser origin.\n",
  );
};

interface CloudflareEnvelope<T> {
  readonly errors?: ReadonlyArray<{ readonly message?: string }>;
  readonly result?: T;
  readonly success: boolean;
}

const workerSource = `const ARTY_OWNER = "arty";
const cleanup = async (scheduledTime, env) => {
  let cursor;
  const manifestKeys = [];
  for (let page = 0; page < 4; page += 1) {
    const listed = await env.ARTIFACTS.list({ prefix: "manifests/", limit: 4, ...(cursor === undefined ? {} : { cursor }) });
    manifestKeys.push(...listed.objects.map(object => object.key));
    if (!listed.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }
  let expired = 0;
  for (const manifestKey of manifestKeys) {
    if (expired >= 5) return;
    try {
      const stored = await env.ARTIFACTS.get(manifestKey);
      if (!stored) continue;
      const manifest = await stored.json();
      if (scheduledTime < Date.parse(manifest.expiresAt)) continue;
      const id = manifestKey.slice("manifests/".length, -".json".length);
      await env.ARTIFACTS.delete(manifestKey);
      expired += 1;
      const keys = manifest.files.map(file => "staging/" + id + "/" + file.path);
      for (let index = 0; index < keys.length; index += 1000) await env.ARTIFACTS.delete(keys.slice(index, index + 1000));
    } catch {}
  }
};
export default { async fetch(request, env) {
  const url = new URL(request.url);
  const management = /^\\/_arty\\/artifacts\\/([A-Za-z0-9_-]{32})$/.exec(url.pathname);
  if (management) {
    if (request.headers.has("origin")) return new Response(null, { status: 403 });
    if (request.method !== "PUT" || request.headers.get("authorization") !== "Bearer " + env.MANAGEMENT_SECRET) return new Response(null, { status: 401 });
    const id = management[1];
    const content = await request.arrayBuffer();
    const staged = await env.ARTIFACTS.put("staging/" + id + "/index.html", content, { onlyIf: { etagDoesNotMatch: "*" } });
    if (!staged) return new Response(null, { status: 409 });
    const manifest = JSON.stringify({ contentType: "text/html; charset=utf-8", path: "index.html", version: 1 });
    const committed = await env.ARTIFACTS.put("manifests/" + id + ".json", manifest, { onlyIf: { etagDoesNotMatch: "*" } });
    return new Response(null, { status: committed ? 201 : 409 });
  }
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const viewer = /^\\/([A-Za-z0-9_-]{32})\\/$/.exec(url.pathname);
  if (!viewer) return new Response("Not found", { status: 404 });
  const manifestObject = await env.ARTIFACTS.get("manifests/" + viewer[1] + ".json");
  if (!manifestObject) return new Response("Not found", { status: 404 });
  const manifest = await manifestObject.json();
  const source = await env.ARTIFACTS.get("staging/" + viewer[1] + "/" + manifest.path);
  return source ? new Response(source.body, { headers: { "content-type": manifest.contentType } }) : new Response("Not found", { status: 404 });
}, async scheduled(controller, env) { await cleanup(controller.scheduledTime, env); } };`;

type CloudflareFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const createCloudflareProvisioner = (
  fetchImplementation: CloudflareFetch = fetch,
): CloudflareProvisioner => {
  const request = async <T>(
    path: string,
    token: string,
    init?: RequestInit,
  ): Promise<T> => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init?.body !== undefined && !(init.body instanceof FormData)) {
      headers.set("content-type", "application/json");
    }
    const response = await fetchImplementation(
      `https://api.cloudflare.com/client/v4${path}`,
      { ...init, headers },
    );
    const body = (await response.json()) as CloudflareEnvelope<T>;
    if (!response.ok || !body.success || body.result === undefined) {
      throw new InitializationError(
        body.errors?.[0]?.message ??
          `Cloudflare request failed (${response.status}).`,
      );
    }
    return body.result;
  };

  const exists = async (path: string, token: string): Promise<boolean> => {
    const response = await fetchImplementation(
      `https://api.cloudflare.com/client/v4${path}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new InitializationError(
        `Cloudflare resource check failed (${response.status}).`,
      );
    }
    return true;
  };

  return {
    getWorkersSubdomain: async (accountId, token) => {
      const result = await request<{ readonly subdomain?: string }>(
        `/accounts/${encodeURIComponent(accountId)}/workers/subdomain`,
        token,
      );
      return result.subdomain || undefined;
    },
    provision: async (provisioning) => {
      const accountPath = `/accounts/${encodeURIComponent(provisioning.accountId)}`;
      const workerPath = `${accountPath}/workers/scripts/${encodeURIComponent(provisioning.workerName)}`;
      const bucketPath = `${accountPath}/r2/buckets/${encodeURIComponent(provisioning.bucketName)}`;
      const [workerExists, bucketExists] = await Promise.all([
        exists(workerPath, provisioning.token),
        exists(bucketPath, provisioning.token),
      ]);
      if ((workerExists || bucketExists) && !provisioning.allowExisting) {
        throw new InitializationError(
          "Cloudflare resource names already exist and Arty cannot prove it owns them. Choose alternate names.",
        );
      }
      if (!bucketExists) {
        await request(`${accountPath}/r2/buckets`, provisioning.token, {
          body: JSON.stringify({ name: provisioning.bucketName }),
          method: "POST",
        });
      }
      if (provisioning.createSubdomain) {
        await request(`${accountPath}/workers/subdomain`, provisioning.token, {
          body: JSON.stringify({ subdomain: provisioning.subdomain }),
          method: "PUT",
        });
      }
      const form = new FormData();
      form.set(
        "metadata",
        JSON.stringify({
          bindings: [
            {
              bucket_name: provisioning.bucketName,
              name: "ARTIFACTS",
              type: "r2_bucket",
            },
          ],
          compatibility_date: "2026-01-01",
          main_module: "index.js",
        }),
      );
      form.set(
        "index.js",
        new Blob([workerSource], { type: "application/javascript+module" }),
        "index.js",
      );
      await request(workerPath, provisioning.token, {
        body: form,
        method: "PUT",
      });
      await request(`${workerPath}/secrets`, provisioning.token, {
        body: JSON.stringify({
          name: "MANAGEMENT_SECRET",
          text: provisioning.managementSecret,
          type: "secret_text",
        }),
        method: "PUT",
      });
      await request(
        `${accountPath}/workers/services/${encodeURIComponent(provisioning.workerName)}/environments/production/settings`,
        provisioning.token,
        {
          body: JSON.stringify({ preview_urls: false, workers_dev: true }),
          method: "PATCH",
        },
      );
      await request(`${workerPath}/schedules`, provisioning.token, {
        body: JSON.stringify({ cron: "0 0 * * *" }),
        method: "PUT",
      });
      await request(`${bucketPath}/lifecycle`, provisioning.token, {
        body: JSON.stringify({
          rules: [
            {
              conditions: { prefix: "" },
              deleteObjectsTransition: {
                condition: { maxAge: 35, type: "Age" },
              },
              enabled: true,
              id: "arty-storage-backstop",
            },
          ],
        }),
        method: "PUT",
      });
      return {
        workerUrl: `https://${provisioning.workerName}.${provisioning.subdomain}.workers.dev`,
      };
    },
  };
};
