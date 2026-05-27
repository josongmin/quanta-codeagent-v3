import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"

const runEval = (...args: string[]) =>
  spawnSync(process.execPath, ["run", "src/apps/eval/index.ts", ...args], {
    cwd: "/Users/songmin/quanta-codeagent-v3",
    encoding: "utf8",
  })

describe("eval grounding CLI", () => {
  test("--help includes the grounding subcommands", () => {
    const out = runEval("--help")
    expect(out.status).toBe(0)
    expect(out.stdout).toContain("grounding run --suite canary|nightly")
    expect(out.stdout).toContain("grounding preflight")
    expect(out.stdout).toContain("grounding report --run-id ID")
  })

  test("grounding requires a valid subcommand", () => {
    const out = runEval("grounding")
    expect(out.status).toBe(1)
    expect(out.stderr).toContain(
      "eval grounding: subcommand must be one of: run, preflight, report, gate",
    )
  })

  test("grounding run rejects invalid suites and report/gate validate required args", () => {
    const badSuite = runEval("grounding", "run", "--suite", "bogus")
    expect(badSuite.status).toBe(1)
    expect(badSuite.stderr).toContain("--suite must be canary or nightly")

    const missingRunId = runEval("grounding", "report")
    expect(missingRunId.status).toBe(1)
    expect(missingRunId.stderr).toContain("--run-id <id> is required")

    const missingGateRunId = runEval("grounding", "gate", "--profile", "canary")
    expect(missingGateRunId.status).toBe(1)
    expect(missingGateRunId.stderr).toContain("--run-id <id> is required")

    const badProfile = runEval("grounding", "gate", "--run-id", "x", "--profile", "nightly")
    expect(badProfile.status).toBe(1)
    expect(badProfile.stderr).toContain("--profile must be one of canary")
  })

  test("grounding run rejects invalid concurrency", () => {
    const out = runEval("grounding", "run", "--suite", "canary", "--concurrency", "0")
    expect(out.status).toBe(1)
    expect(out.stderr).toContain("invalid --concurrency 0")
  })
})
