/**
 * debug-tracer hellgate — pins the developer-mode trace-line surface.
 *
 * 18+ adversarial cases covering:
 *   - per-variant rendering for 6 AgentEvent kinds (tool_call / tool_result /
 *     decision / usage / llm_request / recovery)
 *   - decision matrix: 4 `kind` × 3 `outcome` permutations
 *   - unknown-type fallback (no throw, line still emitted)
 *   - category filter — `tools` only ⇒ llm / decisions suppressed
 *   - parseDebugEnv 6 inputs: "1" / "tools,llm" / "0" / "off" / undefined /
 *     "tools,bogus,llm"
 *   - color=false strips ANSI completely
 *   - sink injection — process.stderr never touched
 *   - turn=0 + NaN/negative turn clamp
 *   - 500-char reason truncation
 *   - metadata with circular reference does NOT throw
 *
 * Slice-fence: imports ONLY @/stream types and the new tracer module. No
 * wiring (session-setup / repl / status-bar) is touched.
 */

import { describe, expect, test } from "bun:test"
import {
  createDebugTracer,
  type DebugCategory,
  type DebugTracer,
  parseDebugEnv,
} from "../../../src/apps/cli/debug-tracer"
import type { AgentEvent } from "../../../src/stream/types"

// ─── helpers ──────────────────────────────────────────────────────────────

const capture = (): { lines: string[]; sink: (chunk: string) => void } => {
  const lines: string[] = []
  const sink = (chunk: string): void => {
    // Preserve trailing newline boundary — split on "\n" + filter empties.
    for (const piece of chunk.split("\n")) {
      if (piece.length > 0) lines.push(piece)
    }
  }
  return { lines, sink }
}

const makeTracer = (
  overrides: Partial<Parameters<typeof createDebugTracer>[0]> = {},
): { trace: DebugTracer; lines: string[] } => {
  const { lines, sink } = capture()
  const trace = createDebugTracer({
    write: sink,
    color: false,
    now: () => 1717000000000, // fixed wall-clock for deterministic ts column
    ...overrides,
  })
  return { trace, lines }
}

