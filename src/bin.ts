#!/usr/bin/env node
// The npm entry point. On Node 22, node:sqlite still prints
// "ExperimentalWarning: SQLite is an experimental feature" on every run; hide
// that one line, then load the CLI. The import has to be dynamic: a static
// one would load node:sqlite before the filter is in place.
const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning?.message;
  if (/SQLite is an experimental feature/i.test(String(text))) return;
  emit(warning, ...rest);
}) as typeof process.emitWarning;

await import("./cli.js");
