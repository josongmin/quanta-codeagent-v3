/**
 * PMX-00 — fail-closed bundle verification.
 *
 * Every test drives the REAL `verifyProMaxBundle` over real fixture bytes and
 * observes the returned verdict. No source-string scanning, no single-literal
 * narrowing: each failure case starts from the known-good bundle and changes
 * exactly ONE thing, so a passing assertion pins that one check.
 */
import { describe, expect, test } from "bun:test"
import type { ProMaxBundleSources, ProMaxVerification } from "@/apps/bench/promax/provenance"
import {
  PROMAX_V1_SNAPSHOT,
  requireExplicitBundleRoot,
  requirePinnedCommit,
  verifyProMaxBundle,
} from "@/apps/bench/promax/provenance"
import { buildFixtureBundle, type FixtureBundle, oracleSha256 } from "./promax-bundle-fixture"

/** Verify a fixture bundle under its own approval policy (see FixtureBundle). */
const verify = (b: FixtureBundle, override?: Partial<ProMaxBundleSources>): ProMaxVerification =>
  verifyProMaxBundle({ ...b.sources, ...override }, b.policy)

const codesOf = (v: ProMaxVerification): readonly string[] =>
  v.ok ? [] : v.failures.map((f) => f.code)

const messagesOf = (v: ProMaxVerification): string =>
  v.ok ? "" : v.failures.map((f) => f.message).join(" | ")

describe("PMX-00 known-good bundle", () => {
  const built = buildFixtureBundle()
  const verdict = verify(built)

  test("the 170-row fixture manifest validates", () => {
    // print the refusals when this regresses — a bare `.ok` assertion is useless
    // for diagnosis and invites the "just make it green" fix.
    expect(messagesOf(verdict)).toBe("")
    expect(verdict.ok).toBe(true)
  })

  test("a verified bundle exposes the sorted 170 ids and nothing else from the rows", () => {
    if (!verdict.ok) throw new Error(`expected ok verdict, got: ${messagesOf(verdict)}`)
    expect(verdict.instanceIds.length).toBe(170)
    expect(verdict.instanceIds).toEqual([...built.datasetIds].sort())
    // identity only — no gold-bearing row content may ride the verdict out.
    const serialized = JSON.stringify(verdict)
    expect(serialized).not.toContain("SYNTHETIC-NOT-GOLD")
    expect(serialized).not.toContain("SYNTHETIC-EVAL")
  })

  test("manifestSha256 is the digest of the EXACT manifest bytes supplied", () => {
    if (!verdict.ok) throw new Error("expected ok verdict")
    expect(verdict.manifestSha256).toBe(oracleSha256(built.manifestJson))
  })

  test("the verdict carries the frozen upstream identity for reproduction", () => {
    if (!verdict.ok) throw new Error("expected ok verdict")
    expect(verdict.manifest.upstream_git_commit).toBe(PROMAX_V1_SNAPSHOT.upstream_git_commit)
    expect(verdict.manifest.hf_dataset_revision).toBe(PROMAX_V1_SNAPSHOT.hf_dataset_revision)
    expect(verdict.manifest.dataset_count).toBe(170)
  })

  test("sparse optional upstream fields (pull_number/issue_numbers) do not fail the bundle", () => {
    // Real upstream rows are NOT key-uniform: 104/170 carry pull_number, 3/170
    // carry issue_numbers. A validator that required them would reject the real
    // corpus, so the fixture reproduces the sparsity and this pins acceptance.
    const stripped = buildFixtureBundle({
      dataset: (rows) =>
        rows.map((r) => {
          const { pull_number: _p, issue_numbers: _i, ...rest } = r
          return rest
        }),
    })
    expect(messagesOf(verify(stripped))).toBe("")
  })

  test("created_at is accepted as a NUMBER, as real upstream stores it", () => {
    const asString = buildFixtureBundle({
      dataset: (rows) => rows.map((r) => ({ ...r, created_at: String(r.created_at) })),
    })
    const v = verify(asString)
    expect(codesOf(v)).toContain("dataset_field_invalid")
    expect(messagesOf(v)).toContain("created_at")
  })
})

