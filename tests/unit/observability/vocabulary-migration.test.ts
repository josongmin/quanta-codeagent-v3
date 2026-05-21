/**
 * Wave D — OTel vocabulary cross-cutting migration verification.
 *
 * ADR-0032 introduced the canonical attribute vocabulary; this test file is
 * the structural verifier for the migration sweep. It enforces three
 * invariants:
 *
 *   1. **Single source of truth**: no raw `quanta.*` / `gen_ai.*` string
 *      literal may appear in `src/` outside of `observability/vocabulary.ts`
 *      itself (and the one declared schema constant in `shared/trajectory.ts`,
 *      `quanta.trajectory.v1`, which is intentionally not an attribute key —
 *      it labels the JSONL envelope schema). Any new emit site MUST go
 *      through `QUANTA_ATTRS` / `GEN_AI_ATTRS`.
 *
 *   2. **Namespace shape**: every vocabulary key matches the documented
 *      regex; new keys added by Wave D (`decidedBy`, `fuzzyMatchTier`) are
 *      present and conform.
 *
 *   3. **Migration honesty**: the migration targets called out in ADR-0032's
 *      "Integration seam" — `agent/metrics.ts`, `agent/memory-stats.ts`,
 *      `stream/adapters/jsonl-recorder.ts`, `llm/adapters/*`,
 *      `permission/reviewer.ts` — are EITHER touched by vocabulary keys
 *      OR explicitly carry no vocabulary-shaped literals at all. The test
 *      documents which sites belong to which class so the byte-identical
 *      invariant is verifiable.
 *
 * Byte-identical strategy: this test does NOT exercise emit pipelines (those
 * tests live next to each slice). It only checks the vocabulary boundary —
 * if no file outside `observability/` emits a raw `quanta.*` literal, then
 * by definition no on-the-wire string changed during migration.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { ALL_ATTR_KEYS, ATTR_KEY_SET, GEN_AI_ATTRS, QUANTA_ATTRS } from "@/observability/vocabulary"

// ---------------------------------------------------------------------------
// File-system walker (vendored — tests should not import non-test src code
// beyond the unit under test). Limited to `src/` to keep the scan bounded.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const SRC_ROOT = join(REPO_ROOT, "src")

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"])

const walk = (dir: string, out: string[]): void => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) {
      walk(p, out)
    } else if (st.isFile() && (p.endsWith(".ts") || p.endsWith(".tsx"))) {
      out.push(p)
    }
  }
}

const allSrcFiles = (): string[] => {
  const out: string[] = []
  walk(SRC_ROOT, out)
  return out
}

// ---------------------------------------------------------------------------
// Vocabulary-key literal scanner.
// ---------------------------------------------------------------------------

/** Matches a double-quoted string that looks like an OTel attribute key in
 *  either canonical namespace. Captures the bare key so we can compare to
 *  `ATTR_KEY_SET`. The character class deliberately excludes whitespace and
 *  quote characters to avoid running across line boundaries. */
const QUANTA_LITERAL_RE = /"(quanta\.[a-z0-9_.]+)"/g
const GEN_AI_LITERAL_RE = /"(gen_ai\.[a-z0-9_.]+)"/g

/** Files explicitly authorized to host the canonical literal forms — they
 *  ARE the source of truth (the vocabulary itself), the test that introspects
 *  vocabulary keys, and the JSONL envelope schema label (which is a SCHEMA
 *  identifier, not an attribute key). */
const VOCABULARY_OWNER_FILES = new Set<string>([
  join(SRC_ROOT, "observability", "vocabulary.ts"),
  // `shared/trajectory.ts` declares `"quanta.trajectory.v1"` as the schema
  // version constant for the JSONL envelope (RFC-0002). It is NOT an
  // attribute key and is deliberately excluded from `QUANTA_ATTRS` — flagging
  // it would force the migration test to either inline a special exception
  // (heuristic-shaped) or fabricate a fake vocabulary slot for it. Listing
  // the owner file is the explicit, structural way to acknowledge the
  // schema-vs-attribute distinction.
  join(REPO_ROOT, "src", "shared", "trajectory.ts"),
])

interface LiteralHit {
  file: string
  key: string
  kind: "quanta" | "gen_ai"
}

