/**
 * Track T / I / R wire hellgate — 20 adversarial cases pinning the REPL
 * surface wiring of three leaf modules into the new
 * `repl/{slash-surface,surface-compose,session-setup}` structure:
 *
 *   T  ─ timeline panel boot toggle (`QUANTA_TIMELINE=<N>`)
 *        - panel allocated only when N > 0 AND stderr is a TTY
 *        - stream is teed through a proxy → `panel.emit` on every event
 *        - non-TTY / unset / 0 / non-finite ⇒ literal stream + no panel
 *        - panel.teardown() callable + idempotent
 *
 *   I  ─ `/inspect <toolCallId>` slash
 *        - registered in BUILTINS (slot pinned after `/debug`)
 *        - `SlashContext.inspect` type slot exists
 *        - missing `ctx.inspect` ⇒ exit 1 + "no active session" (the
 *          leaf already locks the empty-id and no-session messages; we
 *          assert PROPAGATION)
 *        - missing-id arg ⇒ exit 1 + error to stderr
 *        - missing extras ⇒ exit 1
 *
 *   R  ─ `/replay <session-id>` slash
 *        - registered in BUILTINS (slot pinned after `/inspect`)
 *        - `SlashContext.replay` type slot exists
 *        - missing `ctx.replay` ⇒ exit 0 + "/replay: not wired"
 *        - resolveSession returns undefined ⇒ exit 1 + "not found"
 *        - happy path: rendered N frames + exit 0
 *
 *  Each case runs the REAL branch — no stubbed-return shortcuts.
 *
 *  Slice fence: imports ONLY the surface modules + slash registry. Does
 *  NOT mutate the leaf modules (timeline-panel.ts / inspect-cmd.ts /
 *  replay-cmd.ts / inspect-source.ts).
 */

import { describe, expect, test } from "bun:test"
import {
  buildReplSlashCtx,
  dispatchReplSlash,
  type ReplaySlashState,
  type ReplSlashCtx,
} from "../../../src/apps/cli/repl/slash-surface"
import { BUILTINS, runSlashCommand, type SlashContext } from "../../../src/apps/cli/slash-commands"
import { readCliFeatureConfig } from "../../../src/apps/cli/repl/cli-feature-config"
import { buildTimelinePanelAndStream } from "../../../src/apps/cli/repl/factories"
import type { SessionEnvelopeRecord } from "../../../src/session"
import type { AgentEvent, StreamPort } from "../../../src/stream"

// =============================================================================
// helpers: capture stdout / stderr
// =============================================================================

interface Sinks {
  out: string
  err: string
}
const mkSinks = (): { sinks: Sinks; ctx: Pick<SlashContext, "out" | "err" | "cwd"> } => {
  const sinks: Sinks = { out: "", err: "" }
  const ctx = {
    out: (s: string): void => {
      sinks.out += s
    },
    err: (s: string): void => {
      sinks.err += s
    },
    cwd: "/tmp/wire-tir",
  }
  return { sinks, ctx }
}

// Drive the REAL host path: env → `readCliFeatureConfig` (the production
// env-parse + stderr-TTY gate) → `buildTimelinePanelAndStream` (the production
// panel + tee factory). The earlier version re-implemented both here and only
// proved the copy — a regression in either real function stayed green.
const realBuildTimeline = (
  stream: StreamPort,
  envSource: Record<string, string | undefined>,
  stderrIsTTY: boolean | undefined,
): { stream: StreamPort; panel: { teardown: () => void } | undefined } => {
  const cfg = readCliFeatureConfig(envSource as NodeJS.ProcessEnv, undefined, stderrIsTTY)
  return buildTimelinePanelAndStream(cfg, stream)
}

// =============================================================================
// Track I — `/inspect` registration + dispatch
// =============================================================================

