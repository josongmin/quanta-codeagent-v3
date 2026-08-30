#!/usr/bin/env bun
/**
 * PMX-06 — the OPERATOR entry point for the staged campaign gates.
 *
 * A shim, deliberately: it binds real filesystem ports to
 * {@link runProMaxCampaignCli} and does nothing else, so the whole promotion
 * policy stays testable without this file.
 *
 * ```sh
 * bun tools/bench-promax/campaign-gates.ts freeze --input campaign-input.json --out campaign-record.json
 * bun tools/bench-promax/campaign-gates.ts preflight --record campaign-record.json
 * bun tools/bench-promax/campaign-gates.ts gate --gate gate1_pmx7_gold \
 *     --record campaign-record.json --evidence gate1-evidence.json --out gate1.result.json
 * ```
 *
 * ⚠️ It cannot provision, pull, upload, or bill. The sole subprocess is a
 * literal read-only `git` query used by `freeze` to attest the exact clean SHA;
 * the campaign core still receives no process/Docker/network port.
 */
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { runProMaxCampaignCli } from "@/apps/bench/promax/campaign"

if (import.meta.main) {
  const code = runProMaxCampaignCli(process.argv.slice(2), {
    repoRoot: new URL("../..", import.meta.url).pathname,
    readFile: (path: string) => readFileSync(path, "utf8"),
    writeFile: (path: string, text: string) => writeFileSync(path, text),
    sourceSnapshot: () => {
      const cwd = new URL("../..", import.meta.url).pathname
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim()
      const dirty =
        execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim() !== ""
      return { sha, dirty }
    },
    // `process.stdout.write`, matching the sibling operator commands — this
    // output is the command's result, not debug logging.
    log: (line: string) => {
      process.stdout.write(`${line}\n`)
    },
  })
  process.exit(code)
}
