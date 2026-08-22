/**
 * static-owner ENGINE seam HELLGATE (jul-6 S2).
 *
 * The engine is the def-use/AST adapter port. This suite pins the SEAM shape +
 * the deterministic FAKE's contract so main can drop in real semantica behind
 * the same interface without touching the provider.
 *
 * Invariants pinned here:
 *   - `supportsLanguage` is a pure predicate (same answer for same input).
 *   - `owners(query)` is DETERMINISTIC (same query ⇒ identical facts, order-stable).
 *   - the fake NEVER returns a file that is not in the query's `repoFiles`
 *     (hallucination fence at the engine boundary — main's real engine MUST
 *     honour the same contract; the fake is the reference).
 *   - every fact carries a non-empty `basis` (the def-use evidence sentence)
 *     and an ordinal `strength` — NEVER a numeric confidence.
 */
import { describe, expect, test } from "bun:test"
import {
  makeFakeStaticOwnerEngine,
  type StaticOwnerEngine,
  type StaticOwnerFact,
  type StaticOwnerQuery,
} from "@/agent/observation/providers/static-owner/engine"

const EVIDENCE_STRENGTHS = new Set(["high", "medium", "low", "unknown"])

const query = (over: Partial<StaticOwnerQuery> = {}): StaticOwnerQuery => ({
  issueText: "UnicodeError raised uncaught in prepare_url",
  repoFiles: ["requests/models.py", "requests/exceptions.py", "requests/adapters.py"],
  language: "python",
  ...over,
})

describe("static-owner engine seam — fake reference", () => {
  test("supportsLanguage is a pure predicate", () => {
    const eng = makeFakeStaticOwnerEngine({
      languages: ["python", "typescript"],
      facts: [],
    })
    expect(eng.supportsLanguage("python")).toBe(true)
    expect(eng.supportsLanguage("python")).toBe(true) // stable
    expect(eng.supportsLanguage("ruby")).toBe(false)
    expect(eng.supportsLanguage("PYTHON")).toBe(false) // exact match, no coercion
  })

  test("owners() is deterministic and order-stable", () => {
    const eng = makeFakeStaticOwnerEngine({
      languages: ["python"],
      facts: [
        {
          file: "requests/models.py",
          symbol: "prepare_url",
          basis: "def-use edge",
          strength: "high",
        },
        {
          file: "requests/exceptions.py",
          symbol: "InvalidURL",
          basis: "type referenced",
          strength: "medium",
        },
      ],
    })
    const a = eng.owners(query())
    const b = eng.owners(query())
    expect(a).toEqual(b)
    expect(a.map((f) => f.file)).toEqual(["requests/models.py", "requests/exceptions.py"])
  })

  test("fake NEVER returns a file outside the query repoFiles (hallucination fence)", () => {
    const eng = makeFakeStaticOwnerEngine({
      languages: ["python"],
      facts: [
        { file: "requests/models.py", basis: "in tree", strength: "high" },
        { file: "totally/made-up.py", basis: "NOT in tree", strength: "high" },
      ],
    })
    const facts = eng.owners(query())
    const files = facts.map((f) => f.file)
    expect(files).toContain("requests/models.py")
    expect(files).not.toContain("totally/made-up.py")
  })

  test("every fact has non-empty basis and an ordinal strength (no numeric confidence)", () => {
    const eng = makeFakeStaticOwnerEngine({
      languages: ["python"],
      facts: [{ file: "requests/models.py", basis: "def-use edge", strength: "low" }],
    })
    for (const f of eng.owners(query())) {
      expect(f.basis.length).toBeGreaterThan(0)
      expect(EVIDENCE_STRENGTHS.has(f.strength)).toBe(true)
      // Structural: the fact type must not carry a numeric confidence field.
      expect((f as unknown as Record<string, unknown>).confidence).toBeUndefined()
      expect((f as unknown as Record<string, unknown>).score).toBeUndefined()
    }
  })

  test("empty facts ⇒ empty owners (no fabricated signal)", () => {
    const eng = makeFakeStaticOwnerEngine({ languages: ["python"], facts: [] })
    expect(eng.owners(query())).toEqual([])
  })

  test("the fake satisfies the StaticOwnerEngine type", () => {
    const eng: StaticOwnerEngine = makeFakeStaticOwnerEngine({ languages: ["python"], facts: [] })
    expect(typeof eng.supportsLanguage).toBe("function")
    expect(typeof eng.owners).toBe("function")
  })
})

// Source fence: the fact type must never grow a numeric-confidence field, and
// the fake must filter against repoFiles (not trust its configured facts blindly).
describe("static-owner engine — source fence", () => {
  test("engine module does not reference a numeric confidence field name", async () => {
    const src = await Bun.file(
      new URL(
        "../../../../../../src/agent/observation/providers/static-owner/engine.ts",
        import.meta.url,
      ),
    ).text()
    expect(src).not.toMatch(/\bconfidence\s*[:?]/)
    // The fake must intersect with repoFiles somewhere (the fence is code, not luck).
    expect(src).toMatch(/repoFiles/)
  })

  // Red-on-injection: a fact list that is all out-of-tree must yield zero owners.
  test("all-out-of-tree facts ⇒ zero owners (fence, not luck)", () => {
    const eng = makeFakeStaticOwnerEngine({
      languages: ["python"],
      facts: [
        { file: "a.py", basis: "x", strength: "high" },
        { file: "b.py", basis: "y", strength: "high" },
      ],
    })
    const facts: readonly StaticOwnerFact[] = eng.owners(
      query({ repoFiles: ["requests/models.py"] }),
    )
    expect(facts).toEqual([])
  })
})
