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
import { type AgentEvent, JsonlRecorder, StdoutStream, type StreamPort } from "@/stream"

class CapturingStream implements StreamPort {
  events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

describe("knobs_applied AgentEvent variant", () => {
  test("constructs with all required fields (compile-time contract)", () => {
    const event: AgentEvent = {
      type: "knobs_applied",
      surface: "bench",
      knobs: { lsp: { value: true, source: "env" } },
      preset: null,
      costMultiplier: 1,
    }
    expect(event.type).toBe("knobs_applied")
    expect(event.surface).toBe("bench")
    expect(event.preset).toBeNull()
  })

  test("preset is string | null — null is the absent sentinel, NOT optional", () => {
    const withPreset: AgentEvent = {
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: "agentless-full",
      costMultiplier: 0,
    }
    const withoutPreset: AgentEvent = {
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: null,
      costMultiplier: 0,
    }
    expect(withPreset.preset).toBe("agentless-full")
    expect(withoutPreset.preset).toBeNull()
  })

  test("empty knobs record is a valid payload (matrix baseline)", () => {
    const event: AgentEvent = {
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: null,
      costMultiplier: 0,
    }
    expect(Object.keys(event.knobs)).toEqual([])
    expect(event.costMultiplier).toBe(0)
  })

  test("surface mirror accepts the 5-surface closed enum", () => {
    const surfaces = ["bench", "cli", "agent-batch", "agent-interactive", "ide"] as const
    for (const surface of surfaces) {
      const event: AgentEvent = {
        type: "knobs_applied",
        surface,
        knobs: {},
        preset: null,
        costMultiplier: 0,
      }
      expect(event.surface).toBe(surface)
    }
  })
})

describe("CapturingStream forward", () => {
  test("emit appends and preserves the event verbatim", () => {
    const stream = new CapturingStream()
    const event: AgentEvent = {
      type: "knobs_applied",
      surface: "bench",
      knobs: { lsp: { value: true, source: "env" } },
      preset: "agentless-full",
      costMultiplier: 1,
    }
    stream.emit(event)
    expect(stream.events.length).toBe(1)
    expect(stream.events[0]).toBe(event)
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
        lsp: { value: true, source: "env" },
        "branch-search": { value: { defaultN: 3 }, source: "env" },
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
      lsp: { value: true, source: "env" },
      "branch-search": { value: { defaultN: 3 }, source: "env" },
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
      knobs: { lsp: { value: true, source: "env" } },
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
      knobs: { lsp: { value: true, source: "env" } },
      preset: "agentless-full",
      costMultiplier: 1,
    })
    expect(out).toContain("preset=agentless-full")
  })
})
