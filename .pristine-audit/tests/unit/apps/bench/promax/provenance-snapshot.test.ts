/**
 * PMX-00 — frozen snapshot identity, digest convention, and the ANTI-VACUUM
 * anchor that keeps the hermetic fixture honest.
 *
 * A 170-row fixture that is merely self-consistent proves nothing: it would
 * still validate if it described 170 rows of invented nonsense. These tests tie
 * the fixture to the REAL frozen corpus by reproducing, from the fixture's own
 * ids, the upstream set digest that was recorded independently (and re-verified
 * against live upstream on 2026-08-22).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  DEFAULT_APPROVED_SNAPSHOTS,
  instanceIdSetDigest,
  isPinnedCommit,
  PROMAX_FAILURE_CODES,
  PROMAX_FAILURE_REASONS,
  PROMAX_V1_SNAPSHOT,
  parseManifest,
  sha256Hex,
  verifyProMaxBundle,
} from "@/apps/bench/promax/provenance"
import { buildFixtureBundle, oracleIdSetDigest, oracleSha256 } from "./promax-bundle-fixture"
import { PROMAX_V1_ID_LANGUAGE_ROWS, PROMAX_V1_INSTANCE_IDS } from "./promax-v1-ids"

describe("PMX-00 anti-vacuum — the fixture describes the REAL frozen corpus", () => {
  test("the fixture id list is exactly the frozen 170", () => {
    expect(PROMAX_V1_INSTANCE_IDS.length).toBe(170)
    expect(PROMAX_V1_INSTANCE_IDS.length).toBe(PROMAX_V1_SNAPSHOT.dataset_count)
    expect(new Set(PROMAX_V1_INSTANCE_IDS).size).toBe(170)
  })

  test("the fixture contains specific KNOWN upstream ids (not invented rows)", () => {
    // Spot anchors spanning several languages of the real corpus. If the
    // generated table were regenerated from anything but the frozen snapshot,
    // these named ids would go missing.
    for (const known of [
      "CESNET__libyang-c_8d3d805",
      "ETLCPP__etl-955",
      "OpenListTeam__OpenList-1001",
    ]) {
      expect(PROMAX_V1_INSTANCE_IDS).toContain(known)
    }
  })

  test("id-set digest of the fixture ids reproduces the frozen upstream digest", () => {
    // THE anti-vacuum assertion: this value was computed from the real 170-row
    // upstream corpus, not from the fixture. Agreement is only possible if the
    // fixture carries the true id set AND the digest convention is right.
    expect(oracleIdSetDigest(PROMAX_V1_INSTANCE_IDS)).toBe(PROMAX_V1_SNAPSHOT.ids_sha256)
    expect(PROMAX_V1_SNAPSHOT.ids_sha256).toBe(
      "19944e595bcace14b7dd77a341367dc6b93f2d40758854472c50ba6c1adad8ff",
    )
  })

  test("the shipped digest function agrees with the independent oracle", () => {
    expect(instanceIdSetDigest(PROMAX_V1_INSTANCE_IDS)).toBe(PROMAX_V1_SNAPSHOT.ids_sha256)
  })

  test("id-set digest is order-insensitive but content-sensitive", () => {
    const shuffled = [...PROMAX_V1_INSTANCE_IDS].reverse()
    expect(instanceIdSetDigest(shuffled)).toBe(instanceIdSetDigest(PROMAX_V1_INSTANCE_IDS))
    const dropped = PROMAX_V1_INSTANCE_IDS.slice(1)
    expect(instanceIdSetDigest(dropped)).not.toBe(instanceIdSetDigest(PROMAX_V1_INSTANCE_IDS))
  })

  test("fixture language counts reproduce the frozen language distribution", () => {
    const counts: Record<string, number> = {}
    for (const [, lang] of PROMAX_V1_ID_LANGUAGE_ROWS) counts[lang] = (counts[lang] ?? 0) + 1
    expect(counts).toEqual({ ...PROMAX_V1_SNAPSHOT.language_counts })
    // and the frozen record itself is the audited C20/C++22/Go23/Java26/Py29/Rust22/TS28
    expect(Object.values(PROMAX_V1_SNAPSHOT.language_counts).reduce((a, b) => a + b, 0)).toBe(170)
  })
})

describe("PMX-00 sha256Hex — real hashing, string and byte inputs agree", () => {
  test("hashes UTF-8 bytes to the known sha256 of the empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  })

  test("string and Uint8Array inputs hash identically", () => {
    const text = "promax-provenance ✅ non-ascii"
    expect(sha256Hex(text)).toBe(sha256Hex(new TextEncoder().encode(text)))
    expect(sha256Hex(text)).toBe(oracleSha256(text))
  })

  test("a one-byte difference changes the digest", () => {
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"))
  })
})

describe("PMX-00 default approval registry is real, not permissive", () => {
  test("the production default approves exactly the re-verified v1 snapshot", () => {
    expect(DEFAULT_APPROVED_SNAPSHOTS).toEqual([PROMAX_V1_SNAPSHOT])
  })

  test("a self-consistent bundle whose CONTENT is not the approved v1 is refused by default", () => {
    // The fixture's file bodies are synthetic, so its content hashes cannot be
    // the approved ones. Verified with NO policy argument, the production
    // registry must refuse it — proving a hand-rolled manifest cannot
    // self-authorize just by being internally consistent.
    const { sources } = buildFixtureBundle()
    const v = verifyProMaxBundle(sources)
    expect(v.ok).toBe(false)
    if (v.ok) throw new Error("unreachable")
    expect(v.failures.map((f) => f.code)).toContain("snapshot_drift")
  })
})

describe("PMX-00 the shipped frozen manifest is the same freeze as the code constants", () => {
  // The repo stores exactly two things about upstream: the TypeScript snapshot
  // constants and this JSON manifest. Two representations of one freeze can
  // drift, so this reads the real bytes and pins them together.
  const manifestPath = join(
    import.meta.dir,
    "../../../../../src/apps/bench/promax/provenance/manifests/promax-v1-170.manifest.json",
  )
  const raw = readFileSync(manifestPath, "utf8")

  test("it parses under the shipped fail-closed schema", () => {
    const parsed = parseManifest(raw)
    if (!parsed.ok) {
      throw new Error(
        `shipped manifest is invalid: ${parsed.failures.map((f) => f.message).join(" | ")}`,
      )
    }
    expect(parsed.ok).toBe(true)
  })

  test("every identity field agrees with PROMAX_V1_SNAPSHOT", () => {
    const parsed = parseManifest(raw)
    if (!parsed.ok) throw new Error("shipped manifest is invalid")
    const m = parsed.manifest
    expect(m.upstream_repo_url).toBe(PROMAX_V1_SNAPSHOT.upstream_repo_url)
    expect(m.upstream_git_commit).toBe(PROMAX_V1_SNAPSHOT.upstream_git_commit)
    expect(m.hf_repo_id).toBe(PROMAX_V1_SNAPSHOT.hf_repo_id)
    expect(m.hf_dataset_revision).toBe(PROMAX_V1_SNAPSHOT.hf_dataset_revision)
    expect(m.dataset_sha256).toBe(PROMAX_V1_SNAPSHOT.dataset_sha256)
    expect(m.eval_sha256).toBe(PROMAX_V1_SNAPSHOT.eval_sha256)
    expect(m.evaluator_sha256).toBe(PROMAX_V1_SNAPSHOT.evaluator_sha256)
    expect(m.dataset_count).toBe(PROMAX_V1_SNAPSHOT.dataset_count)
    expect(m.dataset_ids_sha256).toBe(PROMAX_V1_SNAPSHOT.ids_sha256)
    // dataset and eval id sets are EQUAL at this snapshot, so both digests match
    expect(m.eval_ids_sha256).toBe(PROMAX_V1_SNAPSHOT.ids_sha256)
    expect(m.language_counts).toEqual({ ...PROMAX_V1_SNAPSHOT.language_counts })
  })

  test("its selectors are pinned commits, not moving refs", () => {
    const parsed = parseManifest(raw)
    if (!parsed.ok) throw new Error("shipped manifest is invalid")
    expect(isPinnedCommit(parsed.manifest.upstream_git_commit)).toBe(true)
    expect(isPinnedCommit(parsed.manifest.hf_dataset_revision)).toBe(true)
  })

  test("it carries NO gold-bearing corpus content — identity only", () => {
    // the manifest describes the corpus; it must never embed it.
    expect(raw.length).toBeLessThan(4096)
    for (const forbidden of ["patch", "test_patch", "eval_script", "problem_statement"]) {
      expect(raw).not.toContain(forbidden)
    }
  })
})

describe("PMX-00 failure-code classification drift guard", () => {
  test("every declared code has a reason and vice versa", () => {
    expect(PROMAX_FAILURE_CODES.length).toBe(Object.keys(PROMAX_FAILURE_REASONS).length)
    for (const code of PROMAX_FAILURE_CODES) {
      expect(PROMAX_FAILURE_REASONS[code].length).toBeGreaterThan(0)
    }
  })
})
