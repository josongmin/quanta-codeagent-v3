/** biome-ignore-all lint/style/noRestrictedImports: cross-slice e2e hellgate — `slash-commands` + `debug-cmd` are the production surfaces under audit; `@/apps/cli/*` has no public alias (intentional); verbatim source paths match `decision-tracer-e2e-hellgate.test.ts` convention. */
/**
 * Cross-slice integration hellgate — CLI surface composition for the
 * developer-mode debug slice (Track T / I / R).
 *
 * Slices stitched (read-only — no source mutation):
 *   - `@/apps/cli/slash-commands` (real `BUILTINS` registry + `runSlashCommand`)
 *   - `@/apps/cli/debug-cmd`      (runtime toggle)
 *   - `@/apps/cli/inspect-cmd`    (session JSONL inspection)
 *   - `@/apps/cli/replay-cmd`     (session JSONL replay)
 *   - `@/apps/cli/why-cmd`        (meta-LLM reasoning)
 *
 * Story: a real `runSlashCommand(line, ctx)` dispatch walks through the real
 * BUILTINS table to the correct leaf handler. Tests prove the wiring
 * end-to-end:
 *   - the registry contains the 5 new commands at known slots,
 *   - default-OFF (ctx.* === undefined) yields the documented "not wired"
 *     message + exit code,
 *   - the leaves observe the session/LLM stubs through `ctx.*` injection,
 *   - stdout vs stderr separation is enforced (debug tracer only stderr;
 *     /inspect / /replay print to stdout).
 *
 * Only external dependencies are stubbed (LLMPort, session JSONL reader).
 * Everything else — the runtime, the registry, the leaf logic — is the
 * production code.
 */

import { describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent } from "@/llm"
import type { SessionEnvelopeRecord } from "@/session"
import type { DebugCmdState } from "../../src/apps/cli/debug-cmd"
import {
  BUILTINS,
  isSlashCommand,
  runSlashCommand,
  type SlashContext,
} from "../../src/apps/cli/slash-commands"

// ─── helpers ──────────────────────────────────────────────────────────────

const captureIO = (): {
  out: string[]
  err: string[]
  outFn: (s: string) => void
  errFn: (s: string) => void
} => {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    outFn: (s) => out.push(s),
    errFn: (s) => err.push(s),
  }
}

const baseCtx = (
  over: Partial<SlashContext> = {},
): { ctx: SlashContext; io: ReturnType<typeof captureIO> } => {
  const io = captureIO()
  const ctx: SlashContext = {
    out: io.outFn,
    err: io.errFn,
    cwd: "/tmp",
    ...over,
  }
  return { ctx, io }
}

// ─── session JSONL fixtures (for /inspect, /replay) ───────────────────────

const ISO = (n: number): string => new Date(1717000000000 + n).toISOString()

const turnContext = (turn_id: string): SessionEnvelopeRecord => ({
  type: "turn_context",
  schema_version: 2,
  turn_id,
  cwd: "/tmp/x",
  current_date: ISO(0),
  timezone: "UTC",
  approval_policy: "never",
  sandbox_policy: "read-only",
  permission_profile: "default",
  model: "gpt-5",
  personality: "default",
  collaboration_mode: "solo",
  realtime_active: false,
  effort: "medium",
  summary: "",
  user_instructions: "",
  truncation_policy: "none",
  parent_thread_id: null,
  thread_role: "root",
})

const toolInvoke = (
  turn_id: string,
  tool: string,
  input: Record<string, unknown>,
  tsOffset = 1,
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  ts: ISO(tsOffset),
  turn_id,
  kind: "tool_invoke",
  tool,
  input,
})

const decision = (
  turn_id: string,
  gate: "permission" | "rule" | "hook" | "cap" | "jail" | "budget",
  outcome: "allow" | "deny" | "ask",
  reason: string,
  toolCallId: string,
  tsOffset = 2,
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  ts: ISO(tsOffset),
  turn_id,
  kind: "decision",
  gate,
  outcome,
  decision_reason: reason,
  tool_call_id: toolCallId,
})

