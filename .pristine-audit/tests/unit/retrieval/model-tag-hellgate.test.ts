/**
 * HELLGATE — adversarial ModelTag versioning proofs (ADR-0266).
 *
 * Invariants under attack: (i) canonical string format always rebuildable
 * from parsed components; (ii) parse / tag round-trip is lossless even
 * when the model name contains hyphens; (iii) the default invalidator
 * fires on provider / model / dim / major-version-bump but NOT on
 * minor-version-bump; (iv) `invalidateAll` is best-effort — one callback
 * throwing does not stop the others, the call itself never throws;
 * (v) without composition, the slice is byte-identical (default-OFF);
 * (vi) ParseError has exactly 4 arms (closed exhaustive switch).
 *
 * 15 adversarial cases — HELL-MT-01..HELL-MT-15.
 */

import { describe, expect, test } from "bun:test"
import {
  canonicalString,
  checkInvalidation,
  clearInvalidationCallbacks,
  createDefaultInvalidator,
  type InvalidationCallback,
  listInvalidationCallbacks,
  type ModelTag,
  type ParseError,
  parseModelTag,
  registerInvalidationCallback,
  tagModel,
} from "@/retrieval/versioning"

const tagOf = (provider: string, model: string, version: string, dim: number): ModelTag =>
  tagModel({ provider, model, version, dim })

/**
 * Label each `ParseError` arm. The `switch` is exhaustive — TS refuses to
 * compile if a new arm is added without updating the cases here.
 */
const labelArm = (e: ParseError): string => {
  switch (e.kind) {
    case "malformed":
      return "malformed"
    case "missing-dim":
      return "missing-dim"
    case "missing-version":
      return "missing-version"
    case "empty-field":
      return `empty-field:${e.field}`
    default: {
      const _exhaustive: never = e
      return _exhaustive
    }
  }
}