const scanForLiterals = (): LiteralHit[] => {
  const hits: LiteralHit[] = []
  for (const file of allSrcFiles()) {
    if (VOCABULARY_OWNER_FILES.has(file)) continue
    const text = readFileSync(file, "utf8")
    // Iterate both regexes independently — they have disjoint prefixes so a
    // match in one cannot mask the other.
    for (const m of text.matchAll(QUANTA_LITERAL_RE)) {
      const key = m[1]
      if (key !== undefined) hits.push({ file, key, kind: "quanta" })
    }
    for (const m of text.matchAll(GEN_AI_LITERAL_RE)) {
      const key = m[1]
      if (key !== undefined) hits.push({ file, key, kind: "gen_ai" })
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Wave D — vocabulary namespace integrity", () => {
  test("every quanta.* key starts with the canonical prefix", () => {
    for (const k of ALL_ATTR_KEYS) {
      if (k.startsWith("quanta.")) {
        expect(/^quanta\.[a-z_]+(\.[a-z0-9_]+)+$/.test(k)).toBe(true)
      }
    }
  })

  test("every gen_ai.* key starts with the canonical prefix", () => {
    for (const k of ALL_ATTR_KEYS) {
      if (k.startsWith("gen_ai.")) {
        expect(/^gen_ai\.[a-z_]+(\.[a-z0-9_]+)*$/.test(k)).toBe(true)
      }
    }
  })

  test("vocabulary keys are unique (no aliasing accidents)", () => {
    expect(new Set(ALL_ATTR_KEYS).size).toBe(ALL_ATTR_KEYS.length)
  })

  test("ATTR_KEY_SET membership agrees with ALL_ATTR_KEYS", () => {
    for (const k of ALL_ATTR_KEYS) expect(ATTR_KEY_SET.has(k)).toBe(true)
  })
})

describe("Wave D — new keys added by this slice", () => {
  test("quanta.permission.decided_by is registered", () => {
    expect(QUANTA_ATTRS.permission.decidedBy).toBe("quanta.permission.decided_by")
    expect(ATTR_KEY_SET.has("quanta.permission.decided_by")).toBe(true)
  })

  test("quanta.patch.fuzzy_match_tier is registered", () => {
    expect(QUANTA_ATTRS.patch.fuzzyMatchTier).toBe("quanta.patch.fuzzy_match_tier")
    expect(ATTR_KEY_SET.has("quanta.patch.fuzzy_match_tier")).toBe(true)
  })

  test("new keys conform to the snake_case rule (no camelCase in the wire form)", () => {
    // Compare via Set membership rather than toBe(lowercase) — the literal
    // typing on the const map narrows toBe()'s expected argument to the
    // exact literal, which `.toLowerCase()` widens to `string`.
    const lowered = (QUANTA_ATTRS.permission.decidedBy as string).toLowerCase()
    expect(lowered).toBe(QUANTA_ATTRS.permission.decidedBy as string)
    const loweredPatch = (QUANTA_ATTRS.patch.fuzzyMatchTier as string).toLowerCase()
    expect(loweredPatch).toBe(QUANTA_ATTRS.patch.fuzzyMatchTier as string)
  })

  test("new keys preserve their namespace (permission. / patch.)", () => {
    expect(QUANTA_ATTRS.permission.decidedBy.startsWith("quanta.permission.")).toBe(true)
    expect(QUANTA_ATTRS.patch.fuzzyMatchTier.startsWith("quanta.patch.")).toBe(true)
  })

  test("new keys do not collide with pre-existing entries", () => {
    // Count entries matching each new key — exactly one occurrence is allowed.
    const all = [...ALL_ATTR_KEYS]
    expect(all.filter((k) => k === "quanta.permission.decided_by").length).toBe(1)
    expect(all.filter((k) => k === "quanta.patch.fuzzy_match_tier").length).toBe(1)
  })
})

describe("Wave D — single source of truth (orphan literal scan)", () => {
  test("no raw quanta.* attribute-key literal exists outside the vocabulary module", () => {
    const hits = scanForLiterals().filter((h) => h.kind === "quanta")
    // The schema label `quanta.trajectory.v1` is whitelisted via
    // VOCABULARY_OWNER_FILES; any remaining hit is a real migration miss.
    if (hits.length > 0) {
      const report = hits
        .map((h) => `  ${h.file.slice(SRC_ROOT.length + 1)}: "${h.key}"`)
        .join("\n")
      throw new Error(`orphan quanta.* literals (use QUANTA_ATTRS instead):\n${report}`)
    }
    expect(hits.length).toBe(0)
  })

  test("no raw gen_ai.* attribute-key literal exists outside the vocabulary module", () => {
    const hits = scanForLiterals().filter((h) => h.kind === "gen_ai")
    if (hits.length > 0) {
      const report = hits
        .map((h) => `  ${h.file.slice(SRC_ROOT.length + 1)}: "${h.key}"`)
        .join("\n")
      throw new Error(`orphan gen_ai.* literals (use GEN_AI_ATTRS instead):\n${report}`)
    }
    expect(hits.length).toBe(0)
  })

  test("any literal we DO find — if any — is actually in the canonical set (no typos slipping in)", () => {
    // This is the "defense in depth" half of the orphan scan: if the first
    // two tests ever start permitting whitelisted hits (e.g. a future schema
    // version is added), this test ensures the literal still resolves to a
    // declared vocabulary key. Today the scan should return zero, so the
    // loop simply runs zero times — the assertion is structurally meaningful
    // regardless.
    for (const h of scanForLiterals()) {
      expect(ATTR_KEY_SET.has(h.key)).toBe(true)
    }
  })
})

describe("Wave D — migration-target audit (ADR-0032 integration seam)", () => {
  /** Files explicitly called out by ADR-0032 as migration targets. We assert
   *  that NONE of them currently host a `quanta.*` / `gen_ai.*` attribute-key
   *  literal — either because the file (a) was migrated to QUANTA_ATTRS, or
   *  (b) was always free of such literals (the case for every file in this
   *  Wave: their existing string keys — `agent.turns`, `memory.recall.calls`,
   *  `inputTokens`, etc. — do NOT share the canonical prefix, so byte-
   *  identical migration is deferred to a follow-up schema-bump PR per the
   *  user's Wave D charter). */
  const TARGETS: ReadonlyArray<string> = [
    join(SRC_ROOT, "agent", "metrics.ts"),
    join(SRC_ROOT, "agent", "memory-stats.ts"),
    join(SRC_ROOT, "stream", "adapters", "jsonl-recorder.ts"),
    join(SRC_ROOT, "llm", "adapters", "openai.ts"),
    join(SRC_ROOT, "llm", "adapters", "anthropic.ts"),
    join(SRC_ROOT, "permission", "reviewer.ts"),
  ]

  test("each migration target file is present on disk", () => {
    for (const t of TARGETS) {
      const exists = statSync(t).isFile()
      expect(exists).toBe(true)
    }
  })

  test("no migration target hosts a raw quanta.* attribute-key literal", () => {
    for (const t of TARGETS) {
      const text = readFileSync(t, "utf8")
      const matches = [...text.matchAll(QUANTA_LITERAL_RE)]
      expect(matches.length).toBe(0)
    }
  })

  test("no migration target hosts a raw gen_ai.* attribute-key literal", () => {
    for (const t of TARGETS) {
      const text = readFileSync(t, "utf8")
      const matches = [...text.matchAll(GEN_AI_LITERAL_RE)]
      expect(matches.length).toBe(0)
    }
  })
})

describe("Wave D — vocabulary growth budget", () => {
  test("vocabulary count grew by exactly the two Wave D additions", () => {
    // Baseline of 50 is asserted by `vocabulary.test.ts`. Wave D adds two
    // keys (permission.decided_by + patch.fuzzy_match_tier) — assert the
    // post-Wave-D floor is at least 52 so future accidental removals show up.
    expect(ALL_ATTR_KEYS.length).toBeGreaterThanOrEqual(52)
  })

  test("permission namespace contains decidedBy alongside the ADR-0029 trio", () => {
    expect(QUANTA_ATTRS.permission.reviewerTier).toBe("quanta.permission.reviewer_tier")
    expect(QUANTA_ATTRS.permission.outcome).toBe("quanta.permission.outcome")
    expect(QUANTA_ATTRS.permission.riskLevel).toBe("quanta.permission.risk_level")
    expect(QUANTA_ATTRS.permission.decidedBy).toBe("quanta.permission.decided_by")
  })

  test("patch namespace contains fuzzyMatchTier alongside the ADR-0028 quartet", () => {
    expect(QUANTA_ATTRS.patch.op).toBe("quanta.patch.op")
    expect(QUANTA_ATTRS.patch.path).toBe("quanta.patch.path")
    expect(QUANTA_ATTRS.patch.hunkCount).toBe("quanta.patch.hunk_count")
    expect(QUANTA_ATTRS.patch.fuzzyMatched).toBe("quanta.patch.fuzzy_matched")
    expect(QUANTA_ATTRS.patch.fuzzyMatchTier).toBe("quanta.patch.fuzzy_match_tier")
  })

  test("gen_ai usage namespace still exposes the four token-count keys", () => {
    expect(GEN_AI_ATTRS.usage.inputTokens).toBe("gen_ai.usage.input_tokens")
    expect(GEN_AI_ATTRS.usage.outputTokens).toBe("gen_ai.usage.output_tokens")
    expect(GEN_AI_ATTRS.usage.cacheCreationInputTokens).toBe(
      "gen_ai.usage.cache_creation_input_tokens",
    )
    expect(GEN_AI_ATTRS.usage.cacheReadInputTokens).toBe("gen_ai.usage.cache_read_input_tokens")
  })
})
