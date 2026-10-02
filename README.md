# Arty

Arty is a CLI for publishing a local static Source as a temporary Artifact in a Publisher-owned Cloudflare account.

Artifacts expire after seven days by default. Publishers can configure another default or pass `--lifetime` when publishing, from `1m` through `30d`. Expiry stops later remote access, but it cannot erase copies that a Viewer downloaded before expiry.

## Install

Arty supports macOS 13 or newer and glibc Linux on x64 and arm64. Install the signed release through Homebrew:

```sh
brew install cdelmoral/tap/arty
```

Release archives and their `SHA256SUMS` file are also available from [GitHub Releases](https://github.com/cdelmoral/arty/releases). Arty is not distributed through npm, a shell installer, Windows, or musl Linux packages.

Arty needs a Cloudflare account with an existing `workers.dev` subdomain, or permission to create one, plus an account-scoped API token with Workers Scripts Write and Workers R2 Storage Write. Cloudflare resources and Cloudflare charges belong to the Publisher.

Initialize the Provider, then publish a Source:

```sh
arty init cloudflare
arty ./site
```

An Access URL is a bearer capability. Anyone who has it can fetch the Artifact until deletion or expiry. The shared browser origin means Artifacts in one account are not security boundaries, so publish only trusted Sources. Arty does not collect telemetry or check for updates.

## Source development

Run the CLI from a checkout:

```sh
bun install
bun run src/cli/main.ts --help
bun run src/cli/main.ts --version
```

Build a standalone host executable with `bun run build`.

## Design

The product behavior is defined in [spec #1](https://github.com/cdelmoral/arty/issues/1). Project terminology is recorded in [GLOSSARY.md](GLOSSARY.md), and accepted architecture decisions are in [docs/adr](docs/adr).

## Development

Run all local checks with:

```sh
bun run check
```

Arty uses Bun and TypeScript for the CLI, Worker, shared management protocol, and tests. Commander parses CLI arguments. Effect runs CLI workflows.

## License

[MIT](LICENSE)
