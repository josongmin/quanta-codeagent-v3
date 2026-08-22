/**
 * Observation pipeline HELLGATE (jul-6 S3). Design SSOT:
 * `docs/plans/jul-6-observation-providers/README.md` (§3).
 *
 * `gatherObservations(providers, ctx, policy)`:
 *   - filters by `applicable(ctx)` (non-applicable providers never `produce`),
 *   - runs `produce` respecting the per-provider budget,
 *   - merges/ranks/dedups owners by SOURCE authority (a policy order) — NO
 *     numeric-confidence merge (B2), dedup by (file,symbol),
 *   - returns an ObservationBundle (contributors = ids that produced signal).
 *
 * Vacuous guards: an ordering assertion, a dedup assertion, and a
 * "non-applicable provider is NOT produced" assertion each go RED if the
 * respective policy step is dropped.
 */

import { describe, expect, test } from "bun:test"
import type { ObservationFragment } from "@/agent/observation/fragment"
import { DEFAULT_SOURCE_AUTHORITY, gatherObservations } from "@/agent/observation/pipeline"
import type { ObservationProvider, ProviderBudget, TaskContext } from "@/agent/observation/port"

const ctx: TaskContext = {
  cwd: "/repo",
  issueText: "boom",
  repoFiles: ["a.py", "b.py", "c.py"],
  language: "python",
  capability: "source-repair",
}

/** A test provider that records whether it was produced. */
const mkProvider = (
  id: string,
  fragment: ObservationFragment | null,
  opts: {
    applicable?: boolean
    produced?: { hit: boolean }
    kind?: ObservationProvider["kind"]
  } = {},
): ObservationProvider => ({
  id,
  kind: opts.kind ?? "localization",
  applicable: () => opts.applicable ?? true,
  produce: async () => {
    if (opts.produced) opts.produced.hit = true
    return fragment
  },
})

describe("gatherObservations — applicable gate", () => {
  test("HARD: a non-applicable provider is NEVER produced", async () => {
    const marker = { hit: false }
    const p = mkProvider(
      "skip-me",
      { providerId: "skip-me", owners: [{ file: "a.py", evidence: "x", source: "skip-me" }] },
      {
        applicable: false,
        produced: marker,
      },
    )
    const bundle = await gatherObservations([p], ctx, { authority: DEFAULT_SOURCE_AUTHORITY })
    expect(marker.hit).toBe(false)
    expect(bundle.owners.length).toBe(0)
    expect(bundle.contributors).not.toContain("skip-me")
  })

  test("an applicable provider IS produced and contributes", async () => {
    const marker = { hit: false }
    const p = mkProvider(
      "run-me",
      {
        providerId: "run-me",
        owners: [{ file: "a.py", symbol: "f", evidence: "x", source: "run-me" }],
      },
      { applicable: true, produced: marker },
    )
    const bundle = await gatherObservations([p], ctx, { authority: DEFAULT_SOURCE_AUTHORITY })
    expect(marker.hit).toBe(true)
    expect(bundle.contributors).toContain("run-me")
    expect(bundle.owners.map((o) => o.file)).toContain("a.py")
  })

  test("a provider returning null contributes nothing (no owners, not a contributor)", async () => {
    const p = mkProvider("silent", null)
    const bundle = await gatherObservations([p], ctx, { authority: DEFAULT_SOURCE_AUTHORITY })
    expect(bundle.owners.length).toBe(0)
    expect(bundle.contributors).not.toContain("silent")
  })
})

describe("gatherObservations — SOURCE-authority ranking (NO numeric merge)", () => {
  test("HARD: owners are ordered by policy source authority, higher first", async () => {
    // llm-source owner listed FIRST in provider order, static-owner second —
    // policy must REORDER static above llm (authority > input order).
    const llmP = mkProvider("llm-first", {
      providerId: "agentless-localize",
      owners: [{ file: "llm.py", symbol: "L", evidence: "llm vibe", source: "agentless-localize" }],
    })
    const staticP = mkProvider("static-second", {
      providerId: "static-owner",
      owners: [{ file: "static.py", symbol: "S", evidence: "def-use", source: "static-owner" }],
    })
    const bundle = await gatherObservations([llmP, staticP], ctx, {
      authority: DEFAULT_SOURCE_AUTHORITY,
    })
    // static-owner outranks agentless-localize ⇒ appears first.
    expect(bundle.owners[0]?.source).toBe("static-owner")
    expect(bundle.owners[1]?.source).toBe("agentless-localize")
  })

  test("unknown source authority sorts AFTER known authorities (stable, no crash)", async () => {
    const knownP = mkProvider("known", {
      providerId: "static-owner",
      owners: [{ file: "known.py", evidence: "e", source: "static-owner" }],
    })
    const mysteryP = mkProvider("mystery", {
      providerId: "who",
      owners: [{ file: "mystery.py", evidence: "e", source: "unregistered-source" }],
    })
    const bundle = await gatherObservations([mysteryP, knownP], ctx, {
      authority: DEFAULT_SOURCE_AUTHORITY,
    })
    expect(bundle.owners[0]?.source).toBe("static-owner")
    expect(bundle.owners[bundle.owners.length - 1]?.source).toBe("unregistered-source")
  })
})

