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

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  publishReactorWatchTrigger,
  reactorWatchSocketPath,
} from "../src/apps/cli/reactor-watch-bridge"
import {
  createCiTriggerSource,
  createInMemorySeenRuns,
  createPrCommentTriggerSource,
  type GhCliPort,
  type ProactiveTrigger,
  REACTOR_ENV_FLAG,
  type SnapshotSeenRunsStore,
  type WatermarkStore,
} from "@/reactor"

/** Argv shape. Parsed pure (no IO) so it can be unit-tested if/when needed. */
export interface WatcherArgs {
  readonly prRef: string | undefined
  readonly sessionId: string | undefined
  readonly socketPath: string | undefined
  readonly seenRunsPath: string | undefined
  readonly watermarksPath: string | undefined
  readonly intervalMs: number
  readonly prComments: boolean
  readonly once: boolean
  readonly dryRun: boolean
  readonly help: boolean
}

const DEFAULT_INTERVAL_MS = 60_000
const MIN_INTERVAL_MS = 5_000

const HELP_TEXT = `reactor-watch — ADR-0132 cron watcher

USAGE:
  bun run scripts/reactor-watch.ts --pr <ref> --session-id <id>
                                   [--socket-path <path>] [--seen-runs-path <path>]
                                   [--watermarks-path <path>] [--no-pr-comments]
                                   [--interval-ms <n>]
                                   [--once] [--dry-run] [--help]

OPTIONS:
  --pr <ref>           PR identifier accepted by 'gh' (number / URL / slug#n).
                       Required UNLESS --help.
  --session-id <id>    Live CLI session id that owns the reactor socket.
                       Required unless --dry-run or --help.
  --socket-path <path> Override the per-session reactor socket path.
                       Default: ~/.quanta/reactor-<session-id>.sock
  --seen-runs-path <path>
                       Persist completed CI run ids across restarts.
                       Default: ~/.quanta/reactor-seen-runs-<pr>.json
  --watermarks-path <path>
                       Persist PR-comment watermarks across restarts.
                       Default: ~/.quanta/reactor-watermarks-<pr>.json
  --no-pr-comments     Disable PR-comment polling; watch CI completion only.
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
  let seenRunsPath: string | undefined
  let watermarksPath: string | undefined
  let intervalMs = DEFAULT_INTERVAL_MS
  let prComments = true
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
    } else if (a === "--no-pr-comments") {
      prComments = false
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
    } else if (a === "--seen-runs-path") {
      const v = argv[i + 1]
      if (v !== undefined) {
        seenRunsPath = v
        i++
      }
    } else if (a === "--watermarks-path") {
      const v = argv[i + 1]
      if (v !== undefined) {
        watermarksPath = v
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
  return {
    prRef,
    sessionId,
    socketPath,
    seenRunsPath,
    watermarksPath,
    intervalMs,
    prComments,
    once,
    dryRun,
    help,
  }
}

const sanitizePrToken = (prRef: string): string => {
  const cleaned = prRef.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[-.]+/, "_")
  return cleaned.length > 0 ? cleaned : "pr"
}

export const reactorWatchSeenRunsPath = (prRef: string, home = homedir()): string =>
  join(home.replace(/\/+$/, ""), ".quanta", `reactor-seen-runs-${sanitizePrToken(prRef)}.json`)

export const reactorWatchWatermarksPath = (prRef: string, home = homedir()): string =>
  join(home.replace(/\/+$/, ""), ".quanta", `reactor-watermarks-${sanitizePrToken(prRef)}.json`)

const normalizeSeenRuns = (parsed: unknown): readonly string[] => {
  if (Array.isArray(parsed)) {
    return parsed.filter((value): value is string => typeof value === "string")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return []
  const runIds = (parsed as { runIds?: unknown }).runIds
  return Array.isArray(runIds)
    ? runIds.filter((value): value is string => typeof value === "string")
    : []
}

export const loadSeenRunsSeed = async (path: string): Promise<readonly string[]> => {
  try {
    const raw = await readFile(path, "utf8")
    return normalizeSeenRuns(JSON.parse(raw))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return []
    return []
  }
}

const normalizeWatermarkSnapshot = (parsed: unknown): Readonly<Record<string, string>> => {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
  const raw = (parsed as { watermarks?: unknown }).watermarks
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
  )
  return Object.fromEntries(entries)
}

export const loadWatermarkSnapshot = async (
  path: string,
): Promise<Readonly<Record<string, string>>> => {
  try {
    const raw = await readFile(path, "utf8")
    return normalizeWatermarkSnapshot(JSON.parse(raw))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return {}
    return {}
  }
}

export const persistWatermarkSnapshot = async (
  path: string,
  snapshot: Readonly<Record<string, string>>,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify({ watermarks: snapshot }, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

export const createFileBackedWatermarkStore = (path: string): WatermarkStore => ({
  load: async (key) => (await loadWatermarkSnapshot(path))[key],
  save: async (key, value) => {
    const next = { ...(await loadWatermarkSnapshot(path)), [key]: value }
    await persistWatermarkSnapshot(path, next)
  },
})

export const persistSeenRunsSnapshot = async (
  path: string,
  store: SnapshotSeenRunsStore,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify({ runIds: store.snapshot() }, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

interface PrCommentContext {
  readonly repoSlug: string
  readonly prNumber: number
  readonly watermarkKey: string
}

const prCommentWatermarkKey = (repoSlug: string, prNumber: number): string =>
  `${repoSlug}#${prNumber}`