describe("PMX-00 id-set integrity", () => {
  test("one missing eval id fails, and the failure NAMES that id", () => {
    const missing = "ETLCPP__etl-955"
    const built = buildFixtureBundle({
      evalMap: (m) => {
        const { [missing]: _dropped, ...rest } = m
        return rest
      },
    })
    const v = verify(built)
    expect(v.ok).toBe(false)
    expect(codesOf(v)).toContain("id_set_unequal")
    expect(messagesOf(v)).toContain(missing)
  })

  test("a duplicate dataset id fails and names it", () => {
    const dup = "CESNET__libyang-c_8d3d805"
    const built = buildFixtureBundle({
      dataset: (rows) => {
        const first = rows[0]
        if (first === undefined) throw new Error("fixture has no rows")
        return [...rows, { ...first, instance_id: dup }]
      },
    })
    const v = verify(built)
    expect(v.ok).toBe(false)
    expect(codesOf(v)).toContain("instance_id_duplicated")
    expect(messagesOf(v)).toContain(dup)
  })

  test("a blank instance_id fails", () => {
    const built = buildFixtureBundle({
      dataset: (rows) => rows.map((r, i) => (i === 5 ? { ...r, instance_id: "  " } : r)),
    })
    expect(codesOf(verify(built))).toContain("instance_id_invalid")
  })

  test("an eval map key that disagrees with its record's instance_id fails", () => {
    const built = buildFixtureBundle({
      evalMap: (m) => {
        const key = "ETLCPP__etl-955"
        const rec = m[key]
        if (rec === undefined) throw new Error("fixture missing eval key")
        return { ...m, [key]: { ...rec, instance_id: "some-other-id" } }
      },
    })
    expect(codesOf(verify(built))).toContain("eval_key_mismatch")
  })

  test("an empty eval_script fails and names the instance", () => {
    const target = "ETLCPP__etl-955"
    const built = buildFixtureBundle({
      evalMap: (m) => ({ ...m, [target]: { instance_id: target, eval_script: "   " } }),
    })
    const v = verify(built)
    expect(codesOf(v)).toContain("eval_script_missing")
    expect(messagesOf(v)).toContain(target)
  })

  test("a dataset count that disagrees with the manifest fails", () => {
    const built = buildFixtureBundle({ manifest: (m) => ({ ...m, dataset_count: 169 }) })
    const v = verify(built)
    expect(codesOf(v)).toContain("dataset_count_mismatch")
    expect(messagesOf(v)).toMatch(/169/)
  })

  test("an id digest that disagrees with the manifest fails", () => {
    const built = buildFixtureBundle({
      manifest: (m) => ({ ...m, dataset_ids_sha256: "f".repeat(64) }),
    })
    expect(codesOf(verify(built))).toContain("ids_digest_mismatch")
  })

  test("language counts that disagree with the manifest fail", () => {
    const built = buildFixtureBundle({
      manifest: (m) => ({
        ...m,
        language_counts: { ...PROMAX_V1_SNAPSHOT.language_counts, c: 19 },
      }),
    })
    const v = verify(built)
    expect(codesOf(v)).toContain("language_counts_mismatch")
    expect(messagesOf(v)).toContain("`c`")
  })
})

describe("PMX-00 content hashes — verified BEFORE any run", () => {
  test("a one-byte evaluator mutation fails its sha256", () => {
    const built = buildFixtureBundle({
      // flip exactly one byte, keeping the length identical
      tamper: { evaluator: (b) => `${b.slice(0, 10)}X${b.slice(11)}` },
    })
    const v = verify(built)
    expect(built.sources.evaluator).not.toBe(built.evaluatorSource)
    expect(String(built.sources.evaluator).length).toBe(built.evaluatorSource.length)
    expect(v.ok).toBe(false)
    expect(codesOf(v)).toContain("evaluator_hash_mismatch")
    expect(messagesOf(v)).toContain("evaluator")
    // the refusal names the EXPECTED digest so an operator can diff it
    expect(messagesOf(v)).toContain(oracleSha256(built.evaluatorSource))
  })

  test("a mutated dataset file fails its sha256", () => {
    const built = buildFixtureBundle({ tamper: { dataset: (b) => `${b} ` } })
    expect(codesOf(verify(built))).toContain("dataset_hash_mismatch")
  })

  test("a mutated eval file fails its sha256", () => {
    const built = buildFixtureBundle({ tamper: { evalMeta: (b) => `${b} ` } })
    expect(codesOf(verify(built))).toContain("eval_hash_mismatch")
  })

  test("upstream and Hugging Face copies with unequal hashes fail", () => {
    const built = buildFixtureBundle({ hf: { dataset: (b) => `${b} ` } })
    const v = verify(built)
    expect(v.ok).toBe(false)
    expect(codesOf(v)).toContain("cross_source_mismatch")
    expect(messagesOf(v)).toContain("dataset")
  })

  test("an unequal HF eval copy fails too", () => {
    const built = buildFixtureBundle({ hf: { evalMeta: (b) => `${b} ` } })
    expect(codesOf(verify(built))).toContain("cross_source_mismatch")
  })

  test("omitting the HF copies still verifies the GitHub bundle", () => {
    // an absent second source is allowed, but it must not be silently reported
    // as a cross-source agreement.
    const built = buildFixtureBundle({ hf: { include: false } })
    expect(built.sources.hfDataset).toBeUndefined()
    expect(messagesOf(verify(built))).toBe("")
  })
})

