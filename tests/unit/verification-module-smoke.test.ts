import { describe, expect, test } from "bun:test"
import {
  discoverVerificationModuleSmokePlan,
  probeModuleSmokeOnCurrentTree,
} from "@/runner/batch/eval/verification-module-smoke"

describe("verification module-smoke", () => {
  test("repo-local verifier becomes a typed module-smoke plan with base-red proof", async () => {
    const plan = await discoverVerificationModuleSmokePlan(
      {
        instance: { testCmd: 'node -e "process.exit(1)"' },
        sandbox: "/tmp/fake-repo",
        timeoutMs: 1_000,
      },
      {
        probeBaseCommand: async (args) => {
          expect(args.instance.testCmd).toBe('node -e "process.exit(1)"')
          return false
        },
      },
    )

    expect(plan).toEqual({
      commands: ['node -e "process.exit(1)"'],
      primaryBaseState: "red",
    })
  })

  test("dataset no-op verifier is ignored (no fake module-smoke rail)", async () => {
    const plan = await discoverVerificationModuleSmokePlan({
      instance: { testCmd: "true" },
      sandbox: "/tmp/fake-repo",
      timeoutMs: 1_000,
    })

    expect(plan).toEqual({
      commands: [],
      primaryBaseState: "unavailable",
    })
  })

  test("current-tree probe uses the same local testCmd pass/fail semantics as verify()", async () => {
    const sandbox = await Bun.file("/tmp").exists() ? "/tmp" : process.cwd()
    const verdict = await probeModuleSmokeOnCurrentTree({
      instance: {
        testCmd: `printf '1 passed in 0.01s\n' >&2; exit 143`,
      },
      sandbox,
      timeoutMs: 1_000,
    })

    expect(verdict).toBe(true)
  })
})