// Lint-safe: build the ANSI regex from a non-control codepoint.
const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`)

// ─── per-variant rendering ────────────────────────────────────────────────

describe("debug-tracer · per-variant lines", () => {
  test("tool_call renders name + id", () => {
    const { trace, lines } = makeTracer()
    trace({ type: "tool_call", id: "tc_7a", name: "Read", input: { path: "src/foo.ts" } })
    expect(lines).toHaveLength(1)
    const ln = lines[0] ?? ""
    expect(ln).toContain("tool_call")
    expect(ln).toContain("Read")
    expect(ln).toContain("id=tc_7a")
  })

  test("tool_result renders ok + bytes + id", () => {
    const { trace, lines } = makeTracer()
    trace({
      type: "tool_result",
      id: "tc_7a",
      name: "Read",
      ok: true,
      preview: "x".repeat(1500),
      durationMs: 23,
    })
    expect(lines).toHaveLength(1)
    const ln = lines[0] ?? ""
    expect(ln).toContain("tool_result")
    expect(ln).toContain("ok=true")
    expect(ln).toContain("KB")
    expect(ln).toContain("23ms")
    expect(ln).toContain("id=tc_7a")
  })

  test("decision renders kind=outcome + reason + toolCallId", () => {
    const { trace, lines } = makeTracer()
    trace({
      type: "decision",
      turn: 3,
      kind: "permission",
      outcome: "allow",
      reason: "default-allow",
      toolCallId: "tc_7a",
    })
    expect(lines).toHaveLength(1)
    const ln = lines[0] ?? ""
    expect(ln).toContain("decision")
    expect(ln).toContain("permission=allow")
    expect(ln).toContain('"default-allow"')
    expect(ln).toContain("tc_7a")
  })

  test("usage renders in/out (+ cache when present)", () => {
    const { trace, lines } = makeTracer()
    trace({
      type: "usage",
      inputTokens: 9259,
      outputTokens: 28,
      cacheReadTokens: 8100,
      model: "gpt-5",
    })
    expect(lines).toHaveLength(1)
    const ln = lines[0] ?? ""
    expect(ln).toContain("usage")
    expect(ln).toContain("in=9259")
    expect(ln).toContain("out=28")
    expect(ln).toContain("cache=8100")
  })

  test("llm_request renders model + provider", () => {
    const { trace, lines } = makeTracer()
    trace({ type: "llm_request", model: "gpt-5", provider: "openai" })
    expect(lines).toHaveLength(1)
    const ln = lines[0] ?? ""
    expect(ln).toContain("llm_request")
    expect(ln).toContain("model=gpt-5")
    expect(ln).toContain("provider=openai")
  })

  test("recovery renders reason + truncated detail", () => {
    const { trace, lines } = makeTracer()
    trace({ type: "recovery", reason: "backoff", detail: "rate-limit retry in 1s" })
    expect(lines).toHaveLength(1)
    const ln = lines[0] ?? ""
    expect(ln).toContain("recovery")
    expect(ln).toContain("backoff")
    expect(ln).toContain("rate-limit")
  })
})

// ─── decision matrix (4 kinds × 3 outcomes = 12 perms, sample 5) ──────────

describe("debug-tracer · decision kind×outcome", () => {
  const kinds = ["permission", "rule", "hook", "cap"] as const
  const outcomes = ["allow", "deny", "ask"] as const

  for (const k of kinds) {
    test(`kind=${k} renders for outcome=allow`, () => {
      const { trace, lines } = makeTracer()
      trace({ type: "decision", turn: 1, kind: k, outcome: "allow", reason: "r" })
      expect(lines).toHaveLength(1)
      expect(lines[0] ?? "").toContain(`${k}=allow`)
    })
  }

  for (const o of outcomes) {
    test(`outcome=${o} renders for kind=permission`, () => {
      const { trace, lines } = makeTracer()
      trace({ type: "decision", turn: 1, kind: "permission", outcome: o, reason: "r" })
      expect(lines).toHaveLength(1)
      expect(lines[0] ?? "").toContain(`permission=${o}`)
    })
  }
})

// ─── fallback + filter + sanitization ─────────────────────────────────────

describe("debug-tracer · safety + filtering", () => {
  test("unknown event type → fallback line, no throw", () => {
    const { trace, lines } = makeTracer()
    // Cast: we intentionally feed a shape outside the closed AgentEvent
    // union to prove forward-compat resilience.
    const surprise = { type: "future_event", turn: 5, weird: "value" } as unknown as AgentEvent
    expect(() => trace(surprise)).not.toThrow()
    expect(lines).toHaveLength(1)
    expect(lines[0] ?? "").toContain("future_event")
  })

  test("category filter — tools only suppresses llm + decisions", () => {
    const { trace, lines } = makeTracer({ categories: new Set<DebugCategory>(["tools"]) })
    trace({ type: "tool_call", id: "tc1", name: "Read", input: {} })
    trace({ type: "llm_request", model: "gpt-5" })
    trace({ type: "decision", turn: 1, kind: "permission", outcome: "allow", reason: "x" })
    expect(lines).toHaveLength(1)
    expect(lines[0] ?? "").toContain("tool_call")
  })

  test("color=false yields no ANSI escapes (any variant)", () => {
    const { trace, lines } = makeTracer({ color: false })
    trace({ type: "tool_call", id: "x", name: "Read", input: {} })
    trace({ type: "decision", turn: 1, kind: "rule", outcome: "deny", reason: "blocked" })
    trace({ type: "usage", inputTokens: 1, outputTokens: 1, model: "m" })
    for (const ln of lines) expect(ANSI_RE.test(ln)).toBe(false)
  })

  test("sink injection — process.stderr untouched", () => {
    // Spy: replace process.stderr.write with a counting stub; verify the
    // tracer's injected sink absorbed everything.
    let stderrCalls = 0
    const original = process.stderr.write.bind(process.stderr)
    // biome-ignore lint/suspicious/noExplicitAny: targeted spy
    ;(process.stderr as any).write = (..._args: unknown[]): boolean => {
      stderrCalls++
      return true
    }
    try {
      const { trace, lines } = makeTracer()
      trace({ type: "tool_call", id: "tc", name: "Bash", input: { command: "ls" } })
      trace({ type: "usage", inputTokens: 1, outputTokens: 1, model: "m" })
      expect(lines).toHaveLength(2)
      expect(stderrCalls).toBe(0)
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      ;(process.stderr as any).write = original
    }
  })

  test("turn=0 event renders [t0]", () => {
    const { trace, lines } = makeTracer()
    trace({ type: "turn_start", turn: 0 })
    expect(lines[0] ?? "").toContain("[t0]")
  })

  test("NaN turn clamps to [t0]", () => {
    const { trace, lines } = makeTracer()
    trace({ type: "turn_start", turn: Number.NaN })
    expect(lines[0] ?? "").toContain("[t0]")
  })

  test("negative turn clamps to [t0]", () => {
    const { trace, lines } = makeTracer()
    trace({ type: "turn_start", turn: -7 })
    expect(lines[0] ?? "").toContain("[t0]")
  })

  test("500-char reason truncates without crash", () => {
    const long = "x".repeat(500)
    const { trace, lines } = makeTracer()
    trace({ type: "decision", turn: 1, kind: "rule", outcome: "deny", reason: long })
    expect(lines).toHaveLength(1)
    const ln = lines[0] ?? ""
    // Reason is wrapped in quotes; the body inside must be ≤ ~80 chars.
    const quoted = /"([^"]*)"/.exec(ln)
    expect(quoted).not.toBeNull()
    if (quoted) expect(quoted[1]?.length).toBeLessThanOrEqual(81)
  })

  test("metadata with circular reference does not throw", () => {
    const md: Record<string, unknown> = { a: 1 }
    md.self = md // circular
    const { trace, lines } = makeTracer()
    expect(() =>
      trace({
        type: "decision",
        turn: 2,
        kind: "hook",
        outcome: "ask",
        reason: "review",
        metadata: md,
      }),
    ).not.toThrow()
    expect(lines).toHaveLength(1)
    expect(lines[0] ?? "").toContain("hook=ask")
  })
})

// ─── parseDebugEnv ────────────────────────────────────────────────────────

describe("parseDebugEnv", () => {
  test('"1" enables all categories (no filter set)', () => {
    const r = parseDebugEnv("1")
    expect(r.enabled).toBe(true)
    expect(r.categories).toBeUndefined()
  })

  test('"tools,llm" enables only those two', () => {
    const r = parseDebugEnv("tools,llm")
    expect(r.enabled).toBe(true)
    expect(r.categories?.has("tools")).toBe(true)
    expect(r.categories?.has("llm")).toBe(true)
    expect(r.categories?.has("decisions")).toBe(false)
  })

  test('"0" disables', () => {
    expect(parseDebugEnv("0").enabled).toBe(false)
  })

  test('"off" disables', () => {
    expect(parseDebugEnv("off").enabled).toBe(false)
  })

  test("undefined disables", () => {
    expect(parseDebugEnv(undefined).enabled).toBe(false)
  })

  test('"tools,bogus,llm" silently drops bogus and keeps real ones', () => {
    const r = parseDebugEnv("tools,bogus,llm")
    expect(r.enabled).toBe(true)
    expect(r.categories?.size).toBe(2)
    expect(r.categories?.has("tools")).toBe(true)
    expect(r.categories?.has("llm")).toBe(true)
  })

  test('"bogus" alone yields disabled (no real categories)', () => {
    // Defensive: don't enable an empty filter — that would dead-letter every
    // event, which is the worst-of-both-worlds posture (tracer "on" but
    // nothing prints).
    expect(parseDebugEnv("bogus").enabled).toBe(false)
  })
})
