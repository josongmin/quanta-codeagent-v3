/**
 * ★ CONTRACT — ssh/ec2 grade-only path also carries the SPHINX_RA_SHIM (jun-28).
 *
 * The grade-only backend (`grade --predictions --backend ec2|ssh`) builds its OWN
 * remote run_evaluation command in ssh.ts — it does NOT go through the local
 * `buildArgv`. So the sphinx -rA false-unresolved fix has to be wired HERE too,
 * else a cheap re-grade still mis-parses sphinx. The shim is base64-shipped to
 * `~/ra_shim.py` (NOT a heredoc — the script is piped to `bash -s` over stdin, a
 * heredoc would steal it).
 *
 * Drift-proof: we base64-DECODE what the script ships and assert it === the shared
 * SPHINX_RA_SHIM, so the two grade paths can never diverge.
 */

import { describe, expect, test } from "bun:test"
import type { DatasetFamily } from "@/apps/bench/dataset-family-token"
import { resolveDatasetFamilyProfile } from "@/apps/bench/profiles/registry"
import { SPHINX_RA_SHIM } from "@/apps/bench/python-swebench"
import { buildRemoteGradeScript } from "@/apps/bench/remote/ssh"

describe("ssh grade script — SPHINX_RA_SHIM wiring", () => {
  const script = buildRemoteGradeScript(4)

  test("runs the shim file, NOT bare `-m swebench.harness.run_evaluation`", () => {
    expect(script).toContain("python ~/ra_shim.py")
    expect(script).not.toContain("python -m swebench.harness.run_evaluation")
  })

  test("ships the shim via base64 (no heredoc — stdin-safe)", () => {
    expect(script).toContain("base64 -d > ~/ra_shim.py")
    expect(script).not.toContain("<<") // no heredoc
  })

  test("DRIFT-PROOF: the shipped base64 decodes back to the shared SPHINX_RA_SHIM", () => {
    const m = script.match(/printf %s ([A-Za-z0-9+/=]+) \| base64 -d/)
    expect(m).not.toBeNull()
    const b64 = (m as RegExpMatchArray)[1] ?? ""
    const decoded = Buffer.from(b64, "base64").toString("utf8")
    expect(decoded).toBe(SPHINX_RA_SHIM)
  })

  test("preserves namespace/cache_level/RUNID placeholder + dataset", () => {
    expect(script).toContain("--namespace swebench")
    expect(script).toContain("--cache_level instance")
    expect(script).toContain("--run_id RUNID") // substituted by the caller
    expect(script).toContain("--dataset_name ~/instances.jsonl")
    expect(script).toContain("--max_workers 4")
  })
})

/**
 * ★ CONTRACT — the grade-only ssh path is DATASET-FAMILY-AWARE (RFC jun-29).
 *
 * Before: this path hardcoded `--from swebench` + `--namespace swebench`, so a
 * `grade --backend ssh:host --dataset-family live` would install the STOCK swebench
 * harness (which only knows the ORIGINAL repos) and pull `swebench/...` images →
 * KeyError on every Live repo. Now the family selects the harness fork + image org
 * via the SAME SSOT profile port the full-remote box path uses, so the two never drift.
 */
describe("ssh grade script — dataset-family awareness (verified vs live)", () => {
  const ds = "~/instances.jsonl"
  // aug-22 HIGH-4: `createSshBackend` resolves the family PROFILE and reads its
  // `harnessSpec` port — the same port the full-remote box path uses — instead of
  // the old `resolveSwebenchPipSpec(…, family)` helpers that each re-decided what
  // "live" means. Drive that port here so the two paths cannot drift.
  const specFor = (family: DatasetFamily, pipSpecOverride?: string, namespaceOverride?: string) =>
    resolveDatasetFamilyProfile(family).harnessSpec({
      datasetName: ds,
      pipSpecOverride,
      namespaceOverride,
    })

  test("verified (no family / undefined) ⇒ stock swebench fork + swebench namespace (byte-identical legacy)", () => {
    const { pipSpec: fromSpec, namespace } = specFor("verified")
    const s = buildRemoteGradeScript(4, fromSpec, namespace)
    expect(s).toContain("--from swebench ")
    expect(s).toContain("--namespace swebench")
    // The no-arg call (legacy callers) must stay identical to the verified call.
    expect(buildRemoteGradeScript(4)).toBe(s)
  })

  test("live ⇒ SWE-bench-Live harness fork + starryzhang prebuilt-image namespace", () => {
    const { pipSpec: fromSpec, namespace } = specFor("live")
    const s = buildRemoteGradeScript(4, fromSpec, namespace)
    expect(s).toContain("--from git+https://github.com/SWE-bench-Live/SWE-bench-Live ")
    expect(s).toContain("--namespace starryzhang")
    // RED-ON-INJECTION: reverting the family wiring (stock swebench for live) trips this.
    expect(s).not.toContain("--from swebench ")
    expect(s).not.toContain("--namespace swebench")
  })

  test("operator env override (QUANTA_SWEBENCH_PIP_SPEC / _NAMESPACE) still wins for live", () => {
    const { pipSpec: fromSpec, namespace } = specFor("live", "swebench==3.0.0", "myorg")
    const s = buildRemoteGradeScript(4, fromSpec, namespace)
    expect(s).toContain("--from swebench==3.0.0 ")
    expect(s).toContain("--namespace myorg")
  })
})
