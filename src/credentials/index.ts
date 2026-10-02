import { AsyncEntry } from "@napi-rs/keyring";

const SERVICE_NAME = "arty";

export class CredentialError extends Error {
  readonly name = "CredentialError";
}

export interface CredentialStore {
  readonly delete: (account: string) => Promise<void>;
  readonly get: (account: string) => Promise<string | undefined>;
  readonly set: (account: string, value: string) => Promise<void>;
}

const entryFor = (account: string): AsyncEntry =>
  new AsyncEntry(SERVICE_NAME, account, {
    linux: { store: "secret-service" },
  });

export const nativeCredentialStore: CredentialStore = {
  delete: async (account) => {
    await entryFor(account).deletePassword();
  },
  get: (account) => entryFor(account).getPassword(),
  set: (account, value) => entryFor(account).setPassword(value),
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
  try {
    await store.set(account, value);
    const matched = (await store.get(account)) === value;
    await store.delete(account);
    if (!matched) {
      throw new Error("credential did not round-trip");
    }
  } catch {
    throw new CredentialError(
      "The operating system credential store is unavailable.",
    );
  }
};
