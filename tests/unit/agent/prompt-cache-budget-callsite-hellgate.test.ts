/**
 * HELLGATE — the section-level cache-budget check at the `prompt.ts` call site
 * is PROVABLY INERT, and the WIRE cap is what actually enforces the budget.
 *
 * ADR-0542 moved enforcement of Anthropic's 4-`cache_control` limit onto the
 * ASSEMBLED request (`capSystemCacheMarkers` / `MAX_ANTHROPIC_CACHE_MARKERS`
 * in `src/llm/anthropic-messages-codec.ts`) and recorded a residual:
 * `buildSystemSections` in `src/agent/prompt.ts` still called
 * `validateSectionsCacheBudget(sections)` and DISCARDED the verdict, under a
 * comment claiming the check "surfaces in dev". It surfaced nowhere.
 *
 * This file is the evidence that decided how to close that residual. It pins
 * two independent facts, and it is written to pass BOTH before and after the
 * call is removed — so the deletion provably loses no coverage:
 *
 *  A. The verdict at that call site is a CONSTANT. `fourSectionPreset` pushes
 *     at most four sections (`base`, `project_md`, `session_ctx`,
 *     `user_append`), so `validateSectionsCacheBudget` returns `{ok:true}` for
 *     EVERY reachable input. Consuming the verdict — logging it, throwing on
 *     it — could not have produced a signal, because the false arm is
 *     unreachable. A `logger.warn` there would be dead code wearing a
 *     different hat.
 *
 *  B. The wire cap SUBSUMES the section check, strictly. The section check
 *     permits 4 cached sections; the wire permits `4 - reserved`, and
 *     `cacheConversationPrefix` reserves one in every real turn — so the live
 *     system budget is 3. Any state the section check could have flagged is
 *     already flagged AND repaired one layer down, on the actual request.
 *
 * Invariants:
 *
 *  A-1  Exhaustive over all 2^4 presence combinations of the optional
 *       caller-data channels: the preset never exceeds MAX_CACHE_BREAKPOINTS
 *       and the verdict is `{ok:true}` in all 16.
 *  A-2  The "cannot exceed 4 by construction" claim is a DRIFT GUARD, not a
 *       comment: a 5th cached section added to the preset breaks this.
 *  A-3  The real `buildTurnContext` front door, driven with every caller-data
 *       channel populated at once (the maximal live prefix), still renders
 *       exactly 4 cached blocks — at the section cap, never over it.
 *  B-1  That same maximal live prefix, driven through the SHIPPED
 *       `AnthropicAdapter`, lands <= 4 markers on the wire — 4 sections + the
 *       conversation breakpoint would be 5.
 *  B-2  The wire also covers the case the section check nominally guarded: a
 *       hand-built 5-cached-section system that `validateSectionsCacheBudget`
 *       DOES reject still lands <= 4 markers on the wire.
 *  B-3  PAIRED CONTROL — the wire cap is not a blanket stripper standing in
 *       for the section check: an already-legal request keeps every marker.
 *  C-1  `validateSectionsCacheBudget` itself is unchanged and still correct on
 *       a hand-built over-budget list. The residual fix removes the CALL, not
 *       the predicate — which stays exported as a pure diagnostic.
 */

import { describe, expect, test } from "bun:test"
import type { TurnContextInput } from "@/agent"
import { buildTurnContext } from "@/agent"
import {
  fourSectionPreset,
  MAX_CACHE_BREAKPOINTS,
  type PromptSection,
  validateSectionsCacheBudget,
} from "@/agent/prompt-sections"
import type { Message, StreamInput, SystemBlock } from "@/llm"
import { AnthropicAdapter } from "@/llm"

/** Anthropic's hard per-request `cache_control` limit, restated locally so
 *  this file asserts against the NUMBER, not against the codec's own constant
 *  (a mutation that widened the constant would otherwise move the goalposts
 *  and the assertion with it). */
const MAX_WIRE_MARKERS = 4

const seed: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }]

const baseInput = (over: Partial<TurnContextInput> = {}): TurnContextInput => ({
  baseMessages: seed,
  cwd: "/repo",
  planMode: false,
  ...over,
})

/** Every caller-data channel populated at once — the MAXIMAL prefix the live
 *  loop can build. `userAppend` has no producer in `src/` today (see the
 *  reachability note in ADR-0542), so this is strictly wider than production. */