describe("PMX-00 checkout must be detached at the declared commit", () => {
  test("a non-detached checkout on main fails", () => {
    const built = buildFixtureBundle({ checkout: { detached: false, ref: "main" } })
    const v = verify(built)
    expect(codesOf(v)).toContain("checkout_not_detached")
    expect(messagesOf(v)).toContain("main")
  })

  test("a detached checkout at the WRONG commit fails and names both commits", () => {
    const wrong = "a".repeat(40)
    const built = buildFixtureBundle({ checkout: { headCommit: wrong } })
    const v = verify(built)
    expect(codesOf(v)).toContain("checkout_commit_mismatch")
    expect(messagesOf(v)).toContain(wrong)
    expect(messagesOf(v)).toContain(PROMAX_V1_SNAPSHOT.upstream_git_commit)
  })
})

describe("PMX-00 manifest schema is fail-closed", () => {
  test("unparseable manifest bytes are refused, not thrown through", () => {
    const built = buildFixtureBundle()
    const v = verify(built, { manifest: "{not json" })
    expect(v.ok).toBe(false)
    expect(codesOf(v)).toContain("manifest_unparseable")
  })

  test("each required manifest field is load-bearing when absent", () => {
    const required = [
      "schema_version",
      "captured_at",
      "upstream_repo_url",
      "upstream_git_commit",
      "hf_repo_id",
      "hf_dataset_revision",
      "dataset_path",
      "dataset_sha256",
      "eval_path",
      "eval_sha256",
      "evaluator_path",
      "evaluator_sha256",
      "dataset_count",
      "dataset_ids_sha256",
      "eval_ids_sha256",
      "language_counts",
    ] as const
    for (const field of required) {
      const built = buildFixtureBundle({
        manifest: (m) => {
          const copy = { ...m }
          delete copy[field]
          return copy
        },
      })
      const v = verify(built)
      expect(v.ok).toBe(false)
      expect(messagesOf(v)).toContain(field)
    }
  })

  test("a mistyped manifest field is refused (dataset_count as a string)", () => {
    const built = buildFixtureBundle({ manifest: (m) => ({ ...m, dataset_count: "170" }) })
    expect(codesOf(verify(built))).toContain("manifest_field_invalid")
  })

  test("a manifest that drifts from its approved snapshot is refused", () => {
    const built = buildFixtureBundle({
      manifest: (m) => ({ ...m, dataset_sha256: "b".repeat(64) }),
    })
    const v = verify(built)
    expect(v.ok).toBe(false)
    expect(codesOf(v)).toContain("snapshot_drift")
  })

  test("a manifest for an UNAPPROVED upstream commit is refused even if self-consistent", () => {
    // the whole bundle re-hashes cleanly; only the identity is unapproved.
    const unapprovedCommit = "c".repeat(40)
    const built = buildFixtureBundle({
      manifest: (m) => ({ ...m, upstream_git_commit: unapprovedCommit }),
      checkout: { headCommit: unapprovedCommit },
    })
    const v = verify(built)
    expect(v.ok).toBe(false)
    expect(codesOf(v)).toContain("snapshot_drift")
    expect(messagesOf(v)).toContain(unapprovedCommit)
    expect(messagesOf(v)).toMatch(/APPROVED/)
    // and it is NOT merely the checkout check firing
    expect(codesOf(v)).not.toContain("checkout_commit_mismatch")
  })
})

