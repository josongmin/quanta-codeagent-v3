#!/usr/bin/env bun
/**
 * PMX-06 — the OPERATOR entry point for the staged campaign gates.
 *
 * A shim, deliberately: it binds real filesystem ports to
 * {@link runProMaxCampaignCli} and does nothing else, so the whole promotion
 * policy stays testable without this file.
 *
 * ```sh
 * bun tools/bench-promax/campaign-gates.ts preflight --record campaign-record.json
 * bun tools/bench-promax/campaign-gates.ts gate --gate gate1_pmx7_gold \
 *     --record campaign-record.json --evidence gate1-evidence.json --out gate1.result.json
 * ```
 *
 * ⚠️ It has NO process, Docker, AWS or network surface, and it cannot acquire
 * one: `CampaignCliPorts` is read-a-file / write-a-file / log-a-line. Running
 * this command cannot provision, pull, upload, or bill.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { runProMaxCampaignCli } from "@/apps/bench/promax/campaign"

if (import.meta.main) {
  const code = runProMaxCampaignCli(process.argv.slice(2), {
    repoRoot: new URL("../..", import.meta.url).pathname,
    readFile: (path: string) => readFileSync(path, "utf8"),
    writeFile: (path: string, text: string) => writeFileSync(path, text),
    // `process.stdout.write`, matching the sibling operator commands — this
    // output is the command's result, not debug logging.
    log: (line: string) => {
      process.stdout.write(`${line}\n`)
    },
  })
  process.exit(code)
}