const maximalInput = (): TurnContextInput =>
  baseInput({
    repoRules: {
      sourcePath: "/repo/CLAUDE.md",
      entrypoint: "CLAUDE.md",
      body: "PROJECT_RULES",
      loadedAt: 0,
    },
    sessionCtx: "SESSION_CTX",
    memorySummaryMd: "- distilled hint",
    userAppend: "USER_APPEND",
  })

type SysBlock = { type: string; text: string; cache_control?: unknown }
type CreateParams = {
  system?: string | SysBlock[]
  messages: Array<{ role: string; content: unknown }>
  tools?: unknown
}

/** Drive the SHIPPED adapter and capture the params object actually handed to
 *  `messages.create`. Same front-door harness as the C1 wire hellgate — the
 *  assertion is on the real request, not on a re-implementation of it. */
const driveOnce = async (input: StreamInput): Promise<CreateParams> => {
  const adapter = new AnthropicAdapter({ apiKey: "test-key", model: "claude-x" })
  let params: CreateParams | undefined
  const client = (adapter as unknown as { client: { messages: { create: unknown } } }).client
  client.messages.create = (p: CreateParams) => {
    params = p
    const empty = {
      [Symbol.asyncIterator]() {
        return { next: () => Promise.resolve({ done: true as const, value: undefined }) }
      },
    }
    return Promise.resolve(empty)
  }
  for await (const _ of adapter.stream(input)) {
    // drain
  }
  if (params === undefined) throw new Error("create() was not called")
  return params
}

/** Count `cache_control` PROPERTIES anywhere in the request — the same
 *  structural accounting Anthropic applies. Never a substring search over the
 *  serialized text: message CONTENT must not be able to forge a marker
 *  (ADR-0542, pinned upstream by C1-8). */
const markerCount = (v: unknown): number => {
  if (v === null || typeof v !== "object") return 0
  if (Array.isArray(v)) return v.reduce<number>((n, item) => n + markerCount(item), 0)
  let n = 0
  for (const [key, value] of Object.entries(v)) {
    if (key === "cache_control") {
      if (value !== undefined) n++
      continue
    }
    n += markerCount(value)
  }
  return n
}

const requestMarkers = (p: CreateParams): number =>
  markerCount(p.system) + markerCount(p.messages) + markerCount(p.tools)

const inputWith = (system: SystemBlock[], messages: Message[]): StreamInput =>
  ({ system, messages, tools: [] }) as StreamInput

/** A conversation whose LAST message ends in a text block, so
 *  `cacheConversationPrefix` always stamps it: exactly one reserved marker. */
const textTail: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]

const cachedSystem = (...names: readonly string[]): SystemBlock[] =>
  names.map((name) => ({ type: "text", text: name, cache: true }) as SystemBlock)

// ── A — the call site's verdict is a constant ───────────────────────────────

describe("A — the section-level budget verdict at the prompt.ts call site is a CONSTANT", () => {
  test("A-1 exhaustive: no combination of caller-data channels can make the verdict false", () => {
    // All 2^4 presence combinations of the optional channels, as a bitmask
    // table — every input `buildSystemSections` can hand the preset.
    const combos = Array.from({ length: 16 }, (_, mask) =>
      fourSectionPreset({
        base: "BASE",
        ...((mask & 1) !== 0 ? { projectMd: "P" } : {}),
        ...((mask & 2) !== 0 ? { sessionCtx: "S" } : {}),
        ...((mask & 4) !== 0 ? { memorySummaryMd: "M" } : {}),
        ...((mask & 8) !== 0 ? { userAppend: "U" } : {}),
      }),
    )
    expect(combos).toHaveLength(16)
    // Cached-section count per combination, stated as literals so a preset that
    // grows a section moves these numbers. Note masks 6 / 14: `sessionCtx` and
    // `memorySummaryMd` COALESCE onto one `session_ctx` breakpoint (ADR-0068),
    // so having both costs 1, not 2 — which is precisely why four inputs can
    // never buy a fifth cached section.
    const cachedCounts = combos.map((sections) => sections.filter((s) => s.cache).length)
    expect(cachedCounts).toEqual([1, 2, 2, 3, 2, 3, 2, 3, 2, 3, 3, 4, 3, 4, 3, 4])
    expect(Math.max(...cachedCounts)).toBe(MAX_CACHE_BREAKPOINTS)
    // …so the whole residual, in one assertion: the false arm is unreachable,
    // and consuming this verdict could never have signalled.
    expect(combos.map(validateSectionsCacheBudget)).toEqual(
      Array.from({ length: 16 }, () => ({ ok: true })),
    )
  })

  test("A-2 DRIFT GUARD — 'cannot exceed 4 by construction' is enforced, not asserted in prose", () => {
    // The preset's section NAMES are the construction: four slots, no loop, no
    // caller-extensible list. A fifth cached section can only arrive by editing
    // `fourSectionPreset`, and this breaks the moment it does.
    const all = fourSectionPreset({
      base: "BASE",
      projectMd: "P",
      sessionCtx: "S",
      memorySummaryMd: "M",
      userAppend: "U",
    })
    expect(all.map((s) => s.name)).toEqual(["base", "project_md", "session_ctx", "user_append"])
    expect(all).toHaveLength(MAX_CACHE_BREAKPOINTS)
    expect(all.every((s) => s.cache)).toBe(true)
  })

  test("A-3 the real buildTurnContext front door, maximally loaded, sits AT the section cap", () => {
    const { system } = buildTurnContext(maximalInput())
    const cached = system.filter((b) => b.cache)
    expect(cached).toHaveLength(MAX_CACHE_BREAKPOINTS)
    expect(system).toHaveLength(MAX_CACHE_BREAKPOINTS)
    // Same verdict the deleted call computed and threw away.
    const asSections: PromptSection[] = system.map((b, i) => ({
      name: `s${i}`,
      text: b.text,
      cache: b.cache === true,
    }))
    expect(validateSectionsCacheBudget(asSections)).toEqual({ ok: true })
  })
})

