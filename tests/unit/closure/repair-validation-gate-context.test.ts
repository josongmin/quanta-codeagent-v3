import { describe, expect, test } from "bun:test"
import { runRepairRounds } from "@/runner/batch/eval/repair/index"
import type {
  BuildRepairContextArgs,
  RunOnceResult,
  ValidateArgs,
  ValidatorResult,
} from "@/runner/batch/eval/repair/types"

const exec = async () => ({ code: 0, stdout: "", stderr: "" })

describe("runRepairRounds — validation gate context", () => {
  test("primary rail overrides the agent's own verify command in the repair seed", async () => {
    let captured: BuildRepairContextArgs | undefined
    const runOnce = async (_seed: string | undefined): Promise<RunOnceResult> => ({
      patch: "diff --git a/x b/x\n",
      turns: 1,
      lastVerifyCmd: "pytest tests/test_x.py -k repro",
      reproPath: "repro.py",
    })
    const validate = async (_args: ValidateArgs): Promise<ValidatorResult> => ({
      ok: false,
      failTail: "Issue reproduced\n",
      failureEvidence: {
        stdoutTail: "Issue reproduced\n",
        stderrTail: "",
        combinedTail: "Issue reproduced\n",
      },
      observed: { exitCode: 1, stdout: "Issue reproduced\n", stderr: "" },
    })

    await runRepairRounds({
      config: { maxRounds: 1 },
      problem: "fix it",
      runOnce,
      validate,
      buildContext: (args) => {
        captured = args
        return "seed"
      },
      sandbox: "/tmp/sb",
      exec,
      timeoutMs: 1000,
      primaryRailStep: {
        kind: "repro",
        cmd: 'python "reproduce_issue.py"',
        authority: "execution",
        successPredicate: { type: "selected_test_passes" },
      },
    })

    expect(captured?.validationSource).toBe("primary_rail")
    expect(captured?.validationCmd).toBe('python "reproduce_issue.py"')
    expect(captured?.validationExitCode).toBe(1)
    expect(captured?.failureEvidence?.combinedTail).toBe("Issue reproduced\n")
  })

  test("owner-test primary rail preserves kind and withholds the hidden selector command", async () => {
    let captured: BuildRepairContextArgs | undefined
    const runOnce = async (_seed: string | undefined): Promise<RunOnceResult> => ({
      patch: "diff --git a/x b/x\n",
      turns: 1,
      lastVerifyCmd: "pytest tests/test_x.py -k repro",
      reproPath: "repro.py",
    })
    const validate = async (_args: ValidateArgs): Promise<ValidatorResult> => ({
      ok: false,
      failTail: "AssertionError\n",
      failureEvidence: {
        stdoutTail: "",
        stderrTail: "AssertionError\n",
        combinedTail: "\nAssertionError\n",
      },
      observed: { exitCode: 1, stdout: "", stderr: "AssertionError\n" },
    })

    await runRepairRounds({
      config: { maxRounds: 1 },
      problem: "fix it",
      runOnce,
      validate,
      buildContext: (args) => {
        captured = args
        return "seed"
      },
      sandbox: "/tmp/sb",
      exec,
      timeoutMs: 1000,
      primaryRailStep: {
        kind: "owner-test",
        cmd: "pytest hidden_tests/test_secret.py -q",
        authority: "structure",
        successPredicate: { type: "selected_test_passes" },
      },
    })

    expect(captured?.validationSource).toBe("primary_rail")
    expect(captured?.validationStepKind).toBe("owner-test")
    expect(captured?.validationCmdWithheld).toBe(true)
    expect(captured?.validationCmd).toBeUndefined()
    expect(captured?.validationExitCode).toBe(1)
    expect(captured?.failureEvidence?.stderrTail).toBe("AssertionError\n")
  })

  test("missing verify signal is called out explicitly in the repair seed context", async () => {
    let captured: BuildRepairContextArgs | undefined
    const runOnce = async (_seed: string | undefined): Promise<RunOnceResult> => ({
      patch: "diff --git a/x b/x\n",
      turns: 1,
    })
    const validate = async (_args: ValidateArgs): Promise<ValidatorResult> => ({
      ok: false,
      failTail: "",
    })

    await runRepairRounds({
      config: { maxRounds: 1 },
      problem: "fix it",
      runOnce,
      validate,
      buildContext: (args) => {
        captured = args
        return "seed"
      },
      sandbox: "/tmp/sb",
      exec,
      timeoutMs: 1000,
    })

    expect(captured?.validationSource).toBe("none")
    expect(captured?.validationCmd).toBeUndefined()
    expect(captured?.validationExitCode).toBeUndefined()
  })

  test("agent verify command is surfaced as the validation gate when no primary rail is set", async () => {
    let captured: BuildRepairContextArgs | undefined
    const runOnce = async (_seed: string | undefined): Promise<RunOnceResult> => ({
      patch: "diff --git a/x b/x\n",
      turns: 1,
      lastVerifyCmd: "pytest tests/test_x.py -k repro",
      reproPath: "repro.py",
    })
    const validate = async (_args: ValidateArgs): Promise<ValidatorResult> => ({
      ok: false,
      failTail: "AssertionError\n",
      observed: { exitCode: 1, stdout: "", stderr: "AssertionError\n" },
    })

    await runRepairRounds({
      config: { maxRounds: 1 },
      problem: "fix it",
      runOnce,
      validate,
      buildContext: (args) => {
        captured = args
        return "seed"
      },
      sandbox: "/tmp/sb",
      exec,
      timeoutMs: 1000,
    })

    expect(captured?.validationSource).toBe("verify_cmd")
    expect(captured?.validationCmd).toBe("pytest tests/test_x.py -k repro")
    expect(captured?.validationExitCode).toBe(1)
  })

  test("explicit repro command is surfaced as the validation gate when verify command is absent", async () => {
    let captured: BuildRepairContextArgs | undefined
    const runOnce = async (_seed: string | undefined): Promise<RunOnceResult> => ({
      patch: "diff --git a/x b/x\n",
      turns: 1,
      reproPath: "repro.py",
      reproCmd: 'python3 -s "repro.py"',
    })
    const validate = async (_args: ValidateArgs): Promise<ValidatorResult> => ({
      ok: false,
      failTail: "Issue reproduced\n",
      observed: { exitCode: 1, stdout: "Issue reproduced\n", stderr: "" },
    })

    await runRepairRounds({
      config: { maxRounds: 1 },
      problem: "fix it",
      runOnce,
      validate,
      buildContext: (args) => {
        captured = args
        return "seed"
      },
      sandbox: "/tmp/sb",
      exec,
      timeoutMs: 1000,
    })

    expect(captured?.validationSource).toBe("repro")
    expect(captured?.validationCmd).toBe('python3 -s "repro.py"')
    expect(captured?.validationExitCode).toBe(1)
  })
})
