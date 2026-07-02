/**
 * Track D hellgate — runtime → REPL context wire, the REPL RETAIN + EXPOSE side.
 *
 * Pins:
 *  - `createContextUsageHolder().view()` returns undefined before any snapshot
 *    (no turn yet) ⇒ `/context` falls back to the legacy placeholder line.
 *  - After `sink(snapshot)`, `view()` returns the segmented usage view whose
 *    per-category tokens are computed by the loop's OWN estimator; `/context`
 *    renders the segmented bar (NOT the fallback).
 *  - `buildReplSlashCtx` wires the `contextUsage` slot ⇒ projection forwards it
 *    onto the SlashContext so `/context` reads it; absent ⇒ slot omitted.
 *  - The latest snapshot WINS (holder keeps only the most recent).
 */
import { describe, expect, test } from "bun:test"
import type { PromptAssembledSnapshot } from "../../../src/agent/context/usage-breakdown"
import { buildSectionedSystemBlocks, fourSectionPreset } from "../../../src/agent/prompt-sections"
import type { IdleMonitor } from "../../../src/apps/cli/idle-monitor"
import { createContextUsageHolder } from "../../../src/apps/cli/repl/context-usage-snapshot"
import {
  type BuildReplSlashCtxArgs,
  buildReplSlashCtx,
} from "../../../src/apps/cli/repl/slash-surface"
import { runSlashCommand } from "../../../src/apps/cli/slash-commands"

const fakeIdle = (): IdleMonitor =>
  ({
    snooze: () => {},
    unsnooze: () => {},
    isSnoozed: () => false,
    markActive: () => {},
    isIdle: () => false,
    idleFor: () => 0,
  }) as unknown as IdleMonitor

const minimalArgs = (): BuildReplSlashCtxArgs => ({
  skillsCb: undefined,
  idleMonitor: fakeIdle(),
  imageQueue: undefined,
  rewindState: undefined,
  mcpSurface: undefined,
  costPanel: undefined,
  planStore: undefined,
  branchProgress: undefined,
  getHistory: () => [],
  startSideConversation: (async () =>
    ({}) as never) as BuildReplSlashCtxArgs["startSideConversation"],
  isSideConversationWired: () => true,
  abortSignal: new AbortController().signal,
  debugHandle: undefined,
  llm: {} as BuildReplSlashCtxArgs["llm"],
  sessionId: "ctx-sess-1",
  model: "test-model",
  inspect: undefined,
  replay: undefined,
  effort: {
    get: () => "medium",
    set: () => {},
    levels: ["low", "medium", "high"] as const,
    budgetTokens: () => undefined,
  },
})

const snapshot = (over: Partial<PromptAssembledSnapshot> = {}): PromptAssembledSnapshot => ({
  system: buildSectionedSystemBlocks(
    fourSectionPreset({
      base: "x".repeat(400),
      projectMd: "y".repeat(200),
      sessionCtx: "z".repeat(300),
    }),
  ),
  layout: "four_section",
  repoRulesPresent: true,
  sessionCtxPresent: true,
  userAppendPresent: false,
  max: 200_000,
  model: "test-model",
  ...over,
})

const collect = () => {
  const out: string[] = []
  return { out, outFn: (s: string) => out.push(s), text: () => out.join("") }
}

describe("Track D REPL holder — retain + expose", () => {
  test("view() is undefined before the first snapshot", () => {
    const holder = createContextUsageHolder()
    expect(holder.view()).toBeUndefined()
  })

  test("view() returns a segmented view after a snapshot, tokens from the loop estimator", () => {
    const holder = createContextUsageHolder()
    holder.sink(snapshot())
    const view = holder.view()
    expect(view).toBeDefined()
    if (view === undefined) return
    expect(view.total).toBeGreaterThan(0)
    expect(view.total).toBe(view.segments.reduce((a, s) => a + s.tokens, 0))
    expect(view.max).toBe(200_000)
    expect(view.model).toBe("test-model")
    // Categories present: System (base), Rules (project_md), Conversation (session_ctx).
    const ids = view.segments.map((s) => s.id)
    expect(ids).toContain("System")
    expect(ids).toContain("Rules")
    expect(ids).toContain("Conversation")
  })

  test("latest snapshot wins", () => {
    const holder = createContextUsageHolder()
    holder.sink(
      snapshot({
        system: buildSectionedSystemBlocks(fourSectionPreset({ base: "a".repeat(40) })),
        layout: "single_block",
        repoRulesPresent: false,
        sessionCtxPresent: false,
      }),
    )
    const small = holder.view()?.total ?? 0
    holder.sink(snapshot())
    const big = holder.view()?.total ?? 0
    expect(big).toBeGreaterThan(small)
  })
})