const toolResult = (
  turn_id: string,
  tool: string,
  ok: boolean,
  output: string,
  tsOffset = 3,
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  ts: ISO(tsOffset),
  turn_id,
  kind: "tool_result",
  tool,
  ok,
  output,
})

const userMessage = (turn_id: string, content: string, tsOffset = 0): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  ts: ISO(tsOffset),
  turn_id,
  kind: "user_message",
  content,
})

// Session fixture with a known tc_7a in turn "3". The `tool_invoke` envelope
// carries the tool-call id via the conventional `input.toolCallId` slot — that
// is the canonical wire shape `replay-cmd.ts` (`renderToolInvoke`,
// `advanceGate`, `fmtToolInput`) looks at to render `id=tc_7a` and to honour
// `--from tc_X`. The `decision` envelope's `tool_call_id` is used by
// `inspect-cmd`'s projector (which groups by id across kinds) and is kept here
// to exercise that path too — the two ids MUST match per row.
const SESSION_FIXTURE: readonly SessionEnvelopeRecord[] = [
  turnContext("3"),
  userMessage("3", "where is foo defined?"),
  toolInvoke("3", "Read", { path: "src/foo.ts", toolCallId: "tc_7a" }, 1),
  decision("3", "permission", "allow", "default-allow", "tc_7a", 2),
  toolResult("3", "Read", true, "export const foo = 1", 3),
  toolInvoke("3", "Edit", { file: "src/foo.ts", toolCallId: "tc_7b" }, 4),
  decision("3", "permission", "allow", "default-allow", "tc_7b", 5),
  toolResult("3", "Edit", true, "ok", 6),
]

// ─── LLM stub (for /why) ──────────────────────────────────────────────────

const stubLlmWithText = (text: string): LLMPort => ({
  model: "stub-model",
  stream(_input): AsyncIterable<StreamEvent> {
    return (async function* () {
      yield { type: "text_delta", delta: text }
      yield {
        type: "usage",
        inputTokens: 100,
        outputTokens: 50,
        model: "stub-model",
      }
      yield { type: "message_stop", stop_reason: "end_turn" }
    })()
  },
})

// Async iter helper for /replay.
const fromArray =
  (
    records: readonly SessionEnvelopeRecord[],
  ): ((p: string) => AsyncIterable<SessionEnvelopeRecord>) =>
  (_p: string) =>
    (async function* () {
      for (const r of records) yield r
    })()

// ─── case 01-02: /debug status + on ───────────────────────────────────────

