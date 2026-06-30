import { afterEach, describe, expect, test } from "bun:test"
import {
  discoverVerificationModuleSmokePlan,
  probeModuleSmokeOnCurrentTree,
} from "@/runner/batch/eval/verification-module-smoke"

afterEach(() => {
  delete process.env.QUANTA_BENCH_EXPOSE_DATASET_VERIFIER
})

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

  test("FAIL_TO_PASS-derived synthesized dataset verifier is ignored (hidden oracle cannot become module-smoke)", async () => {
    const plan = await discoverVerificationModuleSmokePlan({
      instance: {
        testCmd:
          "uv run --no-project --python 3.8 --with pytest --with setuptools --with-editable . PYTEST_ADDOPTS= pytest -x --no-header tests/foo.py::test_bar",
        swebench: { instanceId: "x__1", repo: "x/x", baseCommit: "deadbeef" },
      },
      sandbox: "/tmp/fake-repo",
      timeoutMs: 1_000,
    })

    expect(plan).toEqual({
      commands: [],
      primaryBaseState: "unavailable",
    })
  })

  test("hidden dataset verifier stays ineligible for module-smoke even when prompt exposure opt-in is set", async () => {
    process.env.QUANTA_BENCH_EXPOSE_DATASET_VERIFIER = "1"
    const plan = await discoverVerificationModuleSmokePlan({
      instance: {
        testCmd:
          "uv run --no-project --python 3.8 --with pytest --with setuptools --with-editable . PYTEST_ADDOPTS= pytest -x --no-header tests/foo.py::test_bar",
        swebench: { instanceId: "x__1", repo: "x/x", baseCommit: "deadbeef" },
      },
      sandbox: "/tmp/fake-repo",
      timeoutMs: 1_000,
    })

    expect(plan).toEqual({
      commands: [],
      primaryBaseState: "unavailable",
    })
  })

  test("custom-corpus verifier with the same shell shape stays admissible (reject only swebench hidden oracle)", async () => {
    const plan = await discoverVerificationModuleSmokePlan(
      {
        instance: {
          testCmd:
            "uv run --no-project --python 3.8 --with pytest --with setuptools --with-editable . PYTEST_ADDOPTS= pytest -x --no-header tests/foo.py::test_bar",
        },
        sandbox: "/tmp/fake-repo",
        timeoutMs: 1_000,
      },
      {
        probeBaseCommand: async () => false,
      },
    )

    expect(plan).toEqual({
      commands: [
        "uv run --no-project --python 3.8 --with pytest --with setuptools --with-editable . PYTEST_ADDOPTS= pytest -x --no-header tests/foo.py::test_bar",
      ],
      primaryBaseState: "red",
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
