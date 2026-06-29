import { describe, expect, test } from "bun:test"
import {
  ActionError,
  buildBoxLogsAction,
  buildBoxLsAction,
  buildBoxRmAction,
  buildLaunchAction,
} from "./bench-actions"

const PRESETS = new Set(["agentless-v1", "agentless-v3-thin-strict", "baseline"])
const ok: Parameters<typeof buildLaunchAction>[0] = {
  family: "pro",
  dataset: "/home/u/.quanta/bench/datasets/pro-5.jsonl",
  preset: "agentless-v1",
  model: "gpt-5.5",
}

describe("buildLaunchAction — validated argv + env (security boundary)", () => {
  test("valid pro spec ⇒ grade --mode full argv + family env", () => {
    const { argv, env } = buildLaunchAction(ok, PRESETS)
    expect(argv).toEqual([
      "run",
      "src/apps/bench/cli.ts",
      "grade",
      "--mode",
      "full",
      "--allow-remote-secrets",
      "--dataset",
      ok.dataset,
      "--dataset-family",
      "pro",
      "--preset",
      "agentless-v1",
      "--model",
      "gpt-5.5",
      "--allow-extra-boxes",
    ])
    expect(env.QUANTA_SWEBENCH_DATASET_FAMILY).toBe("pro")
    expect(env.QUANTA_FULL_REMOTE_ONDEMAND).toBeUndefined()
  })

  test("onDemand ⇒ QUANTA_FULL_REMOTE_ONDEMAND=1; instances ⇒ --instance", () => {
    const { argv, env } = buildLaunchAction(
      { ...ok, onDemand: true, instances: "ansible__ansible-1,qutebrowser__qb-2" },
      PRESETS,
    )
    expect(env.QUANTA_FULL_REMOTE_ONDEMAND).toBe("1")
    expect(argv).toContain("--instance")
    expect(argv).toContain("ansible__ansible-1,qutebrowser__qb-2")
  })

  // SECURITY: every reject path must throw (server → 400), never produce argv.
  test("unknown family ⇒ ActionError", () => {
    expect(() => buildLaunchAction({ ...ok, family: "evil" as never }, PRESETS)).toThrow(
      ActionError,
    )
  })
  test("preset NOT in catalog ⇒ ActionError (typo can't launch)", () => {
    expect(() => buildLaunchAction({ ...ok, preset: "agentless-v9" }, PRESETS)).toThrow(
      /not in catalog/,
    )
  })
  test("shell-metachar dataset ⇒ ActionError (no injection)", () => {
    for (const bad of ["a.jsonl; rm -rf ~", "a.jsonl$(whoami)", "a jsonl", "a.jsonl|cat", "`id`"]) {
      expect(() => buildLaunchAction({ ...ok, dataset: bad }, PRESETS)).toThrow(ActionError)
    }
  })
  test("path traversal dataset ⇒ ActionError", () => {
    expect(() => buildLaunchAction({ ...ok, dataset: "../../etc/passwd" }, PRESETS)).toThrow(
      /traverse/,
    )
  })
  test("injection in model / instances ⇒ ActionError", () => {
    expect(() => buildLaunchAction({ ...ok, model: "gpt-5.5; rm -rf /" }, PRESETS)).toThrow(
      ActionError,
    )
    expect(() => buildLaunchAction({ ...ok, instances: "x;reboot" }, PRESETS)).toThrow(ActionError)
  })
  // SECURITY C3: argv-flag injection. A value starting with `-` would be parsed by the bench
  // CLI's `hasFlag`/`includes` as a real flag (no shell needed). `instances="--keep"` would
  // inject --keep ⇒ box never terminated ⇒ runaway billing. Leading dash MUST be rejected.
  test("leading-dash instances/dataset ⇒ ActionError (no CLI-flag injection)", () => {
    for (const inj of ["--keep", "--dry-run", "-k"]) {
      expect(() => buildLaunchAction({ ...ok, instances: inj }, PRESETS)).toThrow(ActionError)
      expect(() => buildLaunchAction({ ...ok, dataset: inj }, PRESETS)).toThrow(ActionError)
    }
  })
  test("absolute dataset path (no leading dash) still allowed", () => {
    const { argv } = buildLaunchAction(
      { ...ok, dataset: "/home/u/.quanta/bench/datasets/pro-5.jsonl" },
      PRESETS,
    )
    expect(argv).toContain("/home/u/.quanta/bench/datasets/pro-5.jsonl")
  })

  test("argv is an ARRAY (no shell string) — values pass verbatim, no interpolation", () => {
    // A dataset with only-safe chars still rides as a single argv element, never concatenated.
    const { argv } = buildLaunchAction(ok, PRESETS)
    expect(argv[argv.indexOf("--dataset") + 1]).toBe(ok.dataset)
  })
})

describe("box actions — strict instance-id validation", () => {
  test("box ls / status ⇒ fixed safe argv (no params)", () => {
    expect(buildBoxLsAction()).toContain("ls")
  })
  test("box logs valid iid ⇒ --follow", () => {
    expect(buildBoxLogsAction("i-0abc1234def")).toEqual([
      "run",
      "src/apps/bench/cli.ts",
      "box",
      "logs",
      "i-0abc1234def",
      "--follow",
    ])
  })
  test("box rm rejects 'all' and any non-iid (web fleet-wipe forbidden)", () => {
    for (const bad of ["all", "i-; rm", "i-XYZ", "*", "i-0a; reboot", ""]) {
      expect(() => buildBoxRmAction(bad)).toThrow(ActionError)
    }
  })
  test("box rm valid single iid ⇒ rm argv", () => {
    expect(buildBoxRmAction("i-0abc1234def567")).toEqual([
      "run",
      "src/apps/bench/cli.ts",
      "box",
      "rm",
      "i-0abc1234def567",
    ])
  })
  test("box logs rejects injection iid", () => {
    expect(() => buildBoxLogsAction("i-0a; cat /etc/passwd")).toThrow(ActionError)
  })
})
