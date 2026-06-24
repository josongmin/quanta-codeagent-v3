/**
 * Unit tests for the `knobs_applied` AgentEvent telemetry + recorder
 * forwarding contract.
 *
 * Test isolation: tests touch ONLY the event shape + JSONL recorder + stdout
 * adapter — the bench-side `resolveBenchKnobs` projection is covered
 * separately in `tests/unit/bench-knob-wiring.test.ts`. This keeps the file
 * registry-neutral (no knob-module imports, no global `__resetRegistry` /
 * `registerKnob` side effects that would interfere with hellgate suites).
 *
 * Scope (closed-port, no real bench):
 *   - The event variant exists in the `AgentEvent` closed union (compile
 *     check + a captured-emit runtime check).
 *   - The `JsonlRecorder` writes ONE JSONL line per event, with the recovery
 *     trajectory kind and a `reason:"knobs_applied"` data discriminator.
 *   - Optional fields (preset) ride as JSON `null` (NOT optional) — the wire
 *     shape is the source of truth for cross-run comparison.
 *   - Stdout adapter renders a one-line dim status (no crash on the new
 *     variant — exhaustiveness pin would have failed at compile time).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentEvent, JsonlRecorder, StdoutStream } from "@/stream"

describe("knobs_applied AgentEvent variant", () => {
  test("constructs with all required fields (compile-time contract)", () => {
    // The `: AgentEvent` annotation IS the assertion: it pins this literal
    // against the production closed union (required fields, surface enum,
    // preset:string|null). Runtime expect()s on the same literals just written
    // would be x===x tautologies — the typecheck delivers the only real pin.
    const _event: AgentEvent = {
      type: "knobs_applied",
      surface: "bench",
      knobs: { lsp: { value: true, unit: undefined, display: "on", source: "env" } },
      preset: null,
      costMultiplier: 1,
    }
    void _event
  })

  test("preset is string | null — null is the absent sentinel, NOT optional", () => {
    // Compile-time pin: both a string preset AND `null` must typecheck against
    // `: AgentEvent`, while OMITTING `preset` must NOT (it is non-optional).
    // That string|null-but-required shape is the contract; runtime expect()s on
    // the just-written literals add nothing.
    const _withPreset: AgentEvent = {
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: "agentless-full",
      costMultiplier: 0,
    }
    const _withoutPreset: AgentEvent = {
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: null,
      costMultiplier: 0,
    }
    void _withPreset
    void _withoutPreset
  })

  test("empty knobs record is a valid payload (matrix baseline)", () => {
    // Compile-time pin: an empty `{}` knobs map satisfies the `: AgentEvent`
    // shape. The on-the-wire empty-object behavior (knobs:{} not absent) is
    // exercised for real by the JsonlRecorder test below ("empty knobs map ⇒
    // knobs:{} on the wire"). Object.keys({})===[] / costMultiplier===0 here
    // would only test JS builtins, so they are dropped.
    const _event: AgentEvent = {
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: null,
      costMultiplier: 0,
    }
    void _event
  })

  test("surface mirror accepts the 5-surface closed enum", () => {
    // Compile-time pin: each of the 5 surface strings must typecheck against
    // the `surface: SurfaceMirror` field of `: AgentEvent`. If SurfaceMirror
    // drops/renames a surface, one of these assignments fails to compile.
    // `event.surface === surface` at runtime would be x===x, so it is dropped.
    const surfaces = ["bench", "cli", "agent-batch", "agent-interactive", "ide"] as const
    for (const surface of surfaces) {
      const _event: AgentEvent = {
        type: "knobs_applied",
        surface,
        knobs: {},
        preset: null,
        costMultiplier: 0,
      }
      void _event
    }
  })
})

describe("JsonlRecorder writes a knobs_applied line", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knobs-applied-recorder-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("recovery kind + reason:knobs_applied + full payload", () => {
    const path = join(dir, "run.jsonl")
    const rec = new JsonlRecorder(path, { strict: true, now: () => 1, monotonic: () => 1 })
    rec.emit({ type: "turn_start", turn: 1 })
    rec.emit({
      type: "knobs_applied",
      surface: "bench",
      knobs: {
        lsp: { value: true, unit: undefined, display: "on", source: "env" },
        "branch-search": { value: { defaultN: 3 }, unit: "candidates", display: "3 candidates", source: "env" },
      },
      preset: "agentless-full",
      costMultiplier: 9,
    })
    rec.close()
    const lines = readFileSync(path, "utf8").trim().split("\n")
    expect(lines.length).toBe(2)
    const turnLine = JSON.parse(lines[0] ?? "{}")
    const knobsLine = JSON.parse(lines[1] ?? "{}") as {
      kind: string
      data: Record<string, unknown>
    }
    expect(turnLine.kind).toBe("turn_start")
    expect(knobsLine.kind).toBe("recovery")
    expect(knobsLine.data.reason).toBe("knobs_applied")
    expect(knobsLine.data.surface).toBe("bench")
    expect(knobsLine.data.preset).toBe("agentless-full")
    expect(knobsLine.data.costMultiplier).toBe(9)
    expect(knobsLine.data.knobs).toEqual({
      lsp: { value: true, unit: undefined, display: "on", source: "env" },
      "branch-search": { value: { defaultN: 3 }, unit: "candidates", display: "3 candidates", source: "env" },
    })
  })

  test("null preset serialises as JSON null (not omitted)", () => {
    const path = join(dir, "run.jsonl")
    const rec = new JsonlRecorder(path, { strict: true, now: () => 1 })
    rec.emit({
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: null,
      costMultiplier: 0,
    })
    rec.close()
    const line = readFileSync(path, "utf8").trim()
    const parsed = JSON.parse(line) as { data: { preset: unknown } }
    expect(parsed.data.preset).toBeNull()
    expect(line.includes('"preset":null')).toBe(true)
  })

  test("empty knobs map ⇒ knobs:{} on the wire (empty object, not absent)", () => {
    const path = join(dir, "run.jsonl")
    const rec = new JsonlRecorder(path, { strict: true, now: () => 1 })
    rec.emit({
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: null,
      costMultiplier: 0,
    })
    rec.close()
    const line = readFileSync(path, "utf8").trim()
    expect(line.includes('"knobs":{}')).toBe(true)
  })
})

describe("StdoutStream renders the new variant (graceful skip pin)", () => {
  test("emits a one-line dim status; never throws on the new branch", () => {
    let out = ""
    const stream = new StdoutStream({
      write: (chunk: string) => {
        out += chunk
      },
    })
    stream.emit({
      type: "knobs_applied",
      surface: "bench",
      knobs: { lsp: { value: true, unit: undefined, display: "on", source: "env" } },
      preset: null,
      costMultiplier: 1,
    })
    expect(out).toContain("knobs_applied")
    expect(out).toContain("bench")
    expect(out).toContain("1 active")
    expect(out).toContain("1× cost")
    expect(out).not.toContain("undefined")
  })

  test("non-null preset is shown in the line", () => {
    let out = ""
    const stream = new StdoutStream({
      write: (chunk: string) => {
        out += chunk
      },
    })
    stream.emit({
      type: "knobs_applied",
      surface: "bench",
      knobs: { lsp: { value: true, unit: undefined, display: "on", source: "env" } },
      preset: "agentless-full",
      costMultiplier: 1,
    })
    expect(out).toContain("preset=agentless-full")
  })
})
