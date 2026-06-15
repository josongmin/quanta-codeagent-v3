/**
 * Hellgate: quanta-bench CLI arg routing (ADR-0536). Guards the flag-value-skip
 * bug (a `--preset x` value leaking into positional report paths) + backend-spec
 * parsing. The substantive logic lives in remote/ + analyze/ (separately tested);
 * this pins the thin dispatch glue.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { buildBackend, modelNameFromPredictions, positionals } from "../../src/apps/bench/cli"

let savedArgv: string[]
beforeEach(() => {
  savedArgv = process.argv
})
afterEach(() => {
  process.argv = savedArgv
})
const setArgv = (...rest: string[]): void => {
  process.argv = ["bun", "cli.ts", ...rest]
}

describe("bench CLI dispatch", () => {
  test("positionals skips flags AND their value tokens", () => {
    // `leaderboard a.json b.json --preset agentless-v1 --title T`
    setArgv("leaderboard", "a.json", "b.json", "--preset", "agentless-v1", "--title", "T")
    expect(positionals()).toEqual(["a.json", "b.json"]) // NOT agentless-v1 / T
  })

  test("positionals: boolean flag (--keep) consumes no value", () => {
    setArgv("grade", "r.json", "--keep", "--backend", "ec2")
    expect(positionals()).toEqual(["r.json"]) // ec2 is --backend's value, skipped
  })

  test("positionals: empty when only flags", () => {
    setArgv("diff", "--dataset", "x")
    expect(positionals()).toEqual([])
  })

  test("buildBackend ssh:host → ssh backend", () => {
    setArgv("grade")
    expect(buildBackend("ssh:ubuntu@1.2.3.4", undefined).name).toContain("ssh")
  })

  test("buildBackend ec2 → ec2 backend", () => {
    setArgv("grade")
    expect(buildBackend("ec2", "gpt-5.4").name).toBe("ec2")
  })

  test("buildBackend rejects unknown spec", () => {
    setArgv("grade")
    expect(() => buildBackend("nope", undefined)).toThrow(/unknown --backend/)
  })

  test("modelNameFromPredictions reads model_name_or_path from first row", () => {
    const p = `/tmp/cli-test-preds-${process.pid}.jsonl`
    writeFileSync(
      p,
      `${JSON.stringify({ instance_id: "x", model_name_or_path: "gpt-5.4", model_patch: "d" })}\n`,
    )
    expect(modelNameFromPredictions(p)).toBe("gpt-5.4")
  })

  test("modelNameFromPredictions returns undefined on missing/garbage", () => {
    expect(modelNameFromPredictions("/tmp/does-not-exist-xyz.jsonl")).toBeUndefined()
  })
})
