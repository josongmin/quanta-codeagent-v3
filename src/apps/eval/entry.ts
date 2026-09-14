#!/usr/bin/env bun

import { scrubUntrustedEgressRedirects } from "@/shared/egress-provenance-guard"
import { envFileSourceOf, loadEnvFiles } from "@/shared/env-files"
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
// SEC-1 — quarantine dotenv-sourced API egress-redirect keys (thin entrypoint: no
// warn to avoid cold-loading the logger graph; the scrub itself is the guard).
scrubUntrustedEgressRedirects(process.env, envFileSourceOf)

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
