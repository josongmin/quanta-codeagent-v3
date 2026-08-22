import { afterEach, describe, expect, test } from "bun:test"
import { reproRunArgv } from "@/runner/batch/corpus/dataset"
import { reproExecBundle } from "@/runner/batch/eval/driver"
import type { Instance } from "@/runner/batch/types"

// Phase 2b image backend (QUANTA_BENCH_REPRO_IMAGE_EXEC) is opt-in; clear it after
// every test so a gated case can't leak into the default-OFF cases (pollution guard).
afterEach(() => {
  delete process.env.QUANTA_BENCH_REPRO_IMAGE_EXEC
})

const mkInstance = (overrides: Partial<Instance> = {}): Instance => ({
  id: "test",
  repoPath: "/tmp/x",
  problemStatement: "the bug is in foo.py",
  testCmd: "true",
  ...overrides,
})

describe("reproExecBundle image backend wiring", () => {
  test("Pro python + dockerhubTag + REPRO_IMAGE_EXEC=1 ⇒ vote/consensus repro exec uses the instance image", () => {
    process.env.QUANTA_BENCH_REPRO_IMAGE_EXEC = "1" // Phase 2b image backend is opt-in
    const bundle = reproExecBundle(
      mkInstance({
        swebench: {
          instanceId: "qutebrowser__qutebrowser-pro-1",
          repo: "qutebrowser/qutebrowser",
          baseCommit: "abc",
          repoLanguage: "python",
          dockerhubTag: "qutebrowser.demo",
        },
      }),
    )
    const argv = bundle.buildArgv?.("/tmp/sb/__repro_0_demo.py")
    expect(argv).toEqual([
      "docker",
      "run",
      "--rm",
      "-v",
      "/tmp/sb:/tmp/sb",
      "-w",
      "/tmp/sb",
      "jefzda/sweap-images:qutebrowser.demo",
      "python",
      "-s",
      "/tmp/sb/__repro_0_demo.py",
    ])
  })

  test("swebench instance without dockerhubTag ⇒ vote/consensus repro exec stays on host argv", () => {
    const bundle = reproExecBundle(
      mkInstance({
        swebench: {
          instanceId: "sympy__sympy-1",
          repo: "sympy/sympy",
          baseCommit: "abc",
          repoLanguage: "python",
          version: "1.5",
        },
      }),
    )
    expect(bundle.buildArgv?.("/tmp/sb/__repro_0_demo.py")).toEqual([
      ...reproRunArgv("sympy/sympy", "1.5", "/tmp/sb/__repro_0_demo.py"),
    ])
  })
})
