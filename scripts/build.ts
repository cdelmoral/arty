import type { BunPlugin } from "bun";

const nativeModules = {
  "darwin-arm64": "@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node",
  "darwin-x64": "@napi-rs/keyring-darwin-x64/keyring.darwin-x64.node",
  "linux-arm64":
    "@napi-rs/keyring-linux-arm64-gnu/keyring.linux-arm64-gnu.node",
  "linux-x64": "@napi-rs/keyring-linux-x64-gnu/keyring.linux-x64-gnu.node",
} as const;

const target = `${process.platform}-${process.arch}`;
const nativeModule = nativeModules[target as keyof typeof nativeModules];

if (nativeModule === undefined) {
  throw new Error(`Unsupported Arty build target: ${target}`);
}

const nativeKeyringPlugin: BunPlugin = {
  name: "native-keyring",
  setup(build) {
    build.onResolve({ filter: /^@napi-rs\/keyring$/ }, () => ({
      path: Bun.resolveSync(nativeModule, process.cwd()),
    }));
  },
};

const result = await Bun.build({
  compile: { outfile: "dist/arty" },
  entrypoints: ["src/cli/main.ts"],
  minify: true,
  plugins: [nativeKeyringPlugin],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
}
