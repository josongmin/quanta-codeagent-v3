/**
 * One-shot composition root for the `from-pr` Tier-0 entry (ADR-0311).
 *
 * Invoked directly by `.github/workflows/quanta-pr-bot.yml.template`:
 *
 *     bun run src/apps/cli/from-pr-cmd-runner.ts [flags…]
 *
 * Wires the 5 production adapters, parses argv via `node:util` parseArgs (closed
 * allowlist), runs `runFromPrCmd`, prints one line per FromPrCmdEvent to
 * stdout, and exits with `FromPrCmdResult.exitCode`. No REPL, no sandbox-wire,
 * no slash dispatch.
 *
 * Exit codes:
 *   - 0  success / skipped (env-off, no trigger, dry-run-body emitted, abort)
 *   - 1  poll-failed / context-failed / post-failed (mirrors FromPrCmdResult)
 *   - 64 unknown argv flag (mirrors existing CLI EX_USAGE convention)
 *
 * Slice fence: imports `./from-pr-cmd` + `./from-pr-cmd-adapters` only. No
 * agent / llm / permission / tool / runner / skill / mcp / apps siblings.
 */

import { parseArgs } from "node:util"
import { errMessage } from "@/shared"
import { type FromPrCmdArgs, type FromPrCmdEvent, runFromPrCmd } from "./from-pr-cmd"
import {
  createBunGhCliPort,
  createNodeEnvPort,
  createNodeFsPort,
  createRedactPort,
  createSystemClockPort,
} from "./from-pr-cmd-adapters"

const USAGE = `Usage: bun run src/apps/cli/from-pr-cmd-runner.ts [flags]

  --repo <owner/repo>      override GITHUB_REPOSITORY
  --pr <n>                 override PR number (default: parsed from event URL)
  --dry-run                emit redacted body to stdout, do not post
  --trust-scope <scope>    collaborator | member | owner | public
  --trigger-phrase <p>     repeatable; default "@quanta", "/quanta"
  --allow-bots             do not silently drop bot senders
  --event-source <s>       actions (default) | webhook | poll  (Tier 1 deferred)
  --help                   print this message and exit 0
`

const VALID_TRUST_SCOPES = new Set(["collaborator", "member", "owner", "public"])
const VALID_EVENT_SOURCES = new Set(["actions", "webhook", "poll"])

interface ParseOk {
  readonly kind: "ok"
  readonly args: FromPrCmdArgs
  readonly helpRequested: boolean
}
interface ParseErr {
  readonly kind: "err"
  readonly message: string
}
type ParseResult = ParseOk | ParseErr

const parseArgv = (argv: readonly string[]): ParseResult => {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        repo: { type: "string" },
        pr: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "trust-scope": { type: "string" },
        "trigger-phrase": { type: "string", multiple: true },
        "allow-bots": { type: "boolean", default: false },
        "event-source": { type: "string", default: "actions" },
        help: { type: "boolean", default: false },
      },
    })
  } catch (error) {
    return { kind: "err", message: errMessage(error) }
  }
  const v = parsed.values
  if (v.help === true) {
    return { kind: "ok", args: {}, helpRequested: true }
  }

  const out: Record<string, unknown> = {}
  if (typeof v.repo === "string" && v.repo.length > 0) out.repoSlug = v.repo
  if (typeof v.pr === "string" && v.pr.length > 0) {
    const n = Number.parseInt(v.pr, 10)
    if (!Number.isFinite(n) || n <= 0)
      return { kind: "err", message: `--pr must be a positive integer, got "${v.pr}"` }
    out.prNumber = n
  }
  if (v["dry-run"] === true) out.dryRun = true
  if (v["allow-bots"] === true) out.allowBots = true
  if (typeof v["trust-scope"] === "string") {
    if (!VALID_TRUST_SCOPES.has(v["trust-scope"])) {
      return {
        kind: "err",
        message: `--trust-scope must be one of ${[...VALID_TRUST_SCOPES].join(", ")}`,
      }
    }
    out.trustScope = v["trust-scope"]
  }
  if (Array.isArray(v["trigger-phrase"]) && v["trigger-phrase"].length > 0) {
    const phrases = v["trigger-phrase"].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    )
    if (phrases.length > 0) out.triggerPhrases = Object.freeze(phrases)
  }
  if (typeof v["event-source"] === "string") {
    if (!VALID_EVENT_SOURCES.has(v["event-source"])) {
      return {
        kind: "err",
        message: `--event-source must be one of ${[...VALID_EVENT_SOURCES].join(", ")}`,
      }
    }
    out.eventSource = v["event-source"]
  }

  return { kind: "ok", args: out as FromPrCmdArgs, helpRequested: false }
}

/** Render one FromPrCmdEvent as a single JSON-Line so workflow logs grep cleanly. */
const formatEvent = (event: FromPrCmdEvent): string => JSON.stringify(event)

/**
 * Entry — invoked at module-load (top-level await). Exported for unit tests
 * that drive the runner with injected argv / writeLine / exit ports.
 */
export interface RunnerPorts {
  readonly argv: readonly string[]
  readonly writeLine: (s: string) => void
  readonly writeErr: (s: string) => void
  readonly onExit: (code: number) => void
  readonly installSignals: (controller: AbortController) => () => void
}

export const runFromPrCmdMain = async (ports: RunnerPorts): Promise<void> => {
  const parsed = parseArgv(ports.argv)
  if (parsed.kind === "err") {
    ports.writeErr(parsed.message)
    ports.writeErr(USAGE)
    ports.onExit(64)
    return
  }
  if (parsed.helpRequested) {
    ports.writeLine(USAGE)
    ports.onExit(0)
    return
  }

  const controller = new AbortController()
  const uninstall = ports.installSignals(controller)

  try {
    const result = await runFromPrCmd(parsed.args, {
      envPort: createNodeEnvPort(),
      fsPort: createNodeFsPort(),
      ghCliPort: createBunGhCliPort(),
      clockPort: createSystemClockPort(),
      redactPort: createRedactPort(),
      onEvent: (event) => ports.writeLine(formatEvent(event)),
      signal: controller.signal,
    })
    if (result.error !== undefined) ports.writeErr(result.error)
    ports.onExit(result.exitCode)
  } finally {
    uninstall()
  }
}

const defaultInstallSignals = (controller: AbortController): (() => void) => {
  const handler = (): void => controller.abort()
  process.on("SIGINT", handler)
  process.on("SIGTERM", handler)
  return () => {
    process.off("SIGINT", handler)
    process.off("SIGTERM", handler)
  }
}

// Module-level entry — only fires when this file is the program entry, not on
// import (tests import `runFromPrCmdMain` directly and drive it via injected
// ports). Bun sets `import.meta.main = true` for the entry module.
if ((import.meta as { main?: boolean }).main === true) {
  await runFromPrCmdMain({
    argv: process.argv.slice(2),
    writeLine: (s) => process.stdout.write(`${s}\n`),
    writeErr: (s) => process.stderr.write(`${s}\n`),
    onExit: (code) => process.exit(code),
    installSignals: defaultInstallSignals,
  })
}