describe("S3 — reasoning-token split threaded through the holder to /context", () => {
  test("observeUsage threads reasoningTokens onto view() (wire→gauge, not inert)", () => {
    const holder = createContextUsageHolder()
    holder.sink(snapshot())
    // Before any usage observation the split is absent (Anthropic byte-identical).
    expect("reasoningTokens" in (holder.view() ?? {})).toBe(false)
    holder.observeUsage({ reasoningTokens: 4200 })
    const view = holder.view()
    expect(view?.reasoningTokens).toBe(4200)
  })

  test("view() omits reasoningTokens when the provider reported no split (absent, not 0)", () => {
    const holder = createContextUsageHolder()
    holder.sink(snapshot())
    holder.observeUsage({}) // usage event with no split (Anthropic)
    const view = holder.view()
    expect("reasoningTokens" in (view ?? {})).toBe(false)
  })

  test("an explicit zero split is retained verbatim (not dropped by a truthiness guard)", () => {
    const holder = createContextUsageHolder()
    holder.sink(snapshot())
    holder.observeUsage({ reasoningTokens: 0 })
    // Retained as a real datum (view carries 0) — the gauge omits it downstream,
    // but the holder must not fabricate/drop the provider's explicit 0.
    expect(holder.view()?.reasoningTokens).toBe(0)
  })

  test("/context RENDERS the reasoning annotation end-to-end once observed (render-root proof)", async () => {
    const holder = createContextUsageHolder()
    holder.sink(snapshot())
    holder.observeUsage({ reasoningTokens: 12_000 })
    const ctx = buildReplSlashCtx({ ...minimalArgs(), contextUsage: () => holder.view() })
    const c = collect()
    const exit = await runSlashCommand("/context", {
      out: c.outFn,
      err: () => {},
      cwd: process.cwd(),
      ...(ctx.contextUsage !== undefined ? { contextUsage: ctx.contextUsage } : {}),
    })
    expect(exit).toBe(0)
    const text = c.text()
    // The distinct output-side annotation is present, and the split is NOT summed
    // into any input-context segment total.
    expect(text).toContain("Reasoning")
    expect(text).toContain("12.0k")
  })

  test("/context OMITS the reasoning line when no split was observed (byte-identical)", async () => {
    const holder = createContextUsageHolder()
    holder.sink(snapshot())
    const ctx = buildReplSlashCtx({ ...minimalArgs(), contextUsage: () => holder.view() })
    const c = collect()
    await runSlashCommand("/context", {
      out: c.outFn,
      err: () => {},
      cwd: process.cwd(),
      ...(ctx.contextUsage !== undefined ? { contextUsage: ctx.contextUsage } : {}),
    })
    expect(c.text()).not.toContain("Reasoning")
  })
})

describe("Track D /context slash — render vs fallback", () => {
  test("contextUsage absent ⇒ /context prints the legacy fallback", async () => {
    const ctx = buildReplSlashCtx(minimalArgs())
    expect(ctx.contextUsage).toBeUndefined()
    const c = collect()
    const exit = await runSlashCommand("/context", {
      out: c.outFn,
      err: () => {},
      cwd: process.cwd(),
    })
    expect(exit).toBe(0)
    expect(c.text()).toContain("no prompt assembled yet")
  })

  test("contextUsage wired but no snapshot ⇒ /context still falls back", async () => {
    const holder = createContextUsageHolder()
    const ctx = buildReplSlashCtx({ ...minimalArgs(), contextUsage: () => holder.view() })
    expect(ctx.contextUsage).toBeDefined()
    const c = collect()
    const exit = await runSlashCommand("/context", {
      out: c.outFn,
      err: () => {},
      cwd: process.cwd(),
      ...(ctx.contextUsage !== undefined ? { contextUsage: ctx.contextUsage } : {}),
    })
    expect(exit).toBe(0)
    expect(c.text()).toContain("no prompt assembled yet")
  })

  test("contextUsage wired WITH a retained snapshot ⇒ /context renders segments, NOT the fallback", async () => {
    const holder = createContextUsageHolder()
    holder.sink(snapshot())
    const ctx = buildReplSlashCtx({ ...minimalArgs(), contextUsage: () => holder.view() })
    const c = collect()
    const exit = await runSlashCommand("/context", {
      out: c.outFn,
      err: () => {},
      cwd: process.cwd(),
      ...(ctx.contextUsage !== undefined ? { contextUsage: ctx.contextUsage } : {}),
    })
    expect(exit).toBe(0)
    const text = c.text()
    expect(text).not.toContain("no prompt assembled yet")
    // formatSegmentedUsage emits per-category legend rows.
    expect(text).toContain("System")
    expect(text).toContain("test-model")
  })
})
