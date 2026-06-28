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
    const decoded = Buffer.from((m as RegExpMatchArray)[1], "base64").toString("utf8")
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