describe("gatherObservations — dedup by (file,symbol)", () => {
  test("HARD: same (file,symbol) from two providers ⇒ ONE owner (winner = higher authority)", async () => {
    const llmP = mkProvider("llm", {
      providerId: "agentless-localize",
      owners: [
        {
          file: "dup.py",
          symbol: "same",
          evidence: "llm reason",
          source: "agentless-localize",
          strength: "medium",
        },
      ],
    })
    const staticP = mkProvider("static", {
      providerId: "static-owner",
      owners: [
        {
          file: "dup.py",
          symbol: "same",
          evidence: "def-use edge",
          source: "static-owner",
          strength: "high",
        },
      ],
    })
    const bundle = await gatherObservations([llmP, staticP], ctx, {
      authority: DEFAULT_SOURCE_AUTHORITY,
    })
    const dupOwners = bundle.owners.filter((o) => o.file === "dup.py" && o.symbol === "same")
    expect(dupOwners.length).toBe(1)
    // Winner = higher authority = static-owner (its evidence, not the llm's).
    expect(dupOwners[0]?.source).toBe("static-owner")
    expect(dupOwners[0]?.evidence).toBe("def-use edge")
  })

  test("same file, DIFFERENT symbol ⇒ NOT deduped (two distinct owners)", async () => {
    const p = mkProvider("multi", {
      providerId: "static-owner",
      owners: [
        { file: "same.py", symbol: "alpha", evidence: "e1", source: "static-owner" },
        { file: "same.py", symbol: "beta", evidence: "e2", source: "static-owner" },
      ],
    })
    const bundle = await gatherObservations([p], ctx, { authority: DEFAULT_SOURCE_AUTHORITY })
    const sameFile = bundle.owners.filter((o) => o.file === "same.py")
    expect(sameFile.length).toBe(2)
  })

  test("file-only owner vs same-file-with-symbol are distinct keys (not deduped)", async () => {
    const p = mkProvider("mix", {
      providerId: "static-owner",
      owners: [
        { file: "x.py", evidence: "file-level", source: "static-owner" },
        { file: "x.py", symbol: "fn", evidence: "symbol-level", source: "static-owner" },
      ],
    })
    const bundle = await gatherObservations([p], ctx, { authority: DEFAULT_SOURCE_AUTHORITY })
    expect(bundle.owners.filter((o) => o.file === "x.py").length).toBe(2)
  })
})

describe("gatherObservations — budget", () => {
  test("per-provider maxOwners caps owners contributed by a single provider", async () => {
    const p = mkProvider("greedy", {
      providerId: "static-owner",
      owners: [
        { file: "1.py", evidence: "e", source: "static-owner" },
        { file: "2.py", evidence: "e", source: "static-owner" },
        { file: "3.py", evidence: "e", source: "static-owner" },
      ],
    })
    const bundle = await gatherObservations([p], ctx, {
      authority: DEFAULT_SOURCE_AUTHORITY,
      budget: { maxMillis: 1000, maxOwners: 2 },
    })
    expect(bundle.owners.length).toBe(2)
  })

  test("the budget passed to produce reflects policy.budget", async () => {
    let seen: ProviderBudget | undefined
    const p: ObservationProvider = {
      id: "spy",
      kind: "localization",
      applicable: () => true,
      produce: async (_ctx, budget) => {
        seen = budget
        return { providerId: "spy", owners: [{ file: "a.py", evidence: "e", source: "spy" }] }
      },
    }
    await gatherObservations([p], ctx, {
      authority: DEFAULT_SOURCE_AUTHORITY,
      budget: { maxMillis: 42, maxOwners: 7 },
    })
    expect(seen?.maxMillis).toBe(42)
    expect(seen?.maxOwners).toBe(7)
  })
})

describe("gatherObservations — impact/scope merge", () => {
  test("first provider's impact/scope surface into the bundle", async () => {
    const p = mkProvider("rich", {
      providerId: "static-owner",
      owners: [{ file: "a.py", evidence: "e", source: "static-owner" }],
      impact: { likelyRuntimePaths: ["p"], riskyCallers: ["c"], testsNotToEdit: ["t"] },
      scope: { allow: ["a.py"], avoid: ["tests/"] },
    })
    const bundle = await gatherObservations([p], ctx, { authority: DEFAULT_SOURCE_AUTHORITY })
    expect(bundle.impact?.likelyRuntimePaths).toEqual(["p"])
    expect(bundle.scope?.avoid).toEqual(["tests/"])
  })

  test("an impact-ONLY provider (no owners) still counts as a contributor + surfaces impact", async () => {
    const p = mkProvider(
      "impact-only",
      {
        providerId: "callgraph-impact",
        impact: { likelyRuntimePaths: ["x"], riskyCallers: [], testsNotToEdit: [] },
      },
      { kind: "impact" },
    )
    const bundle = await gatherObservations([p], ctx, { authority: DEFAULT_SOURCE_AUTHORITY })
    expect(bundle.owners.length).toBe(0)
    expect(bundle.impact?.likelyRuntimePaths).toEqual(["x"])
    expect(bundle.contributors).toContain("callgraph-impact")
  })

  test("contracts surface through the merge", async () => {
    const p = mkProvider("contractual", {
      providerId: "static-owner",
      owners: [{ file: "a.py", evidence: "e", source: "static-owner" }],
      contracts: [{ adjacent: "must raise InvalidURL", raises: ["InvalidURL"] }],
    })
    const bundle = await gatherObservations([p], ctx, { authority: DEFAULT_SOURCE_AUTHORITY })
    expect(bundle.contracts?.[0]?.adjacent).toBe("must raise InvalidURL")
  })
})
