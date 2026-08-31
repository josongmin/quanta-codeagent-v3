import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { join } from "node:path"

const EVAL_CLI_CHILD_TIMEOUT_MS = 30_000
const REPO_ROOT = join(import.meta.dir, "..", "..")

const runEval = (...args: string[]) => {
  const out = spawnSync(process.execPath, ["run", "src/apps/eval/index.ts", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: EVAL_CLI_CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  })
  if (out.error !== undefined) {
    throw new Error(
      `eval CLI child failed for ${args.join(" ") || "--help"}: ${out.error.message}\n${out.stderr}`,
    )
  }
  return out
}

const INVALID_ARGUMENT_CASES = [
  [
    "run rejects an invalid suite",
    ["grounding", "run", "--suite", "bogus"],
    "--suite must be canary or nightly",
  ],
  [
    "run rejects an invalid corpus",
    ["grounding", "run", "--corpus", "bogus"],
    "--corpus must be one of",
  ],
  ["run rejects an invalid mode", ["grounding", "run", "--mode", "bogus"], "--mode must be one of"],
  ["report requires a run id", ["grounding", "report"], "--run-id <id> is required"],
  ["baseline requires a candidate id", ["grounding", "baseline"], "--candidate <id> is required"],
  [
    "gate requires a run id",
    ["grounding", "gate", "--profile", "canary"],
    "--run-id <id> is required",
  ],
  [
    "gate rejects an invalid profile",
    ["grounding", "gate", "--run-id", "x", "--profile", "nightly"],
    "--profile must be one of canary",
  ],
  [
    "route-matrix gate requires run ids",
    ["grounding", "gate", "--route-matrix", "primary-openai", "--profile", "canary"],
    "--run-ids <id1,id2,...> is required",
  ],
  [
    "compare requires both run ids",
    ["grounding", "compare", "--baseline", "a"],
    "--baseline <id> and --candidate <id> are required",
  ],
  [
    "scaffold-replay requires its complete input",
    ["grounding", "scaffold-replay", "--source", "x"],
    "--source, --id, --target-utterance, --bucket, --severity, --out are required",
  ],
  [
    "promote-replay requires its complete input",
    ["grounding", "promote-replay", "--draft", "x"],
    "--draft, --gold-json, --corpus, --out are required",
  ],
  [
    "regress rejects an invalid profile",
    ["grounding", "regress", "--baseline", "a", "--candidate", "b", "--profile", "loose"],
    "--profile must be one of strict",
  ],
  [
    "promote-replay rejects an invalid corpus",
    [
      "grounding",
      "promote-replay",
      "--draft",
      "x",
      "--gold-json",
      "y",
      "--corpus",
      "bogus",
      "--out",
      "z",
    ],
    "--corpus must be replay_critical or replay_nightly",
  ],
] as const

describe("eval grounding CLI validation", () => {
  test(
    "--help includes the grounding subcommands",
    () => {
      const out = runEval("--help")
      expect(out.status).toBe(0)
      expect(out.stdout).toContain("grounding run [--mode raw|engine|assisted]")
      expect(out.stdout).toContain("grounding preflight")
      expect(out.stdout).toContain("grounding report --run-id ID")
      expect(out.stdout).toContain("grounding baseline --candidate ID")
      expect(out.stdout).toContain("grounding gate --route-matrix primary-openai")
      expect(out.stdout).toContain("grounding compare --baseline ID --candidate ID")
      expect(out.stdout).toContain(
        "grounding regress --baseline ID --candidate ID --profile strict",
      )
      expect(out.stdout).toContain("grounding scaffold-replay --source JSONL --out PATH")
      expect(out.stdout).toContain(
        "grounding promote-replay --draft PATH --gold-json PATH --corpus replay_critical|replay_nightly --out PATH",
      )
    },
    EVAL_CLI_CHILD_TIMEOUT_MS,
  )

  test(
    "grounding requires a valid subcommand",
    () => {
      const out = runEval("grounding")
      expect(out.status).toBe(1)
      expect(out.stderr).toContain(
        "eval grounding: subcommand must be one of: run, preflight, report, baseline, gate, compare, regress, scaffold-replay, promote-replay",
      )
    },
    EVAL_CLI_CHILD_TIMEOUT_MS,
  )

  for (const [name, args, error] of INVALID_ARGUMENT_CASES) {
    test(
      name,
      () => {
        const out = runEval(...args)
        expect(out.status).toBe(1)
        expect(out.stderr).toContain(error)
      },
      EVAL_CLI_CHILD_TIMEOUT_MS,
    )
  }

  test(
    "grounding run rejects invalid concurrency",
    () => {
      const out = runEval("grounding", "run", "--suite", "canary", "--concurrency", "0")
      expect(out.status).toBe(1)
      expect(out.stderr).toContain("invalid --concurrency 0")
    },
    EVAL_CLI_CHILD_TIMEOUT_MS,
  )
})
