import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const read = (path: string) => readFile(path, "utf8");

describe("release configuration", () => {
  test("gates a tagged release on all supported native targets", async () => {
    const workflow = await read(".github/workflows/release.yml");

    expect(workflow).toContain('tags: ["v*.*.*"]');
    for (const target of [
      "darwin-x64",
      "darwin-arm64",
      "linux-x64",
      "linux-arm64",
    ]) {
      expect(workflow).toContain(`target: ${target}`);
    }
    expect(workflow).not.toMatch(/target: (?:windows|linux-[^\n]*musl)/);
    expect(workflow).toContain("_credential-smoke-test");
    expect(workflow).toContain("bun run verify:archive");
  });

  test("provisions an isolated writable Keychain for macOS native smoke tests", async () => {
    for (const path of [
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
    ]) {
      const workflow = await read(path);
      expect(workflow).toContain('security create-keychain -p ""');
      expect(workflow).toContain('security unlock-keychain -p ""');
      expect(workflow).toContain("security list-keychains -d user -s");
      expect(workflow).toContain("security default-keychain -d user -s");
      expect(workflow).toContain("_credential-smoke-test");
      expect(workflow).not.toContain("openssl rand");
    }
  });

  test("publishes verified outputs without publishing an npm package", async () => {
    const workflow = await read(".github/workflows/release.yml");

    expect(workflow).toContain("actions/attest-build-provenance@v2");
    expect(workflow).toContain("softprops/action-gh-release@v2");
    expect(workflow).toContain("SHA256SUMS");
    expect(workflow).toContain("APPLE_NOTARY_KEY");
    expect(workflow).toContain("homebrew-tap");
    expect(workflow).not.toMatch(/npm publish|curl[^\n]*\|[^\n]*(?:sh|bash)/);
  });

  test("protects the live Cloudflare release gate", async () => {
    const workflow = await read(".github/workflows/release.yml");

    expect(workflow).toContain("environment: release-cloudflare");
    expect(workflow).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(workflow).toContain("CLOUDFLARE_API_TOKEN");
    expect(workflow).toContain("bun run smoke:cloudflare");
  });

  test("documents installation and the operating constraints", async () => {
    const readme = await read("README.md");

    expect(readme).toContain("brew install cdelmoral/tap/arty");
    expect(readme).toContain("macOS 13 or newer");
    expect(readme).toContain("glibc Linux");
    expect(readme).toContain("bearer capability");
    expect(readme).toContain("shared browser origin");
    expect(readme).toContain("Cloudflare charges");
    expect(readme).toContain("does not collect telemetry");
  });
});
