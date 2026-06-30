import { describe, expect, test } from "bun:test"
import { reproRunArgv } from "@/runner/batch/corpus/dataset"
import { reproExecBundle } from "@/runner/batch/eval/driver"
import type { Instance } from "@/runner/batch/types"

const mkInstance = (overrides: Partial<Instance> = {}): Instance => ({
  id: "test",
  repoPath: "/tmp/x",
  problemStatement: "the bug is in foo.py",
  testCmd: "true",
  ...overrides,
})

describe("reproExecBundle image backend wiring", () => {
  test("Pro python instance with dockerhubTag ⇒ vote/consensus repro exec uses the instance image", () => {
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
