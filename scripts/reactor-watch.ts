#!/usr/bin/env bun
/**
 * ADR-0132 Phase E — reactor cron watcher.
 *
 * Out-of-process companion to the agent loop. Drives `TriggerSourcePort`
 * polling on a cadence (cron or systemd timer); each fired trigger is sent
 * to the live CLI surface over the per-session reactor socket. The CLI host
 * remains the authority for the self-wake guards (`env` / quiet window /
 * prior outcome) because only the host knows current session state.
 */

import { homedir } from "node:os"
import {
  publishReactorWatchTrigger,
  reactorWatchSocketPath,
} from "../src/apps/cli/reactor-watch-bridge"
import {
  createCiTriggerSource,
  createInMemorySeenRuns,
  type GhCliPort,
  type ProactiveTrigger,
  REACTOR_ENV_FLAG,
} from "@/reactor"

/** Argv shape. Parsed pure (no IO) so it can be unit-tested if/when needed. */
export interface WatcherArgs {
  readonly prRef: string | undefined
  readonly sessionId: string | undefined
  readonly socketPath: string | undefined
  readonly intervalMs: number
  readonly once: boolean
  readonly dryRun: boolean
  readonly help: boolean
}

const DEFAULT_INTERVAL_MS = 60_000
const MIN_INTERVAL_MS = 5_000

const HELP_TEXT = `reactor-watch — ADR-0132 cron watcher

USAGE:
  bun run scripts/reactor-watch.ts --pr <ref> --session-id <id>
                                   [--socket-path <path>] [--interval-ms <n>]
                                   [--once] [--dry-run] [--help]

OPTIONS:
  --pr <ref>           PR identifier accepted by 'gh' (number / URL / slug#n).
                       Required UNLESS --help.
  --session-id <id>    Live CLI session id that owns the reactor socket.
                       Required unless --dry-run or --help.
  --socket-path <path> Override the per-session reactor socket path.
                       Default: ~/.quanta/reactor-<session-id>.sock
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
  let sessionId: string | undefined
  let socketPath: string | undefined
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
    } else if (a === "--session-id") {
      const v = argv[i + 1]
      if (v !== undefined) {
        sessionId = v
        i++
      }
    } else if (a === "--socket-path") {
      const v = argv[i + 1]
      if (v !== undefined) {
        socketPath = v
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
  return { prRef, sessionId, socketPath, intervalMs, once, dryRun, help }
}

const ghCliPort = (_repoCwd: string): GhCliPort => ({
  run: async (args, cwd, signal) => {
    const child = Bun.spawn(["gh", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      ...(signal !== undefined ? { signal } : {}),
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, exitCode }
  },
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
  if (!args.dryRun && args.sessionId === undefined) {
    process.stderr.write("error: --session-id <id> is required unless --dry-run\n\n")
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
    ghCliPort: ghCliPort(process.cwd()),
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
      if (action === "enqueued" && args.sessionId !== undefined) {
        await publishReactorWatchTrigger({
          sessionId: args.sessionId,
          socketPath:
            args.socketPath ?? reactorWatchSocketPath(args.sessionId, homedir()),
          trigger: t,
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
