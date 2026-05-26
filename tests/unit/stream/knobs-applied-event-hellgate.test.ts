/**
 * Hellgate — `knobs_applied` AgentEvent + JSONL recorder adversarial battery.
 *
 * Pins:
 *   - Closed-union variant constructs across all 5 surface mirrors.
 *   - `preset` is `string | null` (NOT optional) — null serialises to JSON
 *     null, not omitted.
 *   - `knobs` map is plain object — JSON.stringify is a no-op serialiser.
 *   - Redaction policy DOES apply to `knobs.<id>.value` strings (secrets are
 *     scrubbed deep). This is the slice's value-redaction contract.
 *   - Large knob maps round-trip without truncation.
 *   - Circular references in `value` ⇒ recorder degrades (NO crash to caller
 *     in non-strict mode).
 *   - Unicode / nested arrays / numeric edge cases (Infinity, NaN) round-trip
 *     via JSON in their canonical forms.
 *
 * Slice fence: imports only `@/stream` + node fs primitives.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentEvent, JsonlRecorder } from "@/stream"

describe("hellgate knobs_applied variant — closed-union construction", () => {
  test("5 surfaces are all valid via the SurfaceMirror enum", () => {
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

  test("preset null + string are both legal", () => {
    const a: AgentEvent = {
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: null,
      costMultiplier: 0,
    }
    const b: AgentEvent = {
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: "agentless-full",
      costMultiplier: 1,
    }
    expect(a.preset).toBeNull()
    expect(b.preset).toBe("agentless-full")
  })

  test("preset is NOT optional — undefined would be a type error (runtime mirror)", () => {
    // Compile-time forbidden; verify the explicit null sentinel is preserved.
    const a: AgentEvent = {
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: null,
      costMultiplier: 0,
    }
    expect(Object.hasOwn(a, "preset")).toBe(true)
  })

  test("knobs value supports complex objects (not just primitives)", () => {
    const event: AgentEvent = {
      type: "knobs_applied",
      surface: "bench",
      knobs: {
        "branch-search": { value: { defaultN: 3, strategy: "ucb1" }, source: "env" },
        lsp: { value: true, source: "preset" },
        "issue-hint": { value: 1, source: "default" },
      },
      preset: null,
      costMultiplier: 9,
    }
    expect(Object.keys(event.knobs).length).toBe(3)
    expect((event.knobs["branch-search"]?.value as Record<string, unknown>).defaultN).toBe(3)
  })

  test("costMultiplier supports zero (baseline) and large values", () => {
    const ev0: AgentEvent = {
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: null,
      costMultiplier: 0,
    }
    const evBig: AgentEvent = {
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: null,
      costMultiplier: 1e9,
    }
    expect(ev0.costMultiplier).toBe(0)
    expect(evBig.costMultiplier).toBe(1e9)
  })
})

describe("hellgate JsonlRecorder + knobs_applied — adversarial wire shape", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knobs-applied-hellgate-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const readLine = (path: string): { kind: string; data: Record<string, unknown> } => {
    const raw = readFileSync(path, "utf8").trim()
    return JSON.parse(raw) as { kind: string; data: Record<string, unknown> }
  }

  test("recovery kind + reason discriminator (greppable apart from other recovery lines)", () => {
    const path = join(dir, "r.jsonl")
    const rec = new JsonlRecorder(path, { strict: true, now: () => 1 })
    rec.emit({
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: null,
      costMultiplier: 0,
    })
    rec.close()
    const line = readLine(path)
    expect(line.kind).toBe("recovery")
    expect(line.data.reason).toBe("knobs_applied")
  })

  test("preset null serialises as JSON null (NOT omitted from wire)", () => {
    const path = join(dir, "r.jsonl")
    const rec = new JsonlRecorder(path, { strict: true, now: () => 1 })
    rec.emit({
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: null,
      costMultiplier: 0,
    })
    rec.close()
    const raw = readFileSync(path, "utf8").trim()
    expect(raw.includes('"preset":null')).toBe(true)
  })

  test("preset string preserved verbatim", () => {
    const path = join(dir, "r.jsonl")
    const rec = new JsonlRecorder(path, { strict: true, now: () => 1 })
    rec.emit({
      type: "knobs_applied",
      surface: "cli",
      knobs: {},
      preset: "agentless-full",
      costMultiplier: 1,
    })
    rec.close()
    const line = readLine(path)
    expect(line.data.preset).toBe("agentless-full")
  })

  test("empty knobs map ⇒ knobs:{} on the wire (NOT absent)", () => {
    const path = join(dir, "r.jsonl")
    const rec = new JsonlRecorder(path, { strict: true, now: () => 1 })
    rec.emit({
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: null,
      costMultiplier: 0,
    })
    rec.close()
    const raw = readFileSync(path, "utf8").trim()
    expect(raw.includes('"knobs":{}')).toBe(true)
  })

  test("redaction: secret-key value INSIDE knobs map is scrubbed", () => {
    // The recorder's `makeEvent` runs `redactValue` over `data` end-to-end.
    // `data.knobs.<id>` is a plain record — secret KEY names inside it (e.g.
    // 'token', 'authorization', '*_TOKEN') get masked. Wire policy applies
    // even to opt-in surfaces; the operator must NEVER see a leaked key.
    const path = join(dir, "r.jsonl")
    const rec = new JsonlRecorder(path, { strict: true, now: () => 1 })
    rec.emit({
      type: "knobs_applied",
      surface: "bench",
      knobs: {
        // Note: `id` field uses normal kebab-case; the `value` inner record
        // contains a key named `token` which IS the redacted target.
        "leaky-knob": { value: { token: "sk-some-real-looking-key-12345" }, source: "env" },
      },
      preset: null,
      costMultiplier: 1,
    })
    rec.close()
    const line = readLine(path)
    const knobs = line.data.knobs as Record<string, { value: Record<string, unknown> }>
    expect(knobs["leaky-knob"]?.value.token).toBe("***REDACTED***")
  })

  test("redaction: secret-looking VALUE (sk- prefix) scrubbed even under benign key", () => {
    // The string-form regex (`sk-…`) fires on the VALUE regardless of key.
    const path = join(dir, "r.jsonl")
    const rec = new JsonlRecorder(path, { strict: true, now: () => 1 })
    rec.emit({
      type: "knobs_applied",
      surface: "bench",
      knobs: {
        // `extra` is NOT a secret key, but the string value matches sk- regex.
        sneaky: { value: { extra: "sk-AAAAAAAAAAAAAAAA" }, source: "env" },
      },
      preset: null,
      costMultiplier: 1,
    })
    rec.close()
    const line = readLine(path)
    const knobs = line.data.knobs as Record<string, { value: Record<string, unknown> }>
    expect(knobs.sneaky?.value.extra).toBe("***REDACTED***")
  })

  test("non-secret nested data passes through unchanged", () => {
    const path = join(dir, "r.jsonl")
    const rec = new JsonlRecorder(path, { strict: true, now: () => 1 })
    rec.emit({
      type: "knobs_applied",
      surface: "bench",
      knobs: {
        "branch-search": { value: { defaultN: 3, strategy: "ucb1" }, source: "preset" },
      },
      preset: "agentless-full",
      costMultiplier: 9,
    })
    rec.close()
    const line = readLine(path)
    const knobs = line.data.knobs as Record<string, { value: Record<string, unknown> }>
    expect(knobs["branch-search"]?.value.defaultN).toBe(3)
    expect(knobs["branch-search"]?.value.strategy).toBe("ucb1")
  })

  test("unicode knob id preserved", () => {
    const path = join(dir, "r.jsonl")
    const rec = new JsonlRecorder(path, { strict: true, now: () => 1 })
    rec.emit({
      type: "knobs_applied",
      surface: "bench",
      knobs: {
        "한글-knob": { value: true, source: "env" },
      },
      preset: null,
      costMultiplier: 1,
    })
    rec.close()
    const line = readLine(path)
    const knobs = line.data.knobs as Record<string, { value: unknown }>
    expect(Object.keys(knobs)).toContain("한글-knob")
  })

  test("large knob map (200 entries) round-trips intact", () => {
    const path = join(dir, "r.jsonl")
    const rec = new JsonlRecorder(path, { strict: true, now: () => 1 })
    const knobs: Record<string, { value: number; source: string }> = {}
    for (let i = 0; i < 200; i++) knobs[`k-${i}`] = { value: i, source: "env" }
    rec.emit({
      type: "knobs_applied",
      surface: "bench",
      knobs,
      preset: null,
      costMultiplier: 200,
    })
    rec.close()
    const line = readLine(path)
    expect(Object.keys(line.data.knobs as Record<string, unknown>).length).toBe(200)
  })

  test("Infinity costMultiplier ⇒ JSON null on the wire (JSON.stringify quirk)", () => {
    // JSON.stringify maps Infinity/NaN to null. This is INHERITED behaviour
    // from the standard; the recorder does not pre-scrub. Pinning so a
    // future refactor sees the design.
    const path = join(dir, "r.jsonl")
    const rec = new JsonlRecorder(path, { strict: true, now: () => 1 })
    rec.emit({
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: null,
      costMultiplier: Number.POSITIVE_INFINITY,
    })
    rec.close()
    const raw = readFileSync(path, "utf8").trim()
    expect(raw.includes('"costMultiplier":null')).toBe(true)
  })

  test("NaN costMultiplier ⇒ JSON null (same quirk pin)", () => {
    const path = join(dir, "r.jsonl")
    const rec = new JsonlRecorder(path, { strict: true, now: () => 1 })
    rec.emit({
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: null,
      costMultiplier: Number.NaN,
    })
    rec.close()
    const raw = readFileSync(path, "utf8").trim()
    expect(raw.includes('"costMultiplier":null')).toBe(true)
  })

  test("circular reference in knob value ⇒ strict mode rethrows (NOT silent)", () => {
    const path = join(dir, "r.jsonl")
    const rec = new JsonlRecorder(path, { strict: true, now: () => 1 })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() =>
      rec.emit({
        type: "knobs_applied",
        surface: "bench",
        knobs: { cycle: { value: cyclic, source: "env" } },
        preset: null,
        costMultiplier: 0,
      }),
    ).toThrow()
    rec.close()
  })

  test("circular reference in non-strict mode ⇒ degrades, no throw to caller", () => {
    const path = join(dir, "r.jsonl")
    const rec = new JsonlRecorder(path, { strict: false, now: () => 1 })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() =>
      rec.emit({
        type: "knobs_applied",
        surface: "bench",
        knobs: { cycle: { value: cyclic, source: "env" } },
        preset: null,
        costMultiplier: 0,
      }),
    ).not.toThrow()
    rec.close()
  })

  test("surface CLI overlay (cli) renders identically to bench (closed-port symmetry)", () => {
    const path = join(dir, "r.jsonl")
    const rec = new JsonlRecorder(path, { strict: true, now: () => 1 })
    rec.emit({
      type: "knobs_applied",
      surface: "cli",
      knobs: { lsp: { value: true, source: "env" } },
      preset: null,
      costMultiplier: 1,
    })
    rec.close()
    const line = readLine(path)
    expect(line.data.surface).toBe("cli")
  })

  test("ide surface mirror passes through (5-surface closed enum)", () => {
    const path = join(dir, "r.jsonl")
    const rec = new JsonlRecorder(path, { strict: true, now: () => 1 })
    rec.emit({
      type: "knobs_applied",
      surface: "ide",
      knobs: {},
      preset: null,
      costMultiplier: 0,
    })
    rec.close()
    const line = readLine(path)
    expect(line.data.surface).toBe("ide")
  })

  test("redaction.applied=true is stamped on the envelope (defence-in-depth audit)", () => {
    const path = join(dir, "r.jsonl")
    const rec = new JsonlRecorder(path, { strict: true, now: () => 1 })
    rec.emit({
      type: "knobs_applied",
      surface: "bench",
      knobs: {},
      preset: null,
      costMultiplier: 0,
    })
    rec.close()
    const raw = readFileSync(path, "utf8").trim()
    const parsed = JSON.parse(raw) as {
      redaction: { applied: boolean; policy: string }
    }
    expect(parsed.redaction.applied).toBe(true)
    expect(typeof parsed.redaction.policy).toBe("string")
  })
})
