import { describe, expect, test } from "bun:test";

import {
  CredentialError,
  resolveCredential,
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
});
