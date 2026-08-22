/**
 * static-owner PROVIDER HELLGATE (jul-6 S2).
 *
 * `staticOwnerProvider(engine)` is an ObservationProvider (kind "localization")
 * whose `produce` maps engine def-use facts → ObservationFragment owners.
 *
 * HARD invariants (audit-derived):
 *   (A1 overtrust)  — strength on an OwnerHint is EXACTLY the engine fact's
 *                     ordinal strength; the provider NEVER upgrades it, and
 *                     NEVER emits "high" for a fact the engine ranked lower.
 *   (hallucination) — every emitted owner.file ∈ ctx.repoFiles (the provider
 *                     double-fences even if a broken engine leaked a path).
 *   (null-not-noise)— no signal ⇒ `produce` returns `null`, never an
 *                     empty-owners fragment (that would render noise in S3).
 *   (applicable)    — gates on capability "source-repair" AND an engine-supported
 *                     language. Off ⇒ produce is never reached (but is also safe).
 *   (budget)        — owners are capped at budget.maxOwners.
 *   (no numeric confidence) — nothing on the fragment carries a number-as-trust.
 */
import { describe, expect, test } from "bun:test"
import type { EvidenceStrength, ObservationFragment } from "@/agent/observation/fragment"
import type { ProviderBudget, TaskContext } from "@/agent/observation/port"
import { makeFakeStaticOwnerEngine } from "@/agent/observation/providers/static-owner/engine"
import { staticOwnerProvider } from "@/agent/observation/providers/static-owner/provider"

const BUDGET: ProviderBudget = { maxMillis: 500, maxOwners: 5 }

const ctx = (over: Partial<TaskContext> = {}): TaskContext => ({
  cwd: "/repo",
  issueText: "UnicodeError raised uncaught in prepare_url",
  repoFiles: ["requests/models.py", "requests/exceptions.py", "requests/adapters.py"],
  language: "python",
  capability: "source-repair",
  ...over,
})

const engineWith = (
  facts: ReadonlyArray<{
    file: string
    symbol?: string
    basis: string
    strength: EvidenceStrength
  }>,
  languages: readonly string[] = ["python"],
) => makeFakeStaticOwnerEngine({ languages, facts })

describe("staticOwnerProvider — identity + applicability", () => {
  test("kind is localization; id is stable", () => {
    const p = staticOwnerProvider(engineWith([]))
    expect(p.kind).toBe("localization")
    expect(p.id).toBe("static-owner")
  })

  test("applicable requires capability source-repair AND supported language", () => {
    const p = staticOwnerProvider(engineWith([], ["python"]))
    expect(p.applicable(ctx())).toBe(true)
    expect(p.applicable(ctx({ capability: "vision" }))).toBe(false)
    expect(p.applicable(ctx({ capability: "general" }))).toBe(false)
    expect(p.applicable(ctx({ language: "ruby" }))).toBe(false) // engine doesn't support
  })
})

describe("staticOwnerProvider — produce mapping", () => {
  test("maps engine facts → owners with source 'static-owner' and evidence = basis", async () => {
    const p = staticOwnerProvider(
      engineWith([
        {
          file: "requests/models.py",
          symbol: "prepare_url",
          basis: "def-use: idna encode raises UnicodeError uncaught",
          strength: "high",
        },
      ]),
    )
    const frag = (await p.produce(ctx(), BUDGET)) as ObservationFragment
    expect(frag).not.toBeNull()
    expect(frag.providerId).toBe("static-owner")
    expect(frag.owners).toEqual([
      {
        file: "requests/models.py",
        symbol: "prepare_url",
        strength: "high",
        evidence: "def-use: idna encode raises UnicodeError uncaught",
        source: "static-owner",
      },
    ])
  })

  test("null when engine yields no facts (no empty-owners fragment)", async () => {
    const p = staticOwnerProvider(engineWith([]))
    const frag = await p.produce(ctx(), BUDGET)
    expect(frag).toBeNull()
  })

  test("null when EVERY fact is fenced out (all paths out of repoFiles) — not an empty fragment", async () => {
    const p = staticOwnerProvider(
      engineWith([{ file: "not/in/tree.py", basis: "x", strength: "high" }]),
    )
    // repoFiles here does NOT contain not/in/tree.py.
    const frag = await p.produce(ctx({ repoFiles: ["requests/models.py"] }), BUDGET)
    expect(frag).toBeNull()
  })
})

