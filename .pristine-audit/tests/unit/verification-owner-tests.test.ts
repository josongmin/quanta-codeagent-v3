import { describe, expect, test } from "bun:test"
import {
  discoverVerificationOwnerTests,
  discoverVerificationOwnerTestsPlan,
} from "@/runner/batch/eval/verification-owner-tests"

describe("discoverVerificationOwnerTests", () => {
  test("returns a typed owner-near test plan with base-green public regression tests", async () => {
    const plan = await discoverVerificationOwnerTestsPlan(
      {
        instance: {
          swebench: { baseCommit: "base", instanceId: "owner-test", repo: "example/repo" },
        },
        ownerCandidates: ["pkg/core.py"],
        sandbox: "/tmp/fake-repo",
        timeoutMs: 1_000,
      },
      {
        listPythonFiles: async () => ["pkg/core.py", "tests/test_core.py", "tests/test_other.py"],
        readTestFiles: async () => [
          {
            path: "tests/test_core.py",
            text: "from pkg import core\n\ndef test_core():\n    assert True\n",
          },
          {
            path: "tests/test_other.py",
            text: "from pkg import other\n\ndef test_other():\n    assert True\n",
          },
        ],
        collectBaseGreenTests: async (args) => {
          expect(args.tests).toEqual(["tests/test_core.py"])
          return ["tests/test_core.py"]
        },
        probeBaseTest: async (args) => {
          expect(args.test).toBe("tests/test_core.py")
          return false
        },
      },
    )

    expect(plan).toEqual({
      commands: [
        "uv run --no-project --python 3.11 --with pytest --with setuptools --with-editable . pytest -x -p no:cacheprovider -q --no-header tests/test_core.py",
      ],
      testPaths: ["tests/test_core.py"],
      baseGreenTestPaths: ["tests/test_core.py"],
      primaryBaseState: "red",
    })
  })

  test("discovers public owner-near pytest commands from source owners", async () => {
    const cmds = await discoverVerificationOwnerTests(
      {
        instance: {},
        ownerCandidates: ["pkg/core.py"],
        sandbox: "/tmp/fake-repo",
        timeoutMs: 1_000,
      },
      {
        listPythonFiles: async () => ["pkg/core.py", "tests/test_core.py", "tests/test_other.py"],
        readTestFiles: async () => [
          {
            path: "tests/test_core.py",
            text: "from pkg import core\n\ndef test_core():\n    assert True\n",
          },
          {
            path: "tests/test_other.py",
            text: "from pkg import other\n\ndef test_other():\n    assert True\n",
          },
        ],
      },
    )

    expect(cmds).toEqual(["python -m pytest -p no:cacheprovider -q --no-header tests/test_core.py"])
  })

  test("ignores non-source owner candidates and dedupes repeated files", async () => {
    const cmds = await discoverVerificationOwnerTests(
      {
        instance: {},
        ownerCandidates: ["README.md", "tests/test_core.py", "pkg/core.py", "pkg/core.py"],
        sandbox: "/tmp/fake-repo",
        timeoutMs: 1_000,
      },
      {
        listPythonFiles: async () => ["pkg/core.py", "tests/test_core.py"],
        readTestFiles: async () => [
          {
            path: "tests/test_core.py",
            text: "from pkg import core\n\ndef test_core():\n    assert True\n",
          },
        ],
      },
    )

    expect(cmds).toEqual(["python -m pytest -p no:cacheprovider -q --no-header tests/test_core.py"])
  })
})
