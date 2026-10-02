#!/usr/bin/env bun

import { runCli } from "./app";

const exitCode = await runCli(Bun.argv.slice(2), {
  writeStderr: (text) => process.stderr.write(text),
  writeStdout: (text) => process.stdout.write(text),
});

process.exitCode = exitCode;
