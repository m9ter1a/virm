// Where virm keeps its files: the user's data directory, not the current
// folder, so `virm start` works from anywhere. VIRM_HOME overrides it.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import envPaths from "env-paths";

export interface Paths {
  dir: string;
  config: string;
  trackers: string;
  db: string;
  env: string;
}

export function getPaths(): Paths {
  const dir = process.env.VIRM_HOME || envPaths("virm", { suffix: "" }).data;
  return {
    dir,
    config: join(dir, "config.json"),
    trackers: join(dir, "trackers.json"),
    db: join(dir, "virm.db"),
    env: join(dir, ".env"),
  };
}

/**
 * Secrets live in .env files: the one in the data directory, then one in the
 * current directory. A variable already set in the environment always wins.
 */
export function loadEnvFiles(files: string[]): string[] {
  const loaded: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const vars = parseEnv(readFileSync(file, "utf8"));
    for (const [k, v] of Object.entries(vars)) if (process.env[k] === undefined) process.env[k] = v;
    loaded.push(file);
  }
  return loaded;
}

export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();