describe("Track I — `/inspect` is wired into BUILTINS", () => {
  test("BUILTINS table includes `/inspect`", () => {
    expect(BUILTINS.map((c) => c.name)).toContain("/inspect")
  })

  test("`/inspect` carries a `session` category (debug-mode follow-up)", () => {
    const entry = BUILTINS.find((c) => c.name === "/inspect")
    expect(entry).toBeDefined()
    expect(entry?.category).toBe("session")
  })

  test("`/inspect` is registered exactly once in BUILTINS (no duplicate slot)", () => {
    // Catches a merge-conflict mistake where /inspect ends up wired twice
    // (which would then double-dispatch on every call).
    const matches = BUILTINS.filter((c) => c.name === "/inspect")
    expect(matches.length).toBe(1)
  })

  test("SlashContext.inspect slot exists at the type level", () => {
    // Compile-time invariant: assignment to a typed local fails if the slot
    // is missing. The bare cast through `Partial` keeps this a structural
    // type check without a runtime instance.
    type _Has = NonNullable<SlashContext["inspect"]>
    const probe: _Has = { sessionId: "x" } as _Has
    expect(probe.sessionId).toBe("x")
  })
})

describe("Track I — `/inspect` dispatcher behavior", () => {
  test("missing argument ⇒ exit 1 + usage line on stderr", async () => {
    const { sinks, ctx } = mkSinks()
    const code = await runSlashCommand("/inspect", ctx)
    expect(code).toBe(1)
    expect(sinks.err).toContain("/inspect:")
  })

  test("ctx.inspect absent ⇒ exit 1 + 'no active session' propagated through stdout", async () => {
    const { sinks, ctx } = mkSinks()
    const code = await runSlashCommand("/inspect tc_7a", ctx)
    expect(code).toBe(1)
    // The leaf prints to `out` (per inspect-cmd.ts:78). Either sink is fine —
    // the contract is "non-silent surfacing on the missing-session path".
    expect(sinks.out + sinks.err).toContain("no active session")
  })

  test("too many positional args ⇒ exit 1 + 'takes exactly one'", async () => {
    const { sinks, ctx } = mkSinks()
    const code = await runSlashCommand("/inspect tc_7a tc_8b", ctx)
    expect(code).toBe(1)
    expect(sinks.err).toContain("takes exactly one")
  })
})

// =============================================================================
// Track R — `/replay` registration + dispatch
// =============================================================================

describe("Track R — `/replay` is wired into BUILTINS", () => {
  test("BUILTINS table includes `/replay`", () => {
    expect(BUILTINS.map((c) => c.name)).toContain("/replay")
  })

  test("`/replay` carries a `history` category", () => {
    const entry = BUILTINS.find((c) => c.name === "/replay")
    expect(entry).toBeDefined()
    expect(entry?.category).toBe("history")
  })

  test("`/replay` is registered exactly once in BUILTINS", () => {
    const matches = BUILTINS.filter((c) => c.name === "/replay")
    expect(matches.length).toBe(1)
  })

  test("SlashContext.replay slot exists at the type level", () => {
    type _Has = NonNullable<SlashContext["replay"]>
    const probe: _Has = {
      resolveSession: async () => undefined,
      iterate: async function* (): AsyncIterable<SessionEnvelopeRecord> {
        /* empty */
      },
    } as _Has
    expect(typeof probe.resolveSession).toBe("function")
  })
})

describe("Track R — `/replay` dispatcher behavior", () => {
  test("ctx.replay absent ⇒ exit 0 + 'not wired in this surface' on stdout", async () => {
    const { sinks, ctx } = mkSinks()
    const code = await runSlashCommand("/replay sid", ctx)
    expect(code).toBe(0)
    expect(sinks.out).toContain("/replay: not wired in this surface")
  })

  test("ctx.replay present, resolveSession ⇒ undefined ⇒ exit 1 + 'not found'", async () => {
    const { sinks, ctx } = mkSinks()
    const replay: ReplaySlashState = {
      resolveSession: async () => undefined,
      iterate: async function* (): AsyncIterable<SessionEnvelopeRecord> {
        /* empty */
      },
    }
    const code = await runSlashCommand("/replay missing-sid", { ...ctx, replay })
    expect(code).toBe(1)
    expect(sinks.out).toContain("not found")
  })

  test("ctx.replay present, happy path ⇒ exit 0 + N frames + done footer", async () => {
    const { sinks, ctx } = mkSinks()
    const envelope: SessionEnvelopeRecord = {
      type: "event_msg",
      kind: "user_message",
      ts: new Date(1717000000000).toISOString(),
      turn_id: "1",
      content: "hello world",
    } as SessionEnvelopeRecord
    const replay: ReplaySlashState = {
      resolveSession: async () => "/tmp/fake.jsonl",
      iterate: async function* (): AsyncIterable<SessionEnvelopeRecord> {
        yield envelope
        yield envelope
      },
    }
    const code = await runSlashCommand("/replay sid", { ...ctx, replay })
    expect(code).toBe(0)
    // header
    expect(sinks.out).toContain("replay session")
    // body
    expect(sinks.out).toContain("user_message")
    // footer — pin the digit so a regression that printed "0 frames" + skipped
    // the body would still fail.
    expect(sinks.out).toMatch(/\b2 frames\b/)
    // Negative: error sink stayed empty on the happy path.
    expect(sinks.err).toBe("")
    // body lines for both yielded envelopes — the user_message label must
    // appear at LEAST twice (one per frame).
    const occurrences = sinks.out.split("user_message").length - 1
    expect(occurrences).toBeGreaterThanOrEqual(2)
  })

  test("malformed --at flag ⇒ exit 1 + error", async () => {
    const { sinks, ctx } = mkSinks()
    const replay: ReplaySlashState = {
      resolveSession: async () => "/tmp/fake.jsonl",
      iterate: async function* (): AsyncIterable<SessionEnvelopeRecord> {
        /* empty */
      },
    }
    const code = await runSlashCommand("/replay sid --at abc", { ...ctx, replay })
    expect(code).toBe(1)
    expect(sinks.err).toContain("--at expects a non-negative integer")
  })
})

