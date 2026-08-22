/**
 * PMX-02 — the nested sample family `PMX-7 ⊂ PMX-14 ⊂ PMX-40 ⊂ PMX-170`.
 *
 * Every assertion here observes the REAL generator on a corpus with the real
 * upstream language distribution (C 20 / C++ 22 / Go 23 / Java 26 / Python 29 /
 * Rust 22 / TypeScript 28 = 170). Nothing is asserted about the implementation's
 * shape; only about the properties the campaign depends on:
 *
 *   nesting, determinism, seed/version sensitivity, quota exactness, and
 *   fail-closed refusal when the corpus cannot satisfy a quota.
 */
import { describe, expect, test } from "bun:test"
import {
  buildProMaxSampleFamily,
  buildProMaxSampleManifest,
  PROMAX_SAMPLE_ALGORITHM_VERSION,
  PROMAX_SAMPLE_SPECS,
  type ProMaxSampleCandidate,
  ProMaxSampleError,
} from "@/apps/bench/promax/corpus"
import {
  buildSyntheticProMaxCorpus,
  PMX_40_QUOTAS,
  PROMAX_LANGUAGE_COUNTS,
} from "./promax-corpus-fixture"

const REVISION = "8ee33ee5321b3572cc6c20e3a2392f04683174b2"

const candidates = (): ProMaxSampleCandidate[] =>
  buildSyntheticProMaxCorpus().rows.map((row) => ({
    instanceId: String(row.instance_id),
    language: String(row.language),
  }))

const familyFor = (over: Partial<Parameters<typeof buildProMaxSampleFamily>[0]> = {}) =>
  buildProMaxSampleFamily({ candidates: candidates(), datasetRevision: REVISION, ...over })

const byName = (over: Partial<Parameters<typeof buildProMaxSampleFamily>[0]> = {}) => {
  const map = new Map(familyFor(over).map((m) => [m.name, m]))
  return map
}

const languageHistogram = (ids: readonly string[], all: ProMaxSampleCandidate[]) => {
  const lang = new Map(all.map((c) => [c.instanceId, c.language]))
  const out: Record<string, number> = {}
  for (const id of ids) {
    const l = lang.get(id)
    if (l !== undefined) out[l] = (out[l] ?? 0) + 1
  }
  return out
}

describe("PMX-02 — the sample family is NESTED", () => {
  const family = familyFor()
  const all = candidates()

  test("the four named samples exist, in nesting order, at the right sizes", () => {
    expect(family.map((m) => m.name)).toEqual(["PMX-7", "PMX-14", "PMX-40", "PMX-170"])
    expect(family.map((m) => m.instanceIds.length)).toEqual([7, 14, 40, 170])
  })

  test("PMX-7 ⊂ PMX-14 ⊂ PMX-40 ⊂ PMX-170 — every containment, explicitly", () => {
    for (let i = 0; i + 1 < family.length; i += 1) {
      const child = family[i]
      const parent = family[i + 1]
      if (child === undefined || parent === undefined) throw new Error("family truncated")
      const parentSet = new Set(parent.instanceIds)
      for (const id of child.instanceIds) {
        expect(parentSet.has(id), `${parent.name} must contain ${child.name}'s ${id}`).toBe(true)
      }
      // …and it is a STRICT superset, so containment is not the trivial "equal".
      expect(parent.instanceIds.length).toBeGreaterThan(child.instanceIds.length)
    }
  })

  test("each manifest names the digest of the sample it contains", () => {
    expect(family[0]?.parentSubsetSha256).toBeNull()
    for (let i = 1; i < family.length; i += 1) {
      expect(family[i]?.parentSubsetSha256).toBe(family[i - 1]?.sha256 ?? "@@missing@@")
    }
    // the recorded digests are distinct, so the chain is not a constant
    expect(new Set(family.map((m) => m.sha256)).size).toBe(family.length)
  })

  test("language quotas are EXACT — 1/language, 2/language, the ticket's table, then all", () => {
    const [seven, fourteen, forty, full] = family
    if (
      seven === undefined ||
      fourteen === undefined ||
      forty === undefined ||
      full === undefined
    ) {
      throw new Error("family truncated")
    }
    expect(languageHistogram(seven.instanceIds, all)).toEqual(
      Object.fromEntries(Object.keys(PROMAX_LANGUAGE_COUNTS).map((l) => [l, 1])),
    )
    expect(languageHistogram(fourteen.instanceIds, all)).toEqual(
      Object.fromEntries(Object.keys(PROMAX_LANGUAGE_COUNTS).map((l) => [l, 2])),
    )
    expect(languageHistogram(forty.instanceIds, all)).toEqual(PMX_40_QUOTAS)
    expect(languageHistogram(full.instanceIds, all)).toEqual(PROMAX_LANGUAGE_COUNTS)
    // the manifests DECLARE the same quotas they realized
    expect(forty.languageQuotas).toEqual(PMX_40_QUOTAS)
    expect(full.languageQuotas).toEqual(PROMAX_LANGUAGE_COUNTS)
  })

  test("every manifest records revision, seed, algorithm version and ordered ids", () => {
    for (const manifest of family) {
      expect(manifest.datasetRevision).toBe(REVISION)
      expect(manifest.seed).toBeTruthy()
      expect(manifest.algorithmVersion).toBe(PROMAX_SAMPLE_ALGORITHM_VERSION)
      expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(new Set(manifest.instanceIds).size).toBe(manifest.instanceIds.length)
    }
  })
})

