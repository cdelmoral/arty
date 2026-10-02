import { describe, expect, test } from "bun:test";

import {
  CredentialError,
  resolveCredential,
  smokeTestCredentialStore,
  type CredentialStore,
} from "../../src/credentials";

describe("credentials", () => {
  test("an environment credential overrides the stored credential", async () => {
    let storeWasRead = false;
    const store: CredentialStore = {
      delete: async () => {},
      get: async () => {
        storeWasRead = true;
        return "stored-token";
      },
      set: async () => {},
    };

    expect(
      await resolveCredential("publisher", "CLOUDFLARE_API_TOKEN", {
        environment: { CLOUDFLARE_API_TOKEN: "environment-token" },
        store,
      }),
    ).toBe("environment-token");
    expect(storeWasRead).toBe(false);
  });

  test("uses a credential from the operating system store", async () => {
    const store: CredentialStore = {
      delete: async () => {},
      get: async () => "stored-token",
      set: async () => {},
    };

    expect(
      await resolveCredential("publisher", "CLOUDFLARE_API_TOKEN", {
        environment: {},
        store,
      }),
    ).toBe("stored-token");
  });

  test("fails with guidance instead of falling back to plaintext", async () => {
    const store: CredentialStore = {
      delete: async () => {},
      get: async () => {
        throw new Error("no Secret Service");
      },
      set: async () => {},
    };

    await expect(
      resolveCredential("publisher", "CLOUDFLARE_API_TOKEN", {
        environment: {},
        store,
      }),
    ).rejects.toEqual(
      new CredentialError(
        "Set CLOUDFLARE_API_TOKEN or make the operating system credential store available.",
      ),
    );
  });

  test("reports the failed native smoke operation without exposing the credential", async () => {
    const credential = "credential-that-must-not-leak";
    const store: CredentialStore = {
      delete: async () => {},
      get: async () => undefined,
      set: async () => {
        throw Object.assign(
          new Error(`native failure while storing ${credential}`),
          { code: "NATIVE_FAILURE" },
        );
      },
    };

    let failure: unknown;
    try {
      await smokeTestCredentialStore(store, "publisher", credential);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CredentialError);
    expect((failure as Error).message).toContain(
      "Credential smoke set failed [NATIVE_FAILURE]",
    );
    expect((failure as Error).message).toContain("<redacted>");
    expect((failure as Error).message).not.toContain(credential);
  });

  test("identifies a round-trip mismatch as a get failure", async () => {
    const store: CredentialStore = {
      delete: async () => {},
      get: async () => "different-value",
      set: async () => {},
    };

    await expect(
      smokeTestCredentialStore(store, "publisher", "expected-value"),
    ).rejects.toThrow("Credential smoke get failed: value did not round-trip.");
  });
});