describe("PMX-00 no fallback to main / latest / an unverified local file", () => {
  test("a moving ref in the manifest is refused, not resolved", () => {
    for (const moving of ["main", "master", "HEAD", "latest", "refs/heads/main"]) {
      const built = buildFixtureBundle({
        manifest: (m) => ({ ...m, upstream_git_commit: moving }),
      })
      const v = verify(built)
      expect(v.ok).toBe(false)
      expect(codesOf(v)).toContain("selector_unpinned")
      expect(messagesOf(v)).toContain(moving)
    }
  })

  test("a moving HF revision is refused", () => {
    const built = buildFixtureBundle({
      manifest: (m) => ({ ...m, hf_dataset_revision: "main" }),
    })
    expect(codesOf(verify(built))).toContain("selector_unpinned")
  })

  test("requirePinnedCommit THROWS on an empty selector instead of defaulting", () => {
    for (const empty of [undefined, "", "   "]) {
      expect(() => requirePinnedCommit(empty, "upstream_git_commit")).toThrow(/upstream_git_commit/)
    }
  })

  test("requirePinnedCommit THROWS on main/latest and returns a pinned 40-hex unchanged", () => {
    for (const moving of ["main", "latest", "HEAD", "v2", "8ee33ee"]) {
      expect(() => requirePinnedCommit(moving, "hf_dataset_revision")).toThrow()
    }
    expect(requirePinnedCommit(PROMAX_V1_SNAPSHOT.upstream_git_commit, "c")).toBe(
      PROMAX_V1_SNAPSHOT.upstream_git_commit,
    )
    // case-insensitive hex is still pinned
    expect(requirePinnedCommit(PROMAX_V1_SNAPSHOT.upstream_git_commit.toUpperCase(), "c")).toBe(
      PROMAX_V1_SNAPSHOT.upstream_git_commit,
    )
  })

  test("requireExplicitBundleRoot THROWS rather than defaulting to a search path", () => {
    for (const empty of [undefined, "", "   "]) {
      expect(() => requireExplicitBundleRoot(empty)).toThrow(/bundle root/i)
    }
    expect(requireExplicitBundleRoot("/frozen/promax/v1")).toBe("/frozen/promax/v1")
  })
})

describe("PMX-00 corpus shape is fail-closed", () => {
  test("a dataset that is not a JSON array is refused", () => {
    const built = buildFixtureBundle()
    expect(codesOf(verify(built, { dataset: '{"rows":[]}' }))).toContain("dataset_unparseable")
  })

  test("an eval payload that is not an object map is refused", () => {
    const built = buildFixtureBundle()
    expect(codesOf(verify(built, { evalMeta: "[]" }))).toContain("eval_unparseable")
  })

  test("a required dataset field with the wrong primitive type is refused and named", () => {
    const built = buildFixtureBundle({
      dataset: (rows) => rows.map((r, i) => (i === 2 ? { ...r, image_name: 42 } : r)),
    })
    const v = verify(built)
    expect(codesOf(v)).toContain("dataset_field_invalid")
    expect(messagesOf(v)).toContain("image_name")
  })

  test("multiple independent defects are all reported, not just the first", () => {
    const built = buildFixtureBundle({
      dataset: (rows) => rows.map((r, i) => (i === 1 ? { ...r, working_dir: null } : r)),
      evalMap: (m) => {
        const key = "ETLCPP__etl-955"
        return { ...m, [key]: { instance_id: key, eval_script: "" } }
      },
    })
    const codes = codesOf(verify(built))
    expect(codes).toContain("dataset_field_invalid")
    expect(codes).toContain("eval_script_missing")
  })

  test("a flood of one defect never hides a different defect's code", () => {
    // every row mistyped (170 defects) PLUS one eval defect: per-code capping
    // must keep the eval code visible in the verdict.
    const built = buildFixtureBundle({
      dataset: (rows) => rows.map((r) => ({ ...r, repo: 1 })),
      evalMap: (m) => {
        const key = "ETLCPP__etl-955"
        return { ...m, [key]: { instance_id: key, eval_script: "" } }
      },
    })
    const v = verify(built)
    expect(codesOf(v)).toContain("dataset_field_invalid")
    expect(codesOf(v)).toContain("eval_script_missing")
    // and the flood is summarized rather than emitted 170 times
    expect(codesOf(v).filter((c) => c === "dataset_field_invalid").length).toBeLessThan(170)
    expect(messagesOf(v)).toMatch(/further `dataset_field_invalid` defect/)
  })
})
