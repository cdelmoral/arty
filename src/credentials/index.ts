import type { Entry as EntryType } from "@napi-rs/keyring";

const { Entry } = require("@napi-rs/keyring") as {
  readonly Entry: typeof EntryType;
};

const SERVICE_NAME = "arty";

export class CredentialError extends Error {
  readonly name = "CredentialError";
}

export interface CredentialStore {
  readonly delete: (account: string) => Promise<void>;
  readonly get: (account: string) => Promise<string | undefined>;
  readonly set: (account: string, value: string) => Promise<void>;
}

const entryFor = (account: string): EntryType =>
  new Entry(SERVICE_NAME, account, {
    linux: { store: "secret-service" },
  });

export const nativeCredentialStore: CredentialStore = {
  delete: async (account) => {
    entryFor(account).deletePassword();
  },
  get: async (account) => entryFor(account).getPassword() ?? undefined,
  set: async (account, value) => {
    entryFor(account).setPassword(value);
  },
};

export const resolveCredential = async (
  account: string,
  environmentVariable: string,
  options: {
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly store: CredentialStore;
  },
): Promise<string> => {
  const environmentValue = options.environment[environmentVariable];
  if (environmentValue !== undefined && environmentValue !== "") {
    return environmentValue;
  }

  try {
    const storedValue = await options.store.get(account);
    if (storedValue !== undefined) return storedValue;
  } catch {
    // The same guidance applies when the store is absent, locked, or unreadable.
  }

  throw new CredentialError(
    `Set ${environmentVariable} or make the operating system credential store available.`,
  );
};

export const smokeTestCredentialStore = async (
  store: CredentialStore,
  account: string,
  value: string,
): Promise<void> => {
  const failure = (operation: string, error: unknown): CredentialError => {
    const candidate = error as {
      readonly code?: unknown;
      readonly message?: unknown;
    };
    const code =
      typeof candidate?.code === "string" || typeof candidate?.code === "number"
        ? ` [${String(candidate.code)}]`
        : "";
    const message =
      typeof candidate?.message === "string"
        ? candidate.message
            .replaceAll(value, "<redacted>")
            .replace(/[\r\n]+/g, " ")
        : "unknown native error";
    return new CredentialError(
      `Credential smoke ${operation} failed${code}: ${message.slice(0, 500)}`,
    );
  };

  try {
    await store.set(account, value);
  } catch (error) {
    throw failure("set", error);
  }

  let stored: string | undefined;
  try {
    stored = await store.get(account);
  } catch (error) {
    throw failure("get", error);
  }

  try {
    await store.delete(account);
  } catch (error) {
    throw failure("delete", error);
  }

  if (stored !== value) {
    throw new CredentialError(
      "Credential smoke get failed: value did not round-trip.",
    );
  }
};