// ── B — the wire cap is the real enforcement point ──────────────────────────

describe("B — the WIRE cap enforces the budget the section check could not", () => {
  test("B-1 the maximal live prefix + conversation breakpoint lands <= 4 markers on the wire", async () => {
    const { system, messages } = buildTurnContext(maximalInput())
    // 4 cached sections declared upstream…
    expect(system.filter((b) => b.cache)).toHaveLength(MAX_CACHE_BREAKPOINTS)
    const params = await driveOnce(inputWith([...system], [...messages]))
    // …plus the unconditional conversation marker would be 5. The wire caps it.
    expect(requestMarkers(params)).toBeLessThanOrEqual(MAX_WIRE_MARKERS)
    expect(markerCount(params.messages)).toBe(1)
  })

  test("B-2 a 5-cached-section system — the case the section check nominally guarded — is capped at the wire", async () => {
    const over = cachedSystem("base", "project_md", "session_ctx", "user_append", "fifth")
    // The section-level predicate DOES reject this shape…
    const verdict = validateSectionsCacheBudget(
      over.map((b, i) => ({ name: `s${i}`, text: b.text, cache: true })),
    )
    expect(verdict.ok).toBe(false)
    // …and it is unreachable from `fourSectionPreset` (A-1/A-2). Even so, the
    // wire handles it — with the text intact and no 400.
    const params = await driveOnce(inputWith(over, textTail))
    expect(requestMarkers(params)).toBeLessThanOrEqual(MAX_WIRE_MARKERS)
    const blocks = params.system as SysBlock[]
    expect(blocks.map((b) => b.text)).toEqual([
      "base",
      "project_md",
      "session_ctx",
      "user_append",
      "fifth",
    ])
  })

  test("B-3 PAIRED CONTROL — an already-legal request keeps every marker it declared", async () => {
    const legal = cachedSystem("base", "project_md")
    const params = await driveOnce(inputWith(legal, textTail))
    expect(markerCount(params.system)).toBe(2)
    expect(requestMarkers(params)).toBe(3)
  })
})

// ── C — the predicate survives the call-site deletion ───────────────────────

describe("C — the residual fix removes the CALL, not the predicate", () => {
  test("C-1 validateSectionsCacheBudget still reports count + limit on a hand-built over-budget list", () => {
    const five: PromptSection[] = Array.from({ length: 5 }, (_, i) => ({
      name: `s${i}`,
      text: "t",
      cache: true,
    }))
    expect(validateSectionsCacheBudget(five)).toEqual({
      ok: false,
      cachedCount: 5,
      limit: MAX_CACHE_BREAKPOINTS,
    })
  })

  test("C-1b uncached sections do not consume a breakpoint", () => {
    const mixed: PromptSection[] = Array.from({ length: 6 }, (_, i) => ({
      name: `s${i}`,
      text: "t",
      cache: i < 4,
    }))
    expect(validateSectionsCacheBudget(mixed)).toEqual({ ok: true })
  })
})
