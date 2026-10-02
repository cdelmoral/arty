import { Command, CommanderError } from "commander";
import { Effect } from "effect";

import {
  ConfigError,
  getDefaultLifetime,
  lifetimeInMilliseconds,
  setDefaultLifetime,
  type ConfigEnvironment,
} from "../config";
import {
  CredentialError,
  nativeCredentialStore,
  smokeTestCredentialStore,
  type CredentialStore,
} from "../credentials";
import { deleteArtifact, DeleteError } from "../delete";
import { createLocalWorkerProvider, type Provider } from "../provider";
import { publish, PublishError } from "../publish";

export interface CliOutput {
  readonly writeStderr: (text: string) => void;
  readonly writeStdout: (text: string) => void;
}

export interface CliRuntime extends ConfigEnvironment {
  readonly credentialStore: CredentialStore;
  readonly provider: Provider;
  readonly randomBytes: (length: number) => Uint8Array;
}

const createProgram = (output: CliOutput, runtime: CliRuntime) => {
  const program = new Command()
    .name("arty")
    .description("Publish temporary static Artifacts from local Sources.")
    .version("0.1.0")
    .configureOutput({
      writeErr: output.writeStderr,
      writeOut: output.writeStdout,
    })
    .exitOverride();

  const publishSource = async (path: string, lifetime?: string) => {
    const selectedLifetime = lifetime ?? (await getDefaultLifetime(runtime));
    const result = await Effect.runPromise(
      publish(path, lifetimeInMilliseconds(selectedLifetime), runtime),
    );
    output.writeStdout(`${result.accessUrl}\n`);
    output.writeStderr(`Published Artifact. Expires at ${result.expiresAt}.\n`);
  };

  program
    .option("--lifetime <duration>", "Lifetime for this Artifact")
    .argument("[path]", "local HTML Source to publish")
    .action(async (path?: string) => {
      if (path === undefined) {
        throw new PublishError("A Source path is required.");
      }
      await publishSource(path, program.opts<{ lifetime?: string }>().lifetime);
    });

  program
    .command("publish")
    .description("Publish one local Source.")
    .argument("<path>")
    .action(async (path: string) => {
      await publishSource(path, program.opts<{ lifetime?: string }>().lifetime);
    });

  program
    .command("delete")
    .description("Delete an Artifact before expiry.")
    .argument("<url-or-id>")
    .action(async (target: string) => {
      const artifactId = await Effect.runPromise(
        deleteArtifact(target, runtime),
      );
      output.writeStderr(`Deleted Artifact ${artifactId}.\n`);
    });

  const config = program.command("config").description("Manage Arty settings.");
  config
    .command("get")
    .argument("<setting>")
    .action(async (setting: string) => {
      if (setting !== "default-lifetime") {
        throw new ConfigError(`Unknown configuration setting: ${setting}`);
      }
      output.writeStdout(`${await getDefaultLifetime(runtime)}\n`);
    });
  config
    .command("set")
    .argument("<setting>")
    .argument("<value>")
    .action(async (setting: string, value: string) => {
      if (setting !== "default-lifetime") {
        throw new ConfigError(`Unknown configuration setting: ${setting}`);
      }
      await setDefaultLifetime(runtime, value);
    });

  program
    .command("_credential-smoke-test", { hidden: true })
    .argument("<account>")
    .action(async (account: string) => {
      const value = runtime.environment.ARTY_CREDENTIAL_SMOKE_VALUE;
      if (value === undefined || value === "") {
        throw new CredentialError(
          "ARTY_CREDENTIAL_SMOKE_VALUE is required for the credential smoke test.",
        );
      }
      await smokeTestCredentialStore(runtime.credentialStore, account, value);
    });

  return program;
};

export const runCli = (
  argv: ReadonlyArray<string>,
  output: CliOutput,
  runtime: CliRuntime = {
    credentialStore: nativeCredentialStore,
    environment: process.env,
    platform: process.platform,
    provider: createLocalWorkerProvider(
      process.env.ARTY_WORKER_URL,
      process.env.ARTY_MANAGEMENT_SECRET,
    ),
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
  },
): Promise<number> =>
  Effect.runPromise(
    Effect.promise(async () => {
      try {
        await createProgram(output, runtime).parseAsync([...argv], {
          from: "user",
        });
        return 0;
      } catch (error) {
        if (error instanceof CommanderError) {
          return error.exitCode;
        }

        if (
          error instanceof ConfigError ||
          error instanceof CredentialError ||
          error instanceof DeleteError ||
          error instanceof PublishError
        ) {
          output.writeStderr(`error: ${error.message}\n`);
          return 1;
        }

        throw error;
      }
    }),
  );