describe("PMX-02 — the sample family is DETERMINISTIC and seed/version sensitive", () => {
  test("regenerating for the same revision+seed is byte-identical", () => {
    expect(JSON.stringify(familyFor())).toBe(JSON.stringify(familyFor()))
    // …and it does not depend on CANDIDATE ORDER (a re-read of the same corpus in
    // a different order must not redraw the sample).
    const shuffled = [...candidates()].reverse()
    expect(
      JSON.stringify(buildProMaxSampleFamily({ candidates: shuffled, datasetRevision: REVISION })),
    ).toBe(JSON.stringify(familyFor()))
  })

  test("changing the SEED changes every manifest digest AND the drawn ids", () => {
    const base = byName()
    const other = byName({ seed: "different-seed" })
    for (const name of ["PMX-7", "PMX-14", "PMX-40"]) {
      const a = base.get(name)
      const b = other.get(name)
      expect(a?.sha256).not.toBe(b?.sha256)
      expect(a?.instanceIds).not.toEqual(b?.instanceIds ?? [])
    }
    // PMX-170 is every id, so its SET cannot move — but its manifest digest MUST,
    // because the recorded seed is part of what it seals.
    expect(base.get("PMX-170")?.sha256).not.toBe(other.get("PMX-170")?.sha256)
    expect(new Set(base.get("PMX-170")?.instanceIds)).toEqual(
      new Set(other.get("PMX-170")?.instanceIds),
    )
  })

  test("changing the ALGORITHM VERSION changes the digest and the draw", () => {
    const base = byName()
    const v2 = byName({ algorithmVersion: "promax-sample/v2-probe" })
    expect(base.get("PMX-7")?.sha256).not.toBe(v2.get("PMX-7")?.sha256)
    expect(base.get("PMX-7")?.instanceIds).not.toEqual(v2.get("PMX-7")?.instanceIds ?? [])
  })

  test("changing the DATASET REVISION changes the digest and the draw", () => {
    const base = byName()
    const other = byName({ datasetRevision: `${"a".repeat(40)}` })
    expect(base.get("PMX-40")?.sha256).not.toBe(other.get("PMX-40")?.sha256)
    expect(base.get("PMX-40")?.instanceIds).not.toEqual(other.get("PMX-40")?.instanceIds ?? [])
  })
})

describe("PMX-02 — the sample generator is FAIL-CLOSED", () => {
  test("a language the PMX-40 quota table does not cover is REFUSED, not silently dropped", () => {
    // Enough of the new language that the uniform PMX-7/PMX-14 quotas are
    // satisfiable — so the refusal comes from PMX-40's TABLE not covering it,
    // which is the case that would otherwise silently drop a whole language from
    // a "language-stratified" sample.
    const withExtra = [
      ...candidates(),
      ...Array.from({ length: 9 }, (_v, i) => ({
        instanceId: `promax__kotlin-${String(i + 1).padStart(3, "0")}`,
        language: "kotlin",
      })),
    ]
    let message = ""
    try {
      buildProMaxSampleFamily({ candidates: withExtra, datasetRevision: REVISION })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/kotlin/)
    expect(message).toMatch(/PMX-40/)
    expect(message).toMatch(/quota table does not cover/)
  })

  test("too few rows of a covered language is REFUSED at the FIRST unsatisfiable sample", () => {
    const withOne = [...candidates(), { instanceId: "promax__kotlin-001", language: "kotlin" }]
    let message = ""
    try {
      buildProMaxSampleFamily({ candidates: withOne, datasetRevision: REVISION })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/kotlin/)
    expect(message).toMatch(/REFUSING to emit an under-filled sample/)
  })

  test("a quota larger than the corpus is REFUSED, not under-filled", () => {
    const thin = candidates().filter((c) => c.language !== "python" || c.instanceId.endsWith("001"))
    expect(() => buildProMaxSampleFamily({ candidates: thin, datasetRevision: REVISION })).toThrow(
      ProMaxSampleError,
    )
  })

  test("a quota naming a language the corpus lacks is REFUSED", () => {
    const noRust = candidates().filter((c) => c.language !== "rust")
    let message = ""
    try {
      buildProMaxSampleFamily({ candidates: noRust, datasetRevision: REVISION })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/rust/)
  })

  test("duplicate candidate ids are REFUSED (a dup would make ⊂ an accident)", () => {
    const dup = candidates()
    dup.push({ ...(dup[0] ?? { instanceId: "x", language: "c" }) })
    expect(() => buildProMaxSampleFamily({ candidates: dup, datasetRevision: REVISION })).toThrow(
      /duplicate candidate/i,
    )
  })

  test("PAIRED CONTROL — the real distribution builds all four samples cleanly", () => {
    expect(familyFor().map((m) => m.instanceIds.length)).toEqual([7, 14, 40, 170])
  })
})

describe("PMX-02 — one implementation owns ordering and quotas", () => {
  test("a single manifest built alone matches the family's member exactly", () => {
    const spec = PROMAX_SAMPLE_SPECS.find((s) => s.name === "PMX-40")
    if (spec === undefined) throw new Error("PMX-40 spec missing")
    const alone = buildProMaxSampleManifest({
      candidates: candidates(),
      datasetRevision: REVISION,
      spec,
      parentSubsetSha256: byName().get("PMX-14")?.sha256 ?? null,
    })
    expect(alone).toEqual(byName().get("PMX-40") ?? ({} as never))
  })
})