const parsePrUrlContext = (url: string): { repoSlug: string; prNumber: number } | undefined => {
  const m = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/i.exec(url.trim())
  if (m === null) return undefined
  const prNumber = Number.parseInt(m[2] ?? "", 10)
  if (!Number.isFinite(prNumber) || prNumber <= 0) return undefined
  return { repoSlug: m[1] as string, prNumber }
}

const parseSlugRefContext = (prRef: string): { repoSlug: string; prNumber: number } | undefined => {
  const m = /^([^#]+\/[^#]+)#(\d+)$/.exec(prRef.trim())
  if (m === null) return undefined
  const prNumber = Number.parseInt(m[2] ?? "", 10)
  if (!Number.isFinite(prNumber) || prNumber <= 0) return undefined
  return { repoSlug: m[1] as string, prNumber }
}

const safeJsonObject = <T>(raw: string): T | undefined => {
  try {
    const v = JSON.parse(raw) as unknown
    if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined
    return v as T
  } catch {
    return undefined
  }
}

export const resolvePrCommentContext = async (opts: {
  readonly ghCliPort: GhCliPort
  readonly repoCwd: string
  readonly prRef: string
  readonly signal?: AbortSignal
}): Promise<PrCommentContext | undefined> => {
  const direct = parseSlugRefContext(opts.prRef) ?? parsePrUrlContext(opts.prRef)
  if (direct !== undefined) {
    return {
      ...direct,
      watermarkKey: prCommentWatermarkKey(direct.repoSlug, direct.prNumber),
    }
  }

  const res = await opts.ghCliPort.run(
    ["pr", "view", opts.prRef, "--json", "url,number"],
    opts.repoCwd,
    opts.signal,
  )
  if (res.exitCode !== 0) return undefined
  const parsed = safeJsonObject<{ url?: unknown; number?: unknown }>(res.stdout)
  if (parsed === undefined) return undefined
  const urlCtx =
    typeof parsed.url === "string" && parsed.url.length > 0 ? parsePrUrlContext(parsed.url) : undefined
  if (urlCtx === undefined) return undefined
  const prNumber =
    typeof parsed.number === "number" && Number.isFinite(parsed.number) && parsed.number > 0
      ? Math.floor(parsed.number)
      : urlCtx.prNumber
  return {
    repoSlug: urlCtx.repoSlug,
    prNumber,
    watermarkKey: prCommentWatermarkKey(urlCtx.repoSlug, prNumber),
  }
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

  const seenRunsPath = args.seenRunsPath ?? reactorWatchSeenRunsPath(args.prRef, homedir())
  const seenRunsStore = createInMemorySeenRuns(await loadSeenRunsSeed(seenRunsPath))
  const gh = ghCliPort(process.cwd())
  const ciSource = createCiTriggerSource({
    ghCliPort: gh,
    clockPort: { now: () => Date.now() },
    repoCwd: process.cwd(),
    prRef: args.prRef,
    seenRunsStore,
  })
  const commentSource =
    args.prComments === true
      ? await (async () => {
          const ctx = await resolvePrCommentContext({
            ghCliPort: gh,
            repoCwd: process.cwd(),
            prRef: args.prRef,
          })
          if (ctx === undefined) return undefined
          const watermarksPath =
            args.watermarksPath ?? reactorWatchWatermarksPath(args.prRef, homedir())
          return createPrCommentTriggerSource({
            ghCliPort: gh,
            clockPort: { now: () => Date.now() },
            repoCwd: process.cwd(),
            repoSlug: ctx.repoSlug,
            prNumber: ctx.prNumber,
            watermarkKey: ctx.watermarkKey,
            watermarkStore: createFileBackedWatermarkStore(watermarksPath),
          })
        })()
      : undefined
  const source = {
    poll: async () => {
      const commentPoll =
        commentSource !== undefined ? commentSource.poll() : Promise.resolve<readonly ProactiveTrigger[]>([])
      const [ci, comments] = await Promise.all([ciSource.poll(), commentPoll])
      return [...ci, ...comments] as readonly ProactiveTrigger[]
    },
  }

  const env = { get: (n: string) => process.env[n] }

  const runOnce = async (): Promise<void> => {
    const before = JSON.stringify(seenRunsStore.snapshot())
    const { triggers, action } = await pollOnce({
      source,
      dryRun: args.dryRun,
      env,
    })
    if (JSON.stringify(seenRunsStore.snapshot()) !== before) {
      await persistSeenRunsSnapshot(seenRunsPath, seenRunsStore)
    }
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
