#!/usr/bin/env bun

import { loadEnvFiles } from "@/shared/env-files"
import { EVAL_HELP } from "./help"

/**
 * Thin eval process entrypoint.
 *
 * Help is a static contract and must not cold-load the provider, benchmark,
 * trajectory, and grounding graphs. Every executable command crosses one
 * lazy import into the application composition root, which retains env loading,
 * terminal binding, error reporting, and exit-code ownership.
 */
const argv = process.argv.slice(2)
const subcommand = argv[0]
loadEnvFiles([".env.dev", ".env.local", ".env"])

if (
  subcommand === undefined ||
  subcommand === "help" ||
  subcommand === "--help" ||
  subcommand === "-h"
) {
  process.stdout.write(`${EVAL_HELP}\n`)
  process.exit(0)
}

const { runEvalCliProcess } = await import("./index")
await runEvalCliProcess(argv)
