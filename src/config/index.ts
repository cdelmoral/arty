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

interface ConfigFile {
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

    const defaultLifetime = (parsed as { defaultLifetime?: unknown })
      .defaultLifetime;
    if (defaultLifetime !== undefined && typeof defaultLifetime !== "string") {
      throw new ConfigError("Arty configuration is invalid.");
    }

    return { defaultLifetime };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("Arty configuration could not be read.");
  }
};

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
  const directory = configDirectory(runtime);
  const path = configPath(runtime);
  const temporaryPath = `${path}.${process.pid}.tmp`;

  try {
    await mkdir(directory, { mode: 0o700, recursive: true });
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ defaultLifetime }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporaryPath, path);
  } catch {
    throw new ConfigError("Arty configuration could not be written.");
  }
};