describe("staticOwnerProvider — A1 overtrust fence", () => {
  test("strength is passed through verbatim; provider never upgrades", async () => {
    const p = staticOwnerProvider(
      engineWith([
        { file: "requests/models.py", basis: "weak caller edge", strength: "low" },
        { file: "requests/exceptions.py", basis: "referenced type", strength: "medium" },
      ]),
    )
    const frag = (await p.produce(ctx(), BUDGET)) as ObservationFragment
    const byFile = new Map(frag.owners?.map((o) => [o.file, o.strength]))
    expect(byFile.get("requests/models.py")).toBe("low")
    expect(byFile.get("requests/exceptions.py")).toBe("medium")
    // No owner is "high" — the engine never said "high".
    expect(frag.owners?.some((o) => o.strength === "high")).toBe(false)
  })

  test("a fact with EMPTY basis is dropped — no high-strength owner with zero evidence", async () => {
    // Overtrust: "high" strength but no observed basis is the worst case — a
    // confident claim with nothing behind it. The provider must not emit it.
    const leaky = {
      supportsLanguage: (l: string) => l === "python",
      owners: () => [
        { file: "requests/models.py", basis: "   ", strength: "high" as const },
        { file: "requests/exceptions.py", basis: "real def-use edge", strength: "medium" as const },
      ],
    }
    const p = staticOwnerProvider(leaky)
    const frag = (await p.produce(ctx(), BUDGET)) as ObservationFragment
    expect(frag.owners?.map((o) => o.file)).toEqual(["requests/exceptions.py"])
    // Every surviving owner has non-empty evidence.
    for (const o of frag.owners ?? []) expect(o.evidence.trim().length).toBeGreaterThan(0)
  })

  test("if ALL facts have empty basis ⇒ null (no evidence = no signal)", async () => {
    const leaky = {
      supportsLanguage: (l: string) => l === "python",
      owners: () => [{ file: "requests/models.py", basis: "", strength: "high" as const }],
    }
    const p = staticOwnerProvider(leaky)
    expect(await p.produce(ctx(), BUDGET)).toBeNull()
  })

  test("no numeric confidence appears anywhere on the fragment", async () => {
    const p = staticOwnerProvider(
      engineWith([{ file: "requests/models.py", basis: "x", strength: "high" }]),
    )
    const frag = (await p.produce(ctx(), BUDGET)) as ObservationFragment
    const json = JSON.stringify(frag)
    expect(json).not.toMatch(/"confidence"/)
    expect(json).not.toMatch(/"score"/)
    for (const o of frag.owners ?? []) {
      expect(typeof (o as unknown as Record<string, unknown>).confidence).toBe("undefined")
    }
  })
})

describe("staticOwnerProvider — hallucination double-fence", () => {
  test("a leaky engine (returns out-of-tree path) still cannot inject it via the provider", async () => {
    // A deliberately BROKEN engine that bypasses its own fence.
    const leaky = {
      supportsLanguage: (l: string) => l === "python",
      owners: () => [
        { file: "requests/models.py", basis: "real", strength: "high" as const },
        { file: "/etc/passwd", basis: "leaked", strength: "high" as const },
      ],
    }
    const p = staticOwnerProvider(leaky)
    const frag = (await p.produce(ctx(), BUDGET)) as ObservationFragment
    const files = frag.owners?.map((o) => o.file) ?? []
    expect(files).toContain("requests/models.py")
    expect(files).not.toContain("/etc/passwd")
  })

  test("if the leaky engine's ONLY facts are out-of-tree ⇒ null", async () => {
    const leaky = {
      supportsLanguage: (l: string) => l === "python",
      owners: () => [{ file: "/etc/passwd", basis: "leaked", strength: "high" as const }],
    }
    const p = staticOwnerProvider(leaky)
    const frag = await p.produce(ctx(), BUDGET)
    expect(frag).toBeNull()
  })
})

describe("staticOwnerProvider — budget", () => {
  test("owners capped at budget.maxOwners", async () => {
    const files = ["a.py", "b.py", "c.py", "d.py", "e.py", "f.py"]
    const p = staticOwnerProvider(
      engineWith(files.map((f) => ({ file: f, basis: "edge", strength: "medium" as const }))),
    )
    const frag = (await p.produce(ctx({ repoFiles: files }), {
      maxMillis: 500,
      maxOwners: 2,
    })) as ObservationFragment
    expect(frag.owners?.length).toBe(2)
    // Deterministic: the FIRST two facts survive (engine order is authority).
    expect(frag.owners?.map((o) => o.file)).toEqual(["a.py", "b.py"])
  })

  test("maxOwners 0 ⇒ null (no owners means no signal)", async () => {
    const p = staticOwnerProvider(
      engineWith([{ file: "requests/models.py", basis: "x", strength: "high" }]),
    )
    const frag = await p.produce(ctx(), { maxMillis: 500, maxOwners: 0 })
    expect(frag).toBeNull()
  })
})
