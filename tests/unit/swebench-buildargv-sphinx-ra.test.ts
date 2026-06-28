import { describe, expect, it } from "bun:test"
import { resolveHarnessConfig } from "../../src/apps/bench/harness"
import { buildArgv } from "../../src/apps/bench/python-swebench"

describe("buildArgv — sphinx -rA false-unresolved fix (jun-28)", () => {
  const argv = buildArgv(
    "python",
    "/tmp/preds.jsonl",
    "run42",
    "sphinx-doc__sphinx-9711",
    "princeton-nlp/SWE-bench_Verified",
    resolveHarnessConfig(),
  )

  it("invokes the harness via a `python -c` patch-shim, not bare `-m`", () => {
    expect(argv[0]).toBe("python")
    expect(argv[1]).toBe("-c")
    // the shim still runs the official harness
    expect(argv[2]).toContain("swebench.harness.run_evaluation")
    expect(argv[2]).toContain("runpy.run_module")
    // and it does NOT use the bare `-m` form anymore
    expect(argv).not.toContain("-m")
  })

  it("the shim injects -rA ONLY into tox test_cmds ending in `--` (sphinx), additively", () => {
    const shim = argv[2] as string
    // appends -rA so pytest emits per-test PASSED lines the swebench parser reads
    expect(shim).toContain("'-rA'")
    expect(shim).toContain("endswith('--')")
    expect(shim).toContain("'tox' in _tc")
    // guarded: never double-adds
    expect(shim).toContain("'-rA' not in _tc")
  })

  it("run_evaluation args still follow after the shim (predictions/instance/dataset)", () => {
    expect(argv).toContain("--predictions_path")
    expect(argv).toContain("/tmp/preds.jsonl")
    expect(argv).toContain("--instance_ids")
    expect(argv).toContain("sphinx-doc__sphinx-9711")
    expect(argv).toContain("--dataset_name")
    expect(argv).toContain("princeton-nlp/SWE-bench_Verified")
  })
})
