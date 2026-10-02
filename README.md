# Arty

Arty is a CLI for publishing a local static Source as a temporary Artifact in a Publisher-owned Cloudflare account.

Artifacts expire after seven days by default. Publishers can configure another default or pass `--lifetime` when publishing, from `1m` through `30d`. Expiry stops later remote access, but it cannot erase copies that a Viewer downloaded before expiry.

The project is under active development. The current executable provides the CLI foundation:

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