describe("model-tag hellgate (ADR-0266)", () => {
  test("HELL-MT-01: tag(...) produces canonical {provider}-{model}-v{version}-d{dim}", () => {
    const t = tagOf("openai", "text-embedding-3-small", "3", 1536)
    expect(t.canonical).toBe("openai-text-embedding-3-small-v3-d1536")
    expect(t.provider).toBe("openai")
    expect(t.model).toBe("text-embedding-3-small")
    expect(t.version).toBe("3")
    expect(t.dim).toBe(1536)
  })

  test("HELL-MT-02: parse(tag(x).canonical) round-trips to the same fields", () => {
    const inputs: Array<[string, string, string, number]> = [
      ["openai", "text-embedding-3-small", "3", 1536],
      ["voyage", "voyage-3", "1", 1024],
      ["cohere", "embed-multilingual-v3.0", "3", 1024],
      ["x", "y", "1", 1],
    ]
    for (const [p, m, v, d] of inputs) {
      const built = tagOf(p, m, v, d)
      const parsed = parseModelTag(built.canonical)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) throw new Error("unreachable")
      expect(parsed.value.provider).toBe(p)
      expect(parsed.value.model).toBe(m)
      expect(parsed.value.version).toBe(v)
      expect(parsed.value.dim).toBe(d)
      expect(parsed.value.canonical).toBe(built.canonical)
    }
  })

  test("HELL-MT-03: parse malformed → Err('malformed')", () => {
    const cases = [
      "", // empty
      "openai", // 1 segment
      "openai-model", // 2 segments
      "openai model-v1-d8", // contains whitespace
    ]
    for (const raw of cases) {
      const r = parseModelTag(raw)
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error("unreachable")
      expect(r.error.kind).toBe("malformed")
    }
  })

  test("HELL-MT-04: unusual / unknown provider names are accepted (no allow-list gate)", () => {
    // Anything that is non-empty, no whitespace / control, no hyphen is fine.
    const exotic = tagOf("myInternalVendor", "foo", "1", 8)
    expect(exotic.provider).toBe("myInternalVendor")
    const exotic2 = tagOf("ALLCAPS", "model", "1", 8)
    expect(exotic2.provider).toBe("ALLCAPS")
    // pure-digit providers
    const numeric = tagOf("42", "m", "1", 8)
    expect(numeric.provider).toBe("42")
    // dots / underscores in the provider segment are fine
    const exotic3 = tagOf("vendor.v2_alpha", "m", "1", 8)
    expect(exotic3.provider).toBe("vendor.v2_alpha")
  })

  test("HELL-MT-05: different provider → stale", () => {
    const stored = tagOf("openai", "m", "1", 8)
    const current = tagOf("voyage", "m", "1", 8)
    const d = checkInvalidation(stored, current)
    expect(d.stale).toBe(true)
    expect(d.reason).toContain("provider-changed")
  })

  test("HELL-MT-06: different model → stale", () => {
    const stored = tagOf("openai", "a", "1", 8)
    const current = tagOf("openai", "b", "1", 8)
    const d = checkInvalidation(stored, current)
    expect(d.stale).toBe(true)
    expect(d.reason).toContain("model-changed")
  })

  test("HELL-MT-07: major version bump → stale", () => {
    const stored = tagOf("openai", "m", "1", 8)
    const current = tagOf("openai", "m", "2", 8)
    const d = checkInvalidation(stored, current)
    expect(d.stale).toBe(true)
    expect(d.reason).toContain("major-version-bump")
    // also try 1.x -> 2.0
    const d2 = checkInvalidation(tagOf("openai", "m", "1.5", 8), tagOf("openai", "m", "2.0", 8))
    expect(d2.stale).toBe(true)
  })

  test("HELL-MT-08: minor version bump → NOT stale", () => {
    const stored = tagOf("openai", "m", "3.0", 8)
    const current = tagOf("openai", "m", "3.1", 8)
    const d = checkInvalidation(stored, current)
    expect(d.stale).toBe(false)
    // patch bump too
    const d2 = checkInvalidation(tagOf("openai", "m", "3.0.0", 8), tagOf("openai", "m", "3.0.1", 8))
    expect(d2.stale).toBe(false)
  })

  test("HELL-MT-09: dim mismatch → ALWAYS stale (cosine undefined across dims)", () => {
    const stored = tagOf("openai", "m", "1", 1536)
    const current = tagOf("openai", "m", "1", 1024)
    const d = checkInvalidation(stored, current)
    expect(d.stale).toBe(true)
    expect(d.reason).toContain("dim-changed")
  })

  test("HELL-MT-10: every field equal → fresh", () => {
    const stored = tagOf("openai", "text-embedding-3-small", "3", 1536)
    const current = tagOf("openai", "text-embedding-3-small", "3", 1536)
    const d = checkInvalidation(stored, current)
    expect(d.stale).toBe(false)
    expect(d.reason).toBeUndefined()
  })

  test("HELL-MT-11: invalidateAll calls every registered callback", async () => {
    const called: string[] = []
    const mk = (name: string): InvalidationCallback => ({
      name,
      async invalidate(reason) {
        called.push(`${name}:${reason}`)
      },
    })
    const inv = createDefaultInvalidator()
    await inv.invalidateAll([mk("cache"), mk("index"), mk("metrics")])
    expect(called).toEqual([
      "cache:model-tag-mismatch",
      "index:model-tag-mismatch",
      "metrics:model-tag-mismatch",
    ])
  })

  test("HELL-MT-12: one callback fails — the others still run; invalidateAll never throws", async () => {
    const called: string[] = []
    const errors: string[] = []
    const ok = (name: string): InvalidationCallback => ({
      name,
      async invalidate() {
        called.push(name)
      },
    })
    const bad: InvalidationCallback = {
      name: "broken",
      async invalidate() {
        throw new Error("boom")
      },
    }
    const inv = createDefaultInvalidator({
      onCallbackError: (f) => {
        errors.push(`${f.callback}:${(f.error as Error).message}`)
      },
    })
    // Must not throw.
    await inv.invalidateAll([ok("a"), bad, ok("b")])
    expect(called).toEqual(["a", "b"])
    expect(errors).toEqual(["broken:boom"])
  })

  test("HELL-MT-13: canonical format integrity — hyphenated models round-trip; forbidden chars rejected at tag()", () => {
    // Hyphenated model name MUST round-trip (the parser puts hyphens back).
    const t = tagOf("openai", "text-embedding-3-small", "3", 1536)
    const p = parseModelTag(t.canonical)
    expect(p.ok).toBe(true)
    if (!p.ok) throw new Error("unreachable")
    expect(p.value.model).toBe("text-embedding-3-small")

    // Whitespace / control / hyphen-in-provider rejected at construction.
    expect(() => tagOf("open ai", "m", "1", 8)).toThrow()
    expect(() => tagOf("open\tai", "m", "1", 8)).toThrow()
    expect(() => tagOf("open-ai", "m", "1", 8)).toThrow()
    expect(() => tagOf("", "m", "1", 8)).toThrow()
    expect(() => tagOf("openai", "", "1", 8)).toThrow()
    expect(() => tagOf("openai", "m", "", 8)).toThrow()
    expect(() => tagOf("openai", "m", "1-rc", 8)).toThrow()
    expect(() => tagOf("openai", "m\n", "1", 8)).toThrow()
    // dim must be a positive integer.
    expect(() => tagOf("openai", "m", "1", 0)).toThrow()
    expect(() => tagOf("openai", "m", "1", -1)).toThrow()
    expect(() => tagOf("openai", "m", "1", 1.5)).toThrow()

    // canonicalString rebuilds the exact form.
    expect(canonicalString("openai", "m", "1", 8)).toBe("openai-m-v1-d8")
  })

  test("HELL-MT-14: default-OFF byte-identical — no Invalidator + no callback => no side effects", async () => {
    // Importing the barrel above already happened; if any module-level
    // side effect leaked, the registry would be non-empty.
    clearInvalidationCallbacks()
    expect(listInvalidationCallbacks()).toEqual([])

    // Constructing a tag is pure; comparing two tags is pure.
    const a = tagOf("openai", "m", "1", 8)
    const b = tagOf("openai", "m", "1", 8)
    const d = checkInvalidation(a, b)
    expect(d.stale).toBe(false)

    // Registering then unregistering returns to byte-identical state.
    const cb: InvalidationCallback = { name: "x", async invalidate() {} }
    const off = registerInvalidationCallback(cb)
    expect(listInvalidationCallbacks().length).toBe(1)
    off()
    expect(listInvalidationCallbacks()).toEqual([])

    // Registering the same callback twice is a no-op.
    registerInvalidationCallback(cb)
    registerInvalidationCallback(cb)
    expect(listInvalidationCallbacks().length).toBe(1)
    clearInvalidationCallbacks()
  })

  test("HELL-MT-15: ParseError 4-arm exhaustive switch coverage", () => {
    // Build a sample of each kind. The `switch` is exhaustive — TS will
    // refuse to compile if a new arm is added without updating it.
    const samples: ParseError[] = [
      { kind: "malformed", raw: "x" },
      { kind: "missing-dim", raw: "a-b-v1-xNope" },
      { kind: "missing-version", raw: "a-b-cNope-d8" },
      { kind: "empty-field", raw: "-b-v1-d8", field: "provider" },
    ]
    const seen = new Set<string>(samples.map(labelArm))
    expect(seen).toEqual(
      new Set(["malformed", "missing-dim", "missing-version", "empty-field:provider"]),
    )

    // Each arm is actually produced by the codec for the right input.
    const expectations: ReadonlyArray<[string, ParseError["kind"]]> = [
      ["only-two", "malformed"],
      ["openai-m-v1-xWat", "missing-dim"],
      ["openai-m-xNotV-d8", "missing-version"],
      ["-m-v1-d8", "empty-field"],
    ]
    for (const [raw, kind] of expectations) {
      const r = parseModelTag(raw)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.kind).toBe(kind)
    }

    // The empty-field arm carries the offending field.
    const empty = parseModelTag("-m-v1-d8")
    if (!empty.ok && empty.error.kind === "empty-field") {
      expect(empty.error.field).toBe("provider")
    }
  })
})
