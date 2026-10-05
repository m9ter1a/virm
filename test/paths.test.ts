import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnvFiles } from "../src/paths.js";

const envFile = (content: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "virm-")), ".env");
  writeFileSync(file, content);
  return file;
};

describe(".env files", () => {
  it("loads secrets, but never over a variable already set in the environment", () => {
    const file = envFile("# a comment\nSECRET=from-file\nALREADY_SET=from-file\n");
    const env: Record<string, string | undefined> = { ALREADY_SET: "from-env" };
    expect(loadEnvFiles([file, join(tmpdir(), "missing.env")], { env, warn: () => {} })).toEqual([file]);
    expect(env).toEqual({ SECRET: "from-file", ALREADY_SET: "from-env" });
  });

  it("ignores VIRM_HOME in a .env and says so: it decides which .env is read", () => {
    const env: Record<string, string | undefined> = {};
    const warnings: string[] = [];
    loadEnvFiles([envFile("VIRM_HOME=D:\\elsewhere\nSECRET=x\n")], { env, warn: (m) => warnings.push(m) });
    expect(env).toEqual({ SECRET: "x" });
    expect(warnings).toEqual([expect.stringMatching(/^virm: VIRM_HOME in .* is ignored: .*Set it in your environment instead\.$/)]);
  });
});
