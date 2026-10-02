import { Command, CommanderError } from "commander";
import { Effect } from "effect";

export interface CliOutput {
  readonly writeStderr: (text: string) => void;
  readonly writeStdout: (text: string) => void;
}

const createProgram = (output: CliOutput) =>
  new Command()
    .name("arty")
    .description("Publish temporary static Artifacts from local Sources.")
    .version("0.1.0")
    .configureOutput({
      writeErr: output.writeStderr,
      writeOut: output.writeStdout,
    })
    .exitOverride();

export const runCli = (
  argv: ReadonlyArray<string>,
  output: CliOutput,
): Promise<number> =>
  Effect.runPromise(
    Effect.sync(() => {
      try {
        createProgram(output).parse([...argv], { from: "user" });
        return 0;
      } catch (error) {
        if (error instanceof CommanderError) {
          return error.exitCode;
        }

        throw error;
      }
    }),
  );
