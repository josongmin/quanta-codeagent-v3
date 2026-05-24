#!/usr/bin/env bun
/**
 * ADR-0132 Phase E — reactor cron watcher (stub).
 *
 * Out-of-process companion to the agent loop. Drives `TriggerSourcePort`
 * polling on a cadence (cron or systemd timer); each fired trigger is handed
 * to `injectSimulatedTurn` against an in-process `AgentLoopPort` that the
 * watcher binds to a real surface (IPC socket, IDE plugin RPC, etc.).
 *
 * This file is INTENTIONALLY a stub: the composition root (apps/agent /
 * apps/cli) owns the real gh-binary + git-binary adapters and the wiring to
 * the host surface's AgentLoopPort. The stub provides:
 *
 *  - The argv contract (`--pr <ref> --interval-ms <ms> --once`).
 *  - The dry-run mode (`--dry-run`) — prints triggers as JSONL without
 *    waking the agent. This is what CI uses to validate the wiring in
 *    smoke without enabling self-wake.
 *  - The default-OFF guard: if `QUANTA_PROACTIVE_REACTOR !== "1"` AND
 *    `--dry-run` is absent, the process refuses to run.
 *
 * Production wiring (deliberately deferred):
 *  - Real `GhCliPort` adapter (`Bun.spawn` wrapping `gh`).
 *  - Real `AgentLoopPort` binding to the desktop / CLI surface.
 *  - File-backed `WatermarkStore` (`.quanta/reactor-watermarks.json`).
 *
 * Until those are wired, this script is a contract-only entry point so the
 * argv shape is locked in before adapters land.
 */

import {
  createCiTriggerSource,
  createInMemorySeenRuns,
  type GhCliPort,
  injectSimulatedTurn,
  type ProactiveTrigger,
  REACTOR_ENV_FLAG,
} from "@/reactor"

/** Argv shape. Parsed pure (no IO) so it can be unit-tested if/when needed. */
export interface WatcherArgs {
  readonly prRef: string | undefined
  readonly intervalMs: number
  readonly once: boolean
  readonly dryRun: boolean
  readonly help: boolean
}

const DEFAULT_INTERVAL_MS = 60_000
const MIN_INTERVAL_MS = 5_000

const HELP_TEXT = `reactor-watch — ADR-0132 cron watcher (stub)

USAGE:
  bun run scripts/reactor-watch.ts --pr <ref> [--interval-ms <n>] [--once]
                                   [--dry-run] [--help]

OPTIONS:
  --pr <ref>           PR identifier accepted by 'gh' (number / URL / slug#n).
                       Required UNLESS --help.
  --interval-ms <n>    Poll cadence in ms. Default ${DEFAULT_INTERVAL_MS}. Min ${MIN_INTERVAL_MS}.
  --once               Poll a single time and exit. Useful for cron drivers.
  --dry-run            Print triggers as JSONL to stdout. Does NOT enable
                       self-wake; the env-flag guard is bypassed.
  --help               Show this help.

ENV:
  ${REACTOR_ENV_FLAG}=1  Required to actually wake the agent. Without it
                            the watcher polls but never enqueues a turn,
                            even outside --dry-run.
`

export const parseArgs = (argv: readonly string[]): WatcherArgs => {
  let prRef: string | undefined
  let intervalMs = DEFAULT_INTERVAL_MS
  let once = false
  let dryRun = false
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--help" || a === "-h") {
      help = true
    } else if (a === "--once") {
      once = true
    } else if (a === "--dry-run") {
      dryRun = true
    } else if (a === "--pr") {
      const v = argv[i + 1]
      if (v !== undefined) {
        prRef = v
        i++
      }
    } else if (a === "--interval-ms") {
      const v = argv[i + 1]
      if (v !== undefined) {
        const n = Number.parseInt(v, 10)
        if (Number.isFinite(n) && n >= MIN_INTERVAL_MS) intervalMs = n
        i++
      }
    }
  }
  return { prRef, intervalMs, once, dryRun, help }
}

/**
 * Placeholder GhCliPort — real adapter lives at the composition root.
 * Exported for tests so the script's wiring shape stays observable.
 */
export const stubGhCliPort = (): GhCliPort => ({
  run: async () => ({
    stdout: "",
    stderr: "stub adapter — bind a real GhCliPort at the composition root",
    exitCode: 1,
  }),
})

/**
 * One-shot poll for the watcher. Returns the triggers that fired AND the
 * decision the watcher took (`enqueued` if self-wake injected, `dry-run` if
 * the dry-run flag short-circuited, `env-off` if the flag guard fired).
 *
 * Pure-shape helper so the same code runs under `--once` and inside the
 * recurring `setInterval` body.
 */
export const pollOnce = async (opts: {
  readonly source: { poll(): Promise<readonly ProactiveTrigger[]> }
  readonly dryRun: boolean
  readonly env: { get(name: string): string | undefined }
}): Promise<{
  readonly triggers: readonly ProactiveTrigger[]
  readonly action: "enqueued" | "dry-run" | "env-off" | "no-trigger"
}> => {
  const triggers = await opts.source.poll()
  if (triggers.length === 0) return { triggers, action: "no-trigger" }
  if (opts.dryRun) return { triggers, action: "dry-run" }
  if (opts.env.get(REACTOR_ENV_FLAG) !== "1") {
    return { triggers, action: "env-off" }
  }
  return { triggers, action: "enqueued" }
}

const main = async (argv: readonly string[]): Promise<number> => {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(HELP_TEXT)
    return 0
  }
  if (args.prRef === undefined) {
    process.stderr.write("error: --pr <ref> is required\n\n")
    process.stderr.write(HELP_TEXT)
    return 2
  }
  if (!args.dryRun && process.env[REACTOR_ENV_FLAG] !== "1") {
    process.stderr.write(
      `error: ${REACTOR_ENV_FLAG} is not set to "1"; refusing to run without --dry-run\n`,
    )
    return 3
  }

  const source = createCiTriggerSource({
    ghCliPort: stubGhCliPort(),
    clockPort: { now: () => Date.now() },
    repoCwd: process.cwd(),
    prRef: args.prRef,
    seenRunsStore: createInMemorySeenRuns(),
  })

  const env = { get: (n: string) => process.env[n] }

  const runOnce = async (): Promise<void> => {
    const { triggers, action } = await pollOnce({
      source,
      dryRun: args.dryRun,
      env,
    })
    for (const t of triggers) {
      process.stdout.write(
        `${JSON.stringify({
          at: Date.now(),
          action,
          reason: t.reason,
          evidence: t.evidence,
          simulatedMessage: t.simulatedMessage,
        })}\n`,
      )
      if (action === "enqueued") {
        // Real wiring binds an AgentLoopPort here; the stub does NOT actually
        // touch a host loop. Production composition root replaces this stub.
        await injectSimulatedTurn({
          trigger: t,
          agentLoop: {
            enqueueUserMessage: async () => {
              /* stub — production binds real loop */
            },
          },
          envPort: env,
          clockPort: { now: () => Date.now() },
          lastUserInputAt: 0,
          lastTurnOutcome: "success",
        })
      }
    }
  }

  await runOnce()
  if (args.once) return 0

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      runOnce().catch(() => {
        /* swallow — a failing poll should NOT crash the watcher */
      })
    }, args.intervalMs)
    process.on("SIGINT", () => {
      clearInterval(interval)
      resolve()
    })
    process.on("SIGTERM", () => {
      clearInterval(interval)
      resolve()
    })
  })
  return 0
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  process.exit(code)
}
