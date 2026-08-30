#!/usr/bin/env bun
/** Deterministically mirror the browser-safe readout protocol into the SPA. */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  DEFAULT_OBJECTIVE_CHECK_SUCCESS_EXIT_CODES,
  DEFAULT_OBJECTIVE_CHECK_TIMEOUT_MS,
} from "../src/objective/criteria/defaults"

const REPO_ROOT = join(import.meta.dir, "..")
export const READOUT_PROTOCOL_SOURCE_PATH = "src/protocol/readout/goal.ts"
export const GENERATED_READOUT_OUTPUT_PATH =
  "apps/web-frontend/src/types/protocol.readout.generated.ts"

const BANNER = `/**
 * GENERATED — DO NOT EDIT.
 * Source of truth: \`src/protocol/readout/goal.ts\`.
 * Regenerate with \`bun run build:protocol\`.
 */

`

const DEFAULTS = `
/** Generated from the canonical objective check defaults. */
export const DEFAULT_OBJECTIVE_CHECK_TIMEOUT_MS = ${DEFAULT_OBJECTIVE_CHECK_TIMEOUT_MS}
export const DEFAULT_OBJECTIVE_CHECK_SUCCESS_EXIT_CODES = ${JSON.stringify(DEFAULT_OBJECTIVE_CHECK_SUCCESS_EXIT_CODES)} as const
`

export const generateReadoutProtocolBundle = (): string =>
  BANNER + readFileSync(join(REPO_ROOT, READOUT_PROTOCOL_SOURCE_PATH), "utf8") + DEFAULTS

if (import.meta.main) {
  const generated = generateReadoutProtocolBundle()
  const output = join(REPO_ROOT, GENERATED_READOUT_OUTPUT_PATH)
  if (process.argv.includes("--check")) {
    const current = readFileSync(output, "utf8")
    if (current !== generated) {
      process.stderr.write(
        `${GENERATED_READOUT_OUTPUT_PATH} is stale. Run \`bun run build:protocol\`.\n`,
      )
      process.exit(1)
    }
  } else {
    writeFileSync(output, generated)
    process.stdout.write(`wrote ${GENERATED_READOUT_OUTPUT_PATH}\n`)
  }
}
