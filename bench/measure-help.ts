const [artyPath, baselinePath] = process.argv.slice(2);

if (artyPath === undefined || baselinePath === undefined) {
  throw new Error("Expected paths to the Arty and baseline executables.");
}

const measure = async (path: string) => {
  const startedAt = Bun.nanoseconds();
  const process = Bun.spawn([path, "--help"], {
    stderr: "ignore",
    stdout: "ignore",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${path} --help exited ${exitCode}`);
  return (Bun.nanoseconds() - startedAt) / 1_000_000;
};

const artySize = (await Bun.file(artyPath).stat()).size;
const baselineSize = (await Bun.file(baselinePath).stat()).size;
const artyMilliseconds = await measure(artyPath);
const baselineMilliseconds = await measure(baselinePath);

console.log("| Executable | Size (bytes) | Cold `--help` (ms) |");
console.log("| --- | ---: | ---: |");
console.log(`| Arty | ${artySize} | ${artyMilliseconds.toFixed(2)} |`);
console.log(
  `| Commander-only baseline | ${baselineSize} | ${baselineMilliseconds.toFixed(2)} |`,
);
