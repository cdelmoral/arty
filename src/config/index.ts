import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LIFETIME = "7d";

export class ConfigError extends Error {
  readonly name = "ConfigError";
}

export interface ConfigEnvironment {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
}

export interface CloudflareConfig {
  readonly accountId: string;
  readonly bucketName: string;
  readonly protocolVersion: number;
  readonly workerName: string;
  readonly workerUrl: string;
}

interface ConfigFile {
  readonly cloudflare?: CloudflareConfig;
  readonly defaultLifetime?: string;
}

const durationInMilliseconds = (value: string): number | undefined => {
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (match === null) return undefined;

  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : 86_400_000;

  return amount * multiplier;
};

export const lifetimeInMilliseconds = (value: string): number => {
  validateLifetime(value);
  return durationInMilliseconds(value) as number;
};

export const validateLifetime = (value: string): string => {
  const milliseconds = durationInMilliseconds(value);
  if (
    milliseconds === undefined ||
    milliseconds < 60_000 ||
    milliseconds > 30 * 86_400_000
  ) {
    throw new ConfigError(
      "Lifetime must be between 1 minute and 30 days (for example: 90m or 7d).",
    );
  }

  return value;
};

const configDirectory = ({
  environment,
  platform,
}: ConfigEnvironment): string => {
  if (platform === "darwin") {
    return join(
      environment.HOME ?? homedir(),
      "Library",
      "Application Support",
      "arty",
    );
  }

  if (platform === "win32") {
    return join(environment.APPDATA ?? homedir(), "arty");
  }

  return join(
    environment.XDG_CONFIG_HOME ??
      join(environment.HOME ?? homedir(), ".config"),
    "arty",
  );
};

const configPath = (runtime: ConfigEnvironment): string =>
  join(configDirectory(runtime), "config.json");

const readConfig = async (runtime: ConfigEnvironment): Promise<ConfigFile> => {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(configPath(runtime), "utf8"),
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new ConfigError("Arty configuration is invalid.");
    }

    const config = parsed as {
      cloudflare?: unknown;
      defaultLifetime?: unknown;
    };
    const defaultLifetime = config.defaultLifetime;
    if (defaultLifetime !== undefined && typeof defaultLifetime !== "string") {
      throw new ConfigError("Arty configuration is invalid.");
    }

    const cloudflare = config.cloudflare;
    if (cloudflare !== undefined && !isCloudflareConfig(cloudflare)) {
      throw new ConfigError("Arty configuration is invalid.");
    }

    return { cloudflare, defaultLifetime };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("Arty configuration could not be read.");
  }
};

const isCloudflareConfig = (value: unknown): value is CloudflareConfig =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as CloudflareConfig).accountId === "string" &&
  typeof (value as CloudflareConfig).bucketName === "string" &&
  typeof (value as CloudflareConfig).protocolVersion === "number" &&
  typeof (value as CloudflareConfig).workerName === "string" &&
  typeof (value as CloudflareConfig).workerUrl === "string";

const writeConfig = async (
  runtime: ConfigEnvironment,
  config: ConfigFile,
): Promise<void> => {
  const directory = configDirectory(runtime);
  const path = configPath(runtime);
  const temporaryPath = `${path}.${process.pid}.tmp`;

  try {
    await mkdir(directory, { mode: 0o700, recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch {
    throw new ConfigError("Arty configuration could not be written.");
  }
};

export const getCloudflareConfig = async (
  runtime: ConfigEnvironment,
): Promise<CloudflareConfig | undefined> =>
  (await readConfig(runtime)).cloudflare;

export const setCloudflareConfig = async (
  runtime: ConfigEnvironment,
  cloudflare: CloudflareConfig,
): Promise<void> =>
  writeConfig(runtime, { ...(await readConfig(runtime)), cloudflare });

export const getDefaultLifetime = async (
  runtime: ConfigEnvironment,
): Promise<string> => {
  const value = (await readConfig(runtime)).defaultLifetime ?? DEFAULT_LIFETIME;
  return validateLifetime(value);
};

export const setDefaultLifetime = async (
  runtime: ConfigEnvironment,
  value: string,
): Promise<void> => {
  const defaultLifetime = validateLifetime(value);
  await writeConfig(runtime, {
    ...(await readConfig(runtime)),
    defaultLifetime,
  });
};
