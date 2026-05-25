/**
 * ADR-0132 Phase E — reactor-watch cron watcher: argv + pollOnce decision matrix.
 *
 * The watcher delegates self-wake guards to the live CLI host, but its local
 * contract is still worth locking:
 *
 *   1. `parseArgs` shape — argv flags don't drift before production wires.
 *   2. `pollOnce` decision matrix — given (triggers, dryRun, env), the
 *      `action` field is what the watcher will do. This is the same matrix
 *      a CI smoke would assert end-to-end.
 *
 * Both helpers are pure and import-only, so the tests run in-process without
 * spawning gh / git or opening a socket.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { REACTOR_ENV_FLAG } from "@/reactor"
import type { ProactiveTrigger } from "@/reactor/types"
import {
  createDaemonTriggerDelivery,
  createFileBackedWatermarkStore,
  createQueuedMessageDelivery,
  loadSeenRunsSeed,
  loadWatermarkSnapshot,
  parseArgs,
  persistSeenRunsSnapshot,
  persistWatermarkSnapshot,
  pollOnce,
  reactorDaemonLogPath,
  reactorWatchSeenRunsPath,
  reactorWatchWatermarksPath,
  resolvePrCommentContext,
} from "../../scripts/reactor-watch"
import { buildSimulatedMessage } from "../../src/reactor/self-wake"
import { createInMemorySeenRuns } from "../../src/reactor/trigger-source-ci"

const fakeTrigger = (): ProactiveTrigger =>
  Object.freeze({
    reason: "ci_completion",
    evidence: Object.freeze({ kind: "url" as const, value: "https://x/1" }),
    simulatedMessage: "CI done",
    abortSignal: new AbortController().signal,
  })

describe("ADR-0132 Phase E — parseArgs", () => {
  test("defaults: undefined pr/session/socket, 60s interval, not-once, not-dry-run, not-help", () => {
    const a = parseArgs([])
    expect(a.prRef).toBeUndefined()
    expect(a.sessionId).toBeUndefined()
    expect(a.socketPath).toBeUndefined()
    expect(a.daemonLogPath).toBeUndefined()
    expect(a.watermarksPath).toBeUndefined()
    expect(a.intervalMs).toBe(60_000)
    expect(a.delivery).toBe("socket")
    expect(a.prComments).toBe(true)
    expect(a.once).toBe(false)
    expect(a.dryRun).toBe(false)
    expect(a.help).toBe(false)
  })

  test("--pr <ref> + session/socket/store flags + once/dry-run/no-pr-comments are picked up", () => {
    const a = parseArgs([
      "--pr",
      "owner/repo#7",
      "--session-id",
      "sess-7",
      "--socket-path",
      "/tmp/reactor.sock",
      "--delivery",
      "daemon",
      "--daemon-log-path",
      "/tmp/reactor-daemon.jsonl",
      "--seen-runs-path",
      "/tmp/reactor-seen.json",
      "--watermarks-path",
      "/tmp/reactor-watermarks.json",
      "--no-pr-comments",
      "--once",
      "--dry-run",
    ])
    expect(a.prRef).toBe("owner/repo#7")
    expect(a.sessionId).toBe("sess-7")
    expect(a.socketPath).toBe("/tmp/reactor.sock")
    expect(a.delivery).toBe("daemon")
    expect(a.daemonLogPath).toBe("/tmp/reactor-daemon.jsonl")
    expect(a.seenRunsPath).toBe("/tmp/reactor-seen.json")
    expect(a.watermarksPath).toBe("/tmp/reactor-watermarks.json")
    expect(a.prComments).toBe(false)
    expect(a.once).toBe(true)
    expect(a.dryRun).toBe(true)
  })

  test("--interval-ms accepts large values and ignores too-small (min 5s)", () => {
    expect(parseArgs(["--interval-ms", "120000"]).intervalMs).toBe(120_000)
    // Below MIN_INTERVAL_MS ⇒ default is kept.
    expect(parseArgs(["--interval-ms", "1000"]).intervalMs).toBe(60_000)
    // Non-numeric ⇒ default.
    expect(parseArgs(["--interval-ms", "fast"]).intervalMs).toBe(60_000)
  })

  test("--help and -h both set help=true", () => {
    expect(parseArgs(["--help"]).help).toBe(true)
    expect(parseArgs(["-h"]).help).toBe(true)
  })

  test("unknown flags are tolerated (forward-compat)", () => {
    const a = parseArgs(["--pr", "1", "--future-flag", "xyz"])
    expect(a.prRef).toBe("1")
  })
})

describe("ADR-0132 Phase E — seen-runs persistence", () => {
  test("default daemon log path is session-scoped under ~/.quanta", () => {
    const path = reactorDaemonLogPath("session/7", "/home/tester")
    expect(path).toBe("/home/tester/.quanta/reactor-daemon-session_7.jsonl")
  })

  test("default seen-runs path is PR-scoped under ~/.quanta", () => {
    const path = reactorWatchSeenRunsPath("owner/repo#7", "/home/tester")
    expect(path).toBe("/home/tester/.quanta/reactor-seen-runs-owner_repo_7.json")
  })

  test("persistSeenRunsSnapshot + loadSeenRunsSeed round-trip the capped run ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-reactor-watch-"))
    const file = join(dir, "seen.json")
    try {
      const store = createInMemorySeenRuns(["run-1", "run-2"])
      store.add("run-3")
      await persistSeenRunsSnapshot(file, store)
      const loaded = await loadSeenRunsSeed(file)
      expect(loaded).toEqual(["run-1", "run-2", "run-3"])
      expect(readFileSync(file, "utf8")).toContain('"runIds"')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("ADR-0132 Phase E — detached delivery backends", () => {
  test("queued delivery serializes messages in order", async () => {
    const events: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const delivery = createQueuedMessageDelivery({
      runMessage: async (message) => {
        events.push(`start:${message}`)
        if (message === "one") await firstDone
        events.push(`end:${message}`)
      },
    })

    const one = delivery.enqueueMessage("one")
    const two = delivery.enqueueMessage("two")
    releaseFirst?.()
    await Promise.all([one, two])
    await delivery.close()

    expect(events).toEqual(["start:one", "end:one", "start:two", "end:two"])
  })

  test("daemon delivery converts a trigger into the simulated user message and closes the factory", async () => {
    const delivered: string[] = []
    let factoryClosed = false
    const trigger = fakeTrigger()
    const expected = buildSimulatedMessage(trigger)
    const delivery = await createDaemonTriggerDelivery(
      {
        sessionId: "session-7",
        cwd: "/tmp/reactor",
        homeDir: "/tmp/reactor-home",
      },
      {
        createBaseFactory: async () => ({
          createBase: async (message) => {
            delivered.push(`base:${message}`)
            return {
              llm: {} as never,
              registry: {} as never,
              stream: { close: () => undefined } as never,
              permission: { mode: "acceptEdits" },
              messages: [{ role: "user", content: [{ type: "text", text: message }] }],
              system: "sys",
              cwd: "/tmp/reactor",
              maxTurns: 1,
              signal: new AbortController().signal,
            } as Omit<AgentConfig, "modePolicy" | "budgetMeter">
          },
          close: async () => {
            factoryClosed = true
          },
        }),
        runMode: async (req) => {
          const first = req.base.messages[0]
          const text =
            first?.content.find((block) => block.type === "text")?.type === "text"
              ? first.content.find((block) => block.type === "text")?.text
              : ""
          delivered.push(`run:${text}`)
          return { exitCode: 0, outcome: { reason: "completed" } as never }
        },
      },
    )

    await delivery.deliverTrigger(trigger)
    await delivery.close()

    expect(delivered).toEqual([`base:${expected}`, `run:${expected}`])
    expect(factoryClosed).toBe(true)
  })
})

describe("ADR-0132 Phase E — PR-comment watermarks + context", () => {
  test("default watermarks path is PR-scoped under ~/.quanta", () => {
    const path = reactorWatchWatermarksPath("owner/repo#7", "/home/tester")
    expect(path).toBe("/home/tester/.quanta/reactor-watermarks-owner_repo_7.json")
  })

  test("persistWatermarkSnapshot + loadWatermarkSnapshot round-trip the key map", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-reactor-watch-watermarks-"))
    const file = join(dir, "watermarks.json")
    try {
      await persistWatermarkSnapshot(file, {
        "owner/repo#7": "2026-05-25T11:00:00Z",
        "owner/repo#8": "2026-05-25T12:00:00Z",
      })
      const loaded = await loadWatermarkSnapshot(file)
      expect(loaded).toEqual({
        "owner/repo#7": "2026-05-25T11:00:00Z",
        "owner/repo#8": "2026-05-25T12:00:00Z",
      })
      expect(readFileSync(file, "utf8")).toContain('"watermarks"')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("file-backed watermark store persists save/load across fresh readers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-reactor-watch-store-"))
    const file = join(dir, "watermarks.json")
    try {
      const store = createFileBackedWatermarkStore(file)
      await store.save("owner/repo#7", "2026-05-25T13:00:00Z")
      const fresh = createFileBackedWatermarkStore(file)
      expect(await fresh.load("owner/repo#7")).toBe("2026-05-25T13:00:00Z")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("resolvePrCommentContext parses owner/repo#n refs without gh", async () => {
    let calls = 0
    const ctx = await resolvePrCommentContext({
      ghCliPort: {
        run: async () => {
          calls++
          return { stdout: "", stderr: "", exitCode: 1 }
        },
      },
      repoCwd: "/tmp",
      prRef: "owner/repo#7",
    })
    expect(ctx).toEqual({
      repoSlug: "owner/repo",
      prNumber: 7,
      watermarkKey: "owner/repo#7",
    })
    expect(calls).toBe(0)
  })

  test("resolvePrCommentContext parses GitHub PR URLs without gh", async () => {
    const ctx = await resolvePrCommentContext({
      ghCliPort: {
        run: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
      },
      repoCwd: "/tmp",
      prRef: "https://github.com/owner/repo/pull/9",
    })
    expect(ctx).toEqual({
      repoSlug: "owner/repo",
      prNumber: 9,
      watermarkKey: "owner/repo#9",
    })
  })

  test("resolvePrCommentContext falls back to gh pr view when the ref lacks repo slug", async () => {
    const ctx = await resolvePrCommentContext({
      ghCliPort: {
        run: async () => ({
          stdout: JSON.stringify({
            url: "https://github.com/owner/repo/pull/11",
            number: 11,
          }),
          stderr: "",
          exitCode: 0,
        }),
      },
      repoCwd: "/tmp/repo",
      prRef: "11",
    })
    expect(ctx).toEqual({
      repoSlug: "owner/repo",
      prNumber: 11,
      watermarkKey: "owner/repo#11",
    })
  })
})

describe("ADR-0132 Phase E — pollOnce decision matrix", () => {
  const sourceWith = (
    triggers: readonly ProactiveTrigger[],
  ): { poll(): Promise<readonly ProactiveTrigger[]> } => ({
    poll: async () => triggers,
  })
  const envWith = (
    vars: Readonly<Record<string, string>>,
  ): { get(name: string): string | undefined } => ({
    get: (n) => vars[n],
  })

  test("no triggers ⇒ action=no-trigger regardless of env / dry-run", async () => {
    const r1 = await pollOnce({
      source: sourceWith([]),
      dryRun: false,
      env: envWith({ [REACTOR_ENV_FLAG]: "1" }),
    })
    expect(r1.action).toBe("no-trigger")
    const r2 = await pollOnce({
      source: sourceWith([]),
      dryRun: true,
      env: envWith({}),
    })
    expect(r2.action).toBe("no-trigger")
  })

  test("triggers + dry-run ⇒ action=dry-run (env irrelevant)", async () => {
    const r = await pollOnce({
      source: sourceWith([fakeTrigger()]),
      dryRun: true,
      env: envWith({}),
    })
    expect(r.action).toBe("dry-run")
    expect(r.triggers.length).toBe(1)
  })

  test("triggers + env-off + not-dry-run ⇒ action=env-off", async () => {
    const r = await pollOnce({
      source: sourceWith([fakeTrigger()]),
      dryRun: false,
      env: envWith({}),
    })
    expect(r.action).toBe("env-off")
  })

  test("triggers + env=1 + not-dry-run ⇒ action=enqueued", async () => {
    const r = await pollOnce({
      source: sourceWith([fakeTrigger()]),
      dryRun: false,
      env: envWith({ [REACTOR_ENV_FLAG]: "1" }),
    })
    expect(r.action).toBe("enqueued")
  })

  test("env value other than literal '1' ⇒ action=env-off (strict match)", async () => {
    const r = await pollOnce({
      source: sourceWith([fakeTrigger()]),
      dryRun: false,
      env: envWith({ [REACTOR_ENV_FLAG]: "true" }),
    })
    expect(r.action).toBe("env-off")
  })
})