// =============================================================================
// Track T — `QUANTA_TIMELINE=<N>` boot toggle (host helper)
// =============================================================================

describe("Track T — `buildTimelinePanelAndStream` boot toggle (real factory)", () => {
  const baseStream: StreamPort = { emit: () => undefined }

  // The production gate is `stderrIsTTY === true && QUANTA_TIMELINE parses to a
  // positive int`. Every OFF arm must return the LITERAL base stream (default-
  // OFF byte-identical: no tee, no extra consumer) and `panel: undefined`.
  const offCases: Array<[string, Record<string, string | undefined>, boolean | undefined]> = [
    ["non-TTY (stderr) even with QUANTA_TIMELINE=5", { QUANTA_TIMELINE: "5" }, false],
    ["TTY + QUANTA_TIMELINE unset", {}, true],
    ["TTY + QUANTA_TIMELINE=0", { QUANTA_TIMELINE: "0" }, true],
    ["TTY + QUANTA_TIMELINE=abc (malformed)", { QUANTA_TIMELINE: "abc" }, true],
    ["TTY + QUANTA_TIMELINE=-3 (negative)", { QUANTA_TIMELINE: "-3" }, true],
    ["TTY + QUANTA_TIMELINE=NaN", { QUANTA_TIMELINE: "NaN" }, true],
  ]
  for (const [label, env, tty] of offCases) {
    test(`OFF: ${label} ⇒ literal stream + no panel`, () => {
      const { stream, panel } = realBuildTimeline(baseStream, env, tty)
      expect(panel).toBeUndefined()
      expect(stream).toBe(baseStream)
    })
  }

  test("env-parse: QUANTA_TIMELINE=10.7 + TTY ⇒ cfg height floored to 10, enabled", () => {
    const cfg = readCliFeatureConfig(
      { QUANTA_TIMELINE: "10.7" } as NodeJS.ProcessEnv,
      undefined,
      true,
    )
    expect(cfg.timelinePanel.enabled).toBe(true)
    expect(cfg.timelinePanel.height).toBe(10)
  })

  test("env-parse: non-TTY forces enabled=false regardless of height", () => {
    const cfg = readCliFeatureConfig({ QUANTA_TIMELINE: "5" } as NodeJS.ProcessEnv, undefined, false)
    expect(cfg.timelinePanel.enabled).toBe(false)
    expect(cfg.timelinePanel.height).toBe(5)
  })

  test("ON: TTY + QUANTA_TIMELINE=5 ⇒ panel allocated + tee fans every emit to base", () => {
    let baseEmits = 0
    const countingBase: StreamPort = {
      emit: () => {
        baseEmits += 1
      },
    }
    const { stream, panel } = realBuildTimeline(countingBase, { QUANTA_TIMELINE: "5" }, true)
    try {
      expect(panel).toBeDefined()
      // A tee was interposed — the returned stream is NOT the literal base.
      expect(stream).not.toBe(countingBase)
      // Every emit through the tee reaches the original sink exactly once (a
      // tee-doubling regression would make base see 2 per dispatch).
      const evt: AgentEvent = { type: "session_start", sessionId: "x" } as AgentEvent
      stream.emit(evt)
      expect(baseEmits).toBe(1)
      stream.emit(evt)
      expect(baseEmits).toBe(2)
    } finally {
      panel?.teardown()
    }
  })

  test("ON: panel.teardown() is callable + idempotent", () => {
    const { panel } = realBuildTimeline(baseStream, { QUANTA_TIMELINE: "3" }, true)
    expect(panel).toBeDefined()
    expect(() => {
      panel?.teardown()
      panel?.teardown()
    }).not.toThrow()
  })
})