describe("CLI surface integration — runSlashCommand dispatch", () => {
  test("case-01: /debug status → leaf prints exact line; state immutable; stderr empty", async () => {
    let currentState: DebugCmdState = { enabled: false }
    const setCalls: DebugCmdState[] = []
    const { ctx, io } = baseCtx({
      debug: {
        get: () => currentState,
        set: (s: DebugCmdState) => {
          currentState = s
          setCalls.push(s)
        },
      },
    })
    const code = await runSlashCommand("/debug status", ctx)
    expect(code).toBe(0)
    // PINNED FORMAT — the exact byte sequence emitted by `renderStatus`. A
    // substring assertion would let a regression that drops " (categories: all)"
    // slip through the gate.
    expect(io.out.join("")).toBe("debug: off (categories: all)\n")
    // status MUST NOT call set (handler returns state===prev by reference).
    expect(setCalls.length).toBe(0)
    // No diagnostics on stderr — `/debug status` is a pure stdout command.
    expect(io.err.join("")).toBe("")
  })

  test("case-02: /debug on → ctx.debug.set called once with enabled:true; exact line", async () => {
    let currentState: DebugCmdState = { enabled: false }
    const setCalls: DebugCmdState[] = []
    const { ctx, io } = baseCtx({
      debug: {
        get: () => currentState,
        set: (s: DebugCmdState) => {
          currentState = s
          setCalls.push(s)
        },
      },
    })
    const code = await runSlashCommand("/debug on", ctx)
    expect(code).toBe(0)
    expect(setCalls.length).toBe(1)
    expect(setCalls[0]?.enabled).toBe(true)
    // No filter set ⇒ "all" categories.
    expect(setCalls[0]?.categories).toBeUndefined()
    expect(io.out.join("")).toBe("debug: on (categories: all)\n")
    expect(io.err.join("")).toBe("")
  })

  test("case-03: /debug tools,llm → set called with categories filter", async () => {
    let currentState: DebugCmdState = { enabled: false }
    const setCalls: DebugCmdState[] = []
    const { ctx, io } = baseCtx({
      debug: {
        get: () => currentState,
        set: (s: DebugCmdState) => {
          currentState = s
          setCalls.push(s)
        },
      },
    })
    const code = await runSlashCommand("/debug tools,llm", ctx)
    expect(code).toBe(0)
    expect(setCalls.length).toBe(1)
    expect(setCalls[0]?.enabled).toBe(true)
    const cats = setCalls[0]?.categories
    expect(cats).toBeDefined()
    if (cats !== undefined) {
      // Cardinality invariant — exactly the requested two cats (no widen, no
      // silent drop). Other names from KNOWN_CATEGORIES must NOT be present.
      expect(cats.size).toBe(2)
      expect(cats.has("tools")).toBe(true)
      expect(cats.has("llm")).toBe(true)
      expect(cats.has("decisions")).toBe(false)
      expect(cats.has("memory")).toBe(false)
      expect(cats.has("plan")).toBe(false)
    }
    // PINNED FORMAT — `formatCategories` sorts alphabetically, joins on ",".
    expect(io.out.join("")).toBe("debug: on (categories: llm,tools)\n")
    expect(io.err.join("")).toBe("")
  })

  // ── /inspect cases ─────────────────────────────────────────────────────

  test("case-04: /inspect tc_7a (ctx.inspect wired) → exact-line panel; stderr empty; tc_7b body absent", async () => {
    const { ctx, io } = baseCtx({
      inspect: {
        sessionId: "sess-1",
        readSessionJsonl: async () => SESSION_FIXTURE,
      },
    })
    const code = await runSlashCommand("/inspect tc_7a", ctx)
    expect(code).toBe(0)
    const text = io.out.join("")
    const lines = text.split("\n")
    // PINNED HEADER — `renderHeader` builds "── tool call <id> ── turn <T> · <dur> · ok ──".
    // We don't paint colour (color !== true) so the line is plain ASCII.
    const header = lines.find((l) => l.startsWith("── tool call tc_7a"))
    expect(header).toBeDefined()
    expect(header).toContain("── tool call tc_7a ──")
    expect(header).toContain(" turn 3 ")
    expect(header).toContain(" ok ")
    // Section labels appear as `<label>` columns in `renderToolInputLines`
    // and `renderDecisionLines` — pin the exact prefix shape.
    expect(text).toContain("  tool       : Read")
    expect(text).toContain("  input      : ")
    expect(text).toContain("  decisions:")
    // Decision row precise prefix — `  · permission · allow  "default-allow"`.
    // ONLY ONE decision row — the tc_7b decision is keyed off `tool_call_id`
    // and MUST NOT leak into the tc_7a panel (the decision-projector matches
    // strictly by id, unlike co-located tool_invokes/results in the same turn).
    expect(text).toMatch(/permission\s+·\s+allow\s+"default-allow"/)
    expect(text.match(/permission\s+·\s+allow/g)?.length).toBe(1)
    // Result row + preview prefix.
    expect(text).toMatch(/^\s*result\s+:.+Read/m)
    expect(text).toMatch(/^\s*preview\s+:.+"export const foo = 1"/m)
    // Panel close-rule — last non-empty line.
    expect(text).toContain("───────────────────────────────────────────")
    // DOCUMENTED projector behavior: `tool_invoke` / `tool_result` envelopes
    // have no on-wire toolCallId field, so the projector co-locates EVERY
    // tool_invoke/result in the same turn into the matched group (see
    // `inspect-source.ts` header). That means tc_7b's Edit tool_invoke and
    // Edit tool_result ARE expected in the tc_7a panel header. We assert the
    // POSITIVE invariant — both tools' invocations surface as separate rows.
    expect(text).toContain("  tool       : Edit")
    // Co-location is keyed on TURN — a turn-4 row would NOT appear. Validate
    // via the absence of the unrelated decision (tc_xx isn't in the fixture).
    expect(text).not.toContain("tc_xx")
    // STDOUT/STDERR separation — /inspect is a stdout-only command.
    expect(io.err.join("")).toBe("")
  })

  test("case-05: /inspect tc_xx (id not present) → 'not found' + exit 1; exact message", async () => {
    const { ctx, io } = baseCtx({
      inspect: {
        sessionId: "sess-1",
        readSessionJsonl: async () => SESSION_FIXTURE,
      },
    })
    const code = await runSlashCommand("/inspect tc_xx", ctx)
    expect(code).toBe(1)
    // PINNED — `runInspectCmd` emits `tool call ${id} not found in session ${sessionId}\n`.
    // The full sentence, not just a substring — a regression that mutates the
    // wording in either direction must be caught.
    expect(io.out.join("")).toBe("tool call tc_xx not found in session sess-1\n")
    // Not-found is a stdout panel, NOT a stderr diagnostic.
    expect(io.err.join("")).toBe("")
  })

  // ── /replay cases ──────────────────────────────────────────────────────

  test("case-06: /replay 01HXY (full session) → CHRONOLOGICAL frame order; exact tail", async () => {
    const { ctx, io } = baseCtx({
      replay: {
        resolveSession: async () => "/fake/path.jsonl",
        iterate: fromArray(SESSION_FIXTURE),
      },
    })
    const code = await runSlashCommand("/replay 01HXY", ctx)
    expect(code).toBe(0)
    const text = io.out.join("")
    expect(text).toContain("── replay session 01HXY ")
    // INVARIANT: chronology — tc_7a's tool_call line appears in the rendered
    // line array BEFORE tc_7b's tool_call line. We assert by LINE INDEX in
    // the split array (not `text.indexOf`, which is byte-position-blind and
    // would also pass if both ids landed on the same line).
    const lines = text.split("\n")
    const idxA = lines.findIndex((l) => l.includes("Read(") && l.includes("tc_7a"))
    const idxB = lines.findIndex((l) => l.includes("Edit(") && l.includes("tc_7b"))
    expect(idxA).toBeGreaterThan(-1)
    expect(idxB).toBeGreaterThan(-1)
    expect(idxA).toBeLessThan(idxB)
    // INVARIANT: tool_result for tc_7a comes BEFORE the tool_call for tc_7b
    // (causal ordering inside a turn — read result → next call).
    const idxRA = lines.findIndex((l) => l.includes("tool_result") && l.includes("(Read)"))
    expect(idxRA).toBeGreaterThan(idxA)
    expect(idxRA).toBeLessThan(idxB)
    // Footer carries frame count — 8 envelopes (turn_context + user_msg + 6
    // event rows). All 8 render lines.
    expect(text).toContain("8 frames")
    // Closed by the footer rule. No diagnostics on stderr.
    expect(io.err.join("")).toBe("")
  })

  test("case-07: /replay 01HXY --at 3 → ONLY turn 3 frames; turn-4 row excluded", async () => {
    const mixed: readonly SessionEnvelopeRecord[] = [
      ...SESSION_FIXTURE,
      toolInvoke("4", "Read", { path: "other.ts", toolCallId: "tc_off" }, 10),
      decision("4", "permission", "allow", "default-allow", "tc_off", 11),
    ]
    const { ctx, io } = baseCtx({
      replay: {
        resolveSession: async () => "/fake/path.jsonl",
        iterate: fromArray(mixed),
      },
    })
    const code = await runSlashCommand("/replay 01HXY --at 3", ctx)
    expect(code).toBe(0)
    const text = io.out.join("")
    // Turn 3 IDs surface — tc_7a was placed in the tool_invoke input field,
    // so renderToolInvoke prints `id=tc_7a` in the trailing column.
    expect(text).toContain("tc_7a")
    expect(text).toContain("tc_7b")
    // Turn 4 ENVELOPE is fully excluded — its tool_invoke carries tc_off via
    // input.toolCallId; we must see ZERO occurrences anywhere in the output.
    expect(text).not.toContain("tc_off")
    expect(text).not.toContain("other.ts")
    // Header carries the `· turn 3 ·` filter banner.
    expect(text).toContain("· turn 3 ")
  })

  test("case-08: /replay 01HXY --from tc_7b → tc_7a tool_invoke + tool_result hidden; tc_7b visible", async () => {
    const { ctx, io } = baseCtx({
      replay: {
        resolveSession: async () => "/fake/path.jsonl",
        iterate: fromArray(SESSION_FIXTURE),
      },
    })
    const code = await runSlashCommand("/replay 01HXY --from tc_7b", ctx)
    expect(code).toBe(0)
    const text = io.out.join("")
    // body starts after the header's first blank line.
    const bodyIdx = text.indexOf("\n\n")
    expect(bodyIdx).toBeGreaterThan(-1)
    const body = text.slice(bodyIdx)
    // PRE-GATE rows MUST NOT appear in the body: tc_7a Read tool_invoke and
    // its tool_result are before the `tc_7b` gate. The decision row for tc_7a
    // is a `decision` envelope kind which `replay-cmd.ts` has no renderer for
    // (it falls through to formatReplayLine's default branch → no id leak).
    expect(body).not.toContain("tc_7a")
    expect(body).not.toContain("export const foo")
    expect(body).not.toContain("Read(")
    // POST-GATE rows ARE visible.
    expect(body).toContain("tc_7b")
    expect(body).toContain("Edit(")
    // Header banner carries `· from tc_7b ·`.
    expect(text).toContain("· from tc_7b ")
  })

  // ── /why cases ─────────────────────────────────────────────────────────

  test("case-09: /why last (LLM stub returns valid JSON) → structured render with all fields in order", async () => {
    const json = JSON.stringify({
      goal: "Locate the foo handler",
      reasoning: ["The user asked where foo is defined", "Read gives line precision"],
      alternatives_considered: ["grep"],
      confidence: "high",
    })
    const llm = stubLlmWithText(json)
    const { ctx, io } = baseCtx({
      why: {
        sessionId: "sess-1",
        model: "stub-model",
        llm,
        readSessionEnvelopes: async () => SESSION_FIXTURE,
      },
    })
    const code = await runSlashCommand("/why last", ctx)
    expect(code).toBe(0)
    const text = io.out.join("")
    const lines = text.split("\n")
    // Header line — `renderReasoning` produces `── why <id> — model meta-query (<model>, <elapsed>, <N tokens>) ──`.
    // Note: `/why last` resolves to tc_7b (last decision in fixture).
    const header = lines.find((l) => l.startsWith("── why tc_7b"))
    expect(header).toBeDefined()
    expect(header).toContain("stub-model")
    expect(header).toContain("tokens")
    // Field rows — exact prefix shape so a renderer regression that drops a
    // label is caught.
    expect(text).toContain(`  goal       : "Locate the foo handler"`)
    expect(text).toContain("  reasoning  :")
    expect(text).toContain("    1. The user asked where foo is defined")
    expect(text).toContain("    2. Read gives line precision")
    expect(text).toContain("  considered :")
    expect(text).toContain("    - grep")
    expect(text).toContain("  confidence : high")
    // ORDER invariant — goal precedes reasoning precedes considered precedes confidence.
    const idxGoal = lines.findIndex((l) => l.includes("goal"))
    const idxReasoning = lines.findIndex((l) => l.includes("reasoning"))
    const idxConsidered = lines.findIndex((l) => l.includes("considered"))
    const idxConfidence = lines.findIndex((l) => l.includes("confidence"))
    expect(idxGoal).toBeGreaterThan(-1)
    expect(idxReasoning).toBeGreaterThan(idxGoal)
    expect(idxConsidered).toBeGreaterThan(idxReasoning)
    expect(idxConfidence).toBeGreaterThan(idxConsidered)
    // SECURITY — the stub LLM's `model` ("stub-model") shows in the header,
    // but no production model id ("gpt-5") from the fixture's turn_context
    // must leak into the `/why` output (it's not consumed by why-cmd).
    expect(text).not.toContain("gpt-5")
  })

  test("case-10: /why last (LLM stub returns prose) → fallback raw render; no structured field labels", async () => {
    const llm = stubLlmWithText("just some prose, not JSON at all")
    const { ctx, io } = baseCtx({
      why: {
        sessionId: "sess-1",
        model: "stub-model",
        llm,
        readSessionEnvelopes: async () => SESSION_FIXTURE,
      },
    })
    const code = await runSlashCommand("/why last", ctx)
    expect(code).toBe(0)
    const text = io.out.join("")
    // PINNED — the fallback line in renderFallback.
    expect(text).toContain("LLM returned unstructured prose; raw output below")
    expect(text).toContain("just some prose, not JSON at all")
    // NEGATIVE invariants — the structured panel labels MUST NOT appear in
    // the fallback path (they'd indicate the JSON parser leaked into the
    // prose branch).
    expect(text).not.toContain("  goal       :")
    expect(text).not.toContain("  reasoning  :")
    expect(text).not.toContain("  considered :")
    expect(text).not.toContain("  confidence :")
    // Header still shows the model + tokens (the LLM round-trip happened).
    expect(text).toContain("stub-model")
    expect(text).toContain("tokens")
  })

  // ── default-OFF: ctx.* undefined ──────────────────────────────────────

  test("case-11: default-OFF (ctx.* undefined) → exact 'not wired' line + exit code + stderr empty", async () => {
    // Each command's documented behaviour when its ctx slot is absent:
    //   /debug   → "not wired (...)" + exit 0
    //   /inspect → "no active session" + exit 1 (needs session)
    //   /replay  → "not wired" + exit 0
    //   /why     → "not wired" + exit 0
    {
      const { ctx, io } = baseCtx()
      const code = await runSlashCommand("/debug status", ctx)
      expect(code).toBe(0)
      // PINNED — the leaf adapter in slash-commands.ts emits this exact line
      // (hint includes QUANTA_DEBUG=1).
      expect(io.out.join("")).toBe(
        "/debug: not wired in this surface (boot with QUANTA_DEBUG=1 to enable runtime toggle)\n",
      )
      expect(io.err.join("")).toBe("")
    }
    {
      const { ctx, io } = baseCtx()
      const code = await runSlashCommand("/inspect tc_anything", ctx)
      expect(code).toBe(1)
      expect(io.out.join("")).toBe(
        "no active session — start an agent first or pass --session <id>\n",
      )
      expect(io.err.join("")).toBe("")
    }
    {
      const { ctx, io } = baseCtx()
      const code = await runSlashCommand("/replay 01HXY", ctx)
      expect(code).toBe(0)
      expect(io.out.join("")).toBe("/replay: not wired in this surface\n")
      expect(io.err.join("")).toBe("")
    }
    {
      const { ctx, io } = baseCtx()
      const code = await runSlashCommand("/why last", ctx)
      expect(code).toBe(0)
      expect(io.out.join("")).toBe("/why: not wired in this surface\n")
      expect(io.err.join("")).toBe("")
    }
  })

  // ── BUILTINS registration invariants ──────────────────────────────────

  test("case-12: BUILTINS registers /debug, /inspect, /replay, /why; each appears exactly once", () => {
    const names = BUILTINS.map((c) => c.name)
    // Membership + cardinality — a duplicate registration would silently
    // shadow the leaf and dispatch goes to whichever entry the byName Map
    // inserted last; this asserts each slash slot is unique.
    for (const n of ["/debug", "/inspect", "/replay", "/why"]) {
      expect(names).toContain(n)
      expect(names.filter((m) => m === n).length).toBe(1)
    }
    // Every registered entry has a non-empty `describe` (the /help renderer
    // iterates BUILTINS and prints `describe` — empty strings degrade the
    // surface badly without crashing).
    for (const c of BUILTINS) {
      expect(c.describe.length).toBeGreaterThan(0)
    }
  })

  test("case-13: zero name collision; every name `/<letter>...` shape; isSlashCommand recognises all", () => {
    const names = BUILTINS.map((c) => c.name)
    const set = new Set(names)
    expect(set.size).toBe(names.length)
    // Defensive: confirm `isSlashCommand` recognises every builtin name.
    for (const n of names) {
      expect(isSlashCommand(n)).toBe(true)
      // Lexical invariant — every slash starts with `/` followed by [a-z] so
      // bare `--flag` argv never collides with the slash gate in
      // `src/apps/cli/index.ts`. Hyphens allowed mid-name (/rewind-tool).
      expect(n).toMatch(/^\/[a-z][a-z0-9-]*$/)
    }
    // NEGATIVE — strings that LOOK like slashes but should NOT match.
    expect(isSlashCommand("/")).toBe(false)
    expect(isSlashCommand("/-foo")).toBe(false)
    expect(isSlashCommand("/-bar")).toBe(false)
    expect(isSlashCommand("--help")).toBe(false)
  })

  // ── stdout vs stderr separation ──────────────────────────────────────

  test("case-14: /inspect not-found → stdout has EXACT not-found line; stderr empty", async () => {
    const { ctx, io } = baseCtx({
      inspect: {
        sessionId: "sess-1",
        readSessionJsonl: async () => SESSION_FIXTURE,
      },
    })
    const code = await runSlashCommand("/inspect tc_missing", ctx)
    expect(code).toBe(1)
    // PINNED message + invariant: panel sink never touches stderr.
    expect(io.out.join("")).toBe("tool call tc_missing not found in session sess-1\n")
    expect(io.err.join("")).toBe("")
  })

  test("case-15: /debug bad-arg → stderr error w/ known-cats; stdout empty; state immutable", async () => {
    let currentState: DebugCmdState = { enabled: false }
    const setCalls: DebugCmdState[] = []
    const { ctx, io } = baseCtx({
      debug: {
        get: () => currentState,
        set: (s) => {
          currentState = s
          setCalls.push(s)
        },
      },
    })
    const code = await runSlashCommand("/debug bogus_category", ctx)
    expect(code).toBe(1)
    // PINNED — exact error prefix + alphabetical known-cats list (the leaf
    // formats from KNOWN_CATEGORIES via [...].sort()).
    const err = io.err.join("")
    expect(err).toContain("/debug: unknown argument 'bogus_category'")
    expect(err).toContain("known categories: decisions, llm, memory, other, plan, stream, tools")
    // INVARIANT — bad-arg leaves stdout completely empty.
    expect(io.out.join("")).toBe("")
    // STATE INVARIANT — bad-arg never calls set(), so the surface ref stays
    // at the prev state (referential equality).
    expect(setCalls.length).toBe(0)
    expect(currentState.enabled).toBe(false)
  })

  test("case-16: runSlashCommand dispatch — unknown command surfaces exact error + Available list", async () => {
    const { ctx, io } = baseCtx()
    const code = await runSlashCommand("/no-such-cmd arg1", ctx)
    expect(code).toBe(1)
    // PINNED — `slash-engine.ts` emits `slash: unknown command: ${name}\n`.
    expect(io.err.join("")).toBe("slash: unknown command: /no-such-cmd\n")
    // The dispatcher renders the available list on stdout — the four slice
    // members + (at least) one other must appear in the list.
    const out = io.out.join("")
    expect(out.startsWith("Available:\n")).toBe(true)
    expect(out).toContain("/debug")
    expect(out).toContain("/inspect")
    expect(out).toContain("/replay")
    expect(out).toContain("/why")
    // Bogus name MUST NOT appear in the available list (sanity — would only
    // be visible if a future registrar accepted arbitrary submissions).
    expect(out).not.toContain("/no-such-cmd")
  })
})
