/**
 * PMX-00 — the operator tool and the runtime cannot disagree.
 *
 * The tool writes no schema of its own; it reads bytes and delegates. These
 * tests prove that BY BEHAVIOR: the same bundle, once through the in-memory
 * runtime entrypoint and once through the tool's file entrypoint, yields an
 * equal verdict and an identical manifest digest — including in the refusal
 * case, where an agreeing "REFUSED" is the property that matters most.
 *
 * Hermetic: bytes are written to a per-test temp dir; no network, no bundle
 * material in git.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROMAX_V1_SNAPSHOT, verifyProMaxBundle } from "@/apps/bench/promax/provenance"
import * as tool from "../../../../../tools/bench-promax/verify-bundle"
import { buildFixtureBundle, type FixtureOverrides } from "./promax-bundle-fixture"

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** Materialize a fixture bundle on disk in the tool's expected layout. */
const writeBundle = (o: FixtureOverrides = {}) => {
  const built = buildFixtureBundle(o)
  const root = mkdtempSync(join(tmpdir(), "promax-bundle-"))
  roots.push(root)
  mkdirSync(join(root, "hf"), { recursive: true })
  const s = built.sources
  const text = (b: string | Uint8Array): string =>
    typeof b === "string" ? b : new TextDecoder().decode(b)
  writeFileSync(join(root, tool.BUNDLE_FILES.manifest), text(s.manifest))
  writeFileSync(join(root, tool.BUNDLE_FILES.dataset), text(s.dataset))
  writeFileSync(join(root, tool.BUNDLE_FILES.evalMeta), text(s.evalMeta))
  writeFileSync(join(root, tool.BUNDLE_FILES.evaluator), text(s.evaluator))
  if (s.hfDataset !== undefined) {
    writeFileSync(join(root, tool.BUNDLE_FILES.hfDataset), text(s.hfDataset))
  }
  if (s.hfEvalMeta !== undefined) {
    writeFileSync(join(root, tool.BUNDLE_FILES.hfEvalMeta), text(s.hfEvalMeta))
  }
  return { root, built }
}

const CHECKOUT = { headCommit: PROMAX_V1_SNAPSHOT.upstream_git_commit }

describe("PMX-00 tool/runtime parity", () => {
  test("identical bytes yield an identical verdict and manifest digest (accept)", () => {
    const { root, built } = writeBundle()
    const runtime = verifyProMaxBundle(built.sources, built.policy)
    const viaTool = tool.verifyBundleDir(root, CHECKOUT, built.policy)
    expect(viaTool.ok).toBe(true)
    expect(runtime.ok).toBe(true)
    expect(viaTool).toEqual(runtime)
    if (!viaTool.ok || !runtime.ok) throw new Error("expected both ok")
    expect(viaTool.manifestSha256).toBe(runtime.manifestSha256)
  })

  test("identical bytes yield an identical verdict (refuse) — failures agree exactly", () => {
    const { root, built } = writeBundle({
      tamper: { evaluator: (b) => `${b.slice(0, 10)}X${b.slice(11)}` },
    })
    const runtime = verifyProMaxBundle(built.sources, built.policy)
    const viaTool = tool.verifyBundleDir(root, CHECKOUT, built.policy)
    expect(viaTool.ok).toBe(false)
    expect(viaTool).toEqual(runtime)
  })

  test("byte-for-byte reads: the tool's Uint8Array path hashes like the string path", () => {
    // catches an encoding bug in the tool's file read that a same-process
    // string round-trip would hide.
    const { root, built } = writeBundle()
    const viaTool = tool.verifyBundleDir(root, CHECKOUT, built.policy)
    const runtime = verifyProMaxBundle(built.sources, built.policy)
    if (!viaTool.ok || !runtime.ok) throw new Error("expected both ok")
    expect(viaTool.manifest.dataset_sha256).toBe(runtime.manifest.dataset_sha256)
    expect(viaTool.instanceIds).toEqual(runtime.instanceIds)
  })

  test("the CLI wrapper exits non-zero on a refused bundle and prints the codes", () => {
    const { root, built } = writeBundle({ manifest: (m) => ({ ...m, dataset_count: 169 }) })
    const res = tool.runVerifyCli(
      ["--bundle-root", root, "--head-commit", PROMAX_V1_SNAPSHOT.upstream_git_commit],
      built.policy,
    )
    expect(res.exitCode).toBe(1)
    expect(res.output).toContain("REFUSED")
    expect(res.output).toContain("dataset_count_mismatch")
  })

  test("the CLI wrapper exits zero and prints reproduction identity on success", () => {
    const { root, built } = writeBundle()
    const res = tool.runVerifyCli(
      ["--bundle-root", root, "--head-commit", PROMAX_V1_SNAPSHOT.upstream_git_commit],
      built.policy,
    )
    expect(res.exitCode).toBe(0)
    // "the manifest prints enough information to reproduce the exact upstream
    // state" — every reproduction-critical field of THIS bundle's manifest,
    // read back from the manifest record rather than restated as a literal.
    for (const field of [
      "upstream_repo_url",
      "upstream_git_commit",
      "hf_repo_id",
      "hf_dataset_revision",
      "dataset_sha256",
      "eval_sha256",
      "evaluator_sha256",
      "dataset_ids_sha256",
      "captured_at",
    ] as const) {
      expect(res.output).toContain(String(built.manifestRecord[field]))
    }
    // the frozen upstream IDENTITY is real, not fixture-invented
    expect(res.output).toContain(PROMAX_V1_SNAPSHOT.upstream_git_commit)
    expect(res.output).toContain(PROMAX_V1_SNAPSHOT.hf_dataset_revision)
  })

  test("an --attached-ref (non-detached checkout) is refused through the tool too", () => {
    const { root, built } = writeBundle()
    const res = tool.runVerifyCli(
      [
        "--bundle-root",
        root,
        "--head-commit",
        PROMAX_V1_SNAPSHOT.upstream_git_commit,
        "--attached-ref",
        "main",
      ],
      built.policy,
    )
    expect(res.exitCode).toBe(1)
    expect(res.output).toContain("checkout_not_detached")
  })

  test("an absent --bundle-root throws instead of resolving a default bundle", () => {
    expect(() => tool.runVerifyCli(["--head-commit", "x"])).toThrow(/bundle root/i)
  })
})

describe("PMX-00 the operator tool is not a bench runner", () => {
  test("its exported surface is verification-only", () => {
    // Behavioral surface assertion (module object, not source text): the tool
    // must not grow a run launcher, knob resolver, or report writer.
    expect(Object.keys(tool).sort()).toEqual(
      [
        "BUNDLE_FILES",
        "formatVerdict",
        "readBundleSources",
        "runVerifyCli",
        "verifyBundleDir",
      ].sort(),
    )
  })

  test("a verified verdict leaks no gold-bearing bytes into operator output", () => {
    const { root, built } = writeBundle()
    const res = tool.runVerifyCli(
      ["--bundle-root", root, "--head-commit", PROMAX_V1_SNAPSHOT.upstream_git_commit],
      built.policy,
    )
    expect(res.output).not.toContain("SYNTHETIC-NOT-GOLD")
    expect(res.output).not.toContain("SYNTHETIC-EVAL")
  })
})
