import { Command, CommanderError } from "commander";
import { Effect } from "effect";

import {
  createCloudflareProvisioner,
  InitializationError,
  initializeCloudflare,
  type CloudflareProvisioner,
  type InitializationIO,
} from "../cloudflare";
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
import { createConfiguredCloudflareProvider, type Provider } from "../provider";
import { publish, PublishError } from "../publish";

export interface CliOutput {
  readonly writeStderr: (text: string) => void;
  readonly writeStdout: (text: string) => void;
}

export interface CliRuntime extends ConfigEnvironment {
  readonly credentialStore: CredentialStore;
  readonly initialization: InitializationIO;
  readonly provider: Provider;
  readonly provisioner: CloudflareProvisioner;
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
    .command("init")
    .description("Initialize a Provider account.")
    .argument("<provider>")
    .option("--yes", "accept the resource and charge warning")
    .option("--worker-name <name>", "Worker name", "arty")
    .option("--bucket-name <name>", "R2 bucket name", "arty-content")
    .action(
      async (
        provider: string,
        options: {
          readonly bucketName: string;
          readonly workerName: string;
          readonly yes?: boolean;
        },
      ) => {
        if (provider !== "cloudflare") {
          throw new InitializationError(`Unknown Provider: ${provider}`);
        }
        await initializeCloudflare(
          {
            bucketName: options.bucketName,
            workerName: options.workerName,
            yes: options.yes ?? false,
          },
          output,
          runtime,
        );
      },
    );

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
  runtime?: CliRuntime,
): Promise<number> =>
  Effect.runPromise(
    Effect.promise(async () => {
      const productionRuntimeBase = {
        credentialStore: nativeCredentialStore,
        environment: process.env,
        initialization: createTerminalInitializationIO(),
        platform: process.platform,
        provisioner: createCloudflareProvisioner(),
        randomBytes: (length: number) =>
          crypto.getRandomValues(new Uint8Array(length)),
      };
      const activeRuntime: CliRuntime =
        runtime ??
        ({
          ...productionRuntimeBase,
          provider: createConfiguredCloudflareProvider(productionRuntimeBase),
        } satisfies CliRuntime);
      try {
        await createProgram(output, activeRuntime).parseAsync([...argv], {
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
          error instanceof InitializationError ||
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

const createTerminalInitializationIO = (): InitializationIO => ({
  confirm: async (message) => {
    const answer = await prompt(message, false);
    return /^(y|yes)$/i.test(answer.trim());
  },
  promptSecret: (message) => prompt(message, true),
  promptText: (message) => prompt(message, false),
});

const prompt = async (message: string, hidden: boolean): Promise<string> => {
  process.stderr.write(message);
  if (!process.stdin.isTTY) {
    throw new InitializationError(
      "Interactive input is unavailable. Set the required environment variables.",
    );
  }
  process.stdin.setRawMode(hidden);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("error", onError);
      process.stdin.pause();
      if (hidden) process.stdin.setRawMode(false);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (data: string) => {
      if (data === "\u0003") {
        cleanup();
        reject(new InitializationError("Initialization cancelled."));
        return;
      }
      if (data === "\r" || data === "\n") {
        cleanup();
        process.stderr.write("\n");
        resolve(value);
        return;
      }
      if (data === "\u007f") {
        value = value.slice(0, -1);
        return;
      }
      value += data;
    };
    process.stdin.on("data", onData);
    process.stdin.on("error", onError);
  });
};
