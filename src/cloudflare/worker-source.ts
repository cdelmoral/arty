// Bun embeds the Worker implementation as text in the standalone CLI.
// @ts-expect-error TypeScript resolves the module shape instead of Bun's text import.
import rawWorkerModule from "../../worker/index.ts" with { type: "text" };

import { MANAGEMENT_PROTOCOL_VERSION } from "../shared/protocol";

const rawWorkerSource = rawWorkerModule as unknown as string;
const deployableSource = rawWorkerSource.replace(
  'import { MANAGEMENT_PROTOCOL_VERSION } from "../src/shared/protocol";',
  `const MANAGEMENT_PROTOCOL_VERSION = ${MANAGEMENT_PROTOCOL_VERSION};`,
);

export const workerSource = new Bun.Transpiler({
  loader: "ts",
}).transformSync(deployableSource);