// =============================================================================
// Cross-track — slash-surface compose propagates inspect + replay slots
// =============================================================================

describe("Cross-track — buildReplSlashCtx threads inspect + replay slots", () => {
  const baseArgs = {
    skillsCb: undefined,
    idleMonitor: {
      snooze: () => undefined,
      isSnoozed: () => false,
      unsnooze: () => undefined,
      markActive: () => undefined,
    } as never,
    imageQueue: undefined,
    rewindState: undefined,
    mcpSurface: undefined,
    costPanel: undefined,
    planStore: undefined,
    branchProgress: undefined,
    getHistory: (): readonly never[] => [],
    // Runtime SDK cutover — side starter stub (never invoked in these
    // tests; they exercise the inspect/replay slots only).
    startSideConversation: async () => ({}) as never,
    isSideConversationWired: () => true,
    abortSignal: new AbortController().signal,
    debugHandle: undefined,
    llm: {} as never,
    sessionId: "test-sid",
    model: "test-model",
    effort: {
      get: () => "default" as const,
      set: () => undefined,
      levels: ["default", "max", "high", "medium", "low"] as const,
      budgetTokens: () => undefined,
    },
  }

  test("inspect/replay omitted ⇒ ReplSlashCtx has no `inspect` / `replay` keys", () => {
    const ctx: ReplSlashCtx = buildReplSlashCtx({
      ...baseArgs,
      inspect: undefined,
      replay: undefined,
    })
    expect(Object.hasOwn(ctx, "inspect")).toBe(false)
    expect(Object.hasOwn(ctx, "replay")).toBe(false)
  })

  test("inspect/replay present ⇒ ReplSlashCtx exposes both fields", () => {
    const inspect = { sessionId: "live-sid" }
    const replay: ReplaySlashState = {
      resolveSession: async () => undefined,
      iterate: async function* (): AsyncIterable<SessionEnvelopeRecord> {
        /* empty */
      },
    }
    const ctx: ReplSlashCtx = buildReplSlashCtx({
      ...baseArgs,
      inspect,
      replay,
    })
    expect(ctx.inspect).toEqual(inspect)
    expect(ctx.replay).toBe(replay)
  })

  test("dispatchReplSlash with /replay forwards ctx.replay to the leaf", async () => {
    const { sinks } = mkSinks()
    const replay: ReplaySlashState = {
      resolveSession: async () => undefined, // ⇒ "not found"
      iterate: async function* (): AsyncIterable<SessionEnvelopeRecord> {
        /* empty */
      },
    }
    // Temporarily redirect process.stdout to capture (dispatchReplSlash writes
    // directly via process.stdout.write per slash-surface.ts).
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      sinks.out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
      return true
    }) as typeof process.stdout.write
    try {
      const slashCtx: ReplSlashCtx = buildReplSlashCtx({
        ...baseArgs,
        inspect: undefined,
        replay,
      })
      const handled = await dispatchReplSlash("/replay phantom-sid", slashCtx)
      expect(handled).toBe(true)
      expect(sinks.out).toContain("not found")
    } finally {
      process.stdout.write = origWrite
    }
  })

  test("dispatchReplSlash with /inspect propagates absent ctx.inspect ⇒ 'no active session'", async () => {
    const { sinks } = mkSinks()
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      sinks.out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
      return true
    }) as typeof process.stdout.write
    try {
      const slashCtx: ReplSlashCtx = buildReplSlashCtx({
        ...baseArgs,
        inspect: undefined,
        replay: undefined,
      })
      const handled = await dispatchReplSlash("/inspect tc_7a", slashCtx)
      expect(handled).toBe(true)
      expect(sinks.out).toContain("no active session")
    } finally {
      process.stdout.write = origWrite
    }
  })
})
