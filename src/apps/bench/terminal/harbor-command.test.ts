/**
 * TB21-03 — HELLGATE for Harbor argv construction.
 *
 * ⚠️ NOTHING HERE EXECUTES HARBOR. `buildHarborRunCommand` is a pure argv
 * builder; a live `harbor run` provisions containers and bills a provider, so
 * the only observable in this file is the argv/env VALUE it returns.
 *
 * ANTI-VACUUM (ticket requirement): the assertions are ADJACENCY assertions —
 * every flag is checked together with the exact token that follows it. A
 * "contains the string" test passes on an argv that pairs `-m` with the sandbox
 * and `-e` with the model; that is precisely the class of bug that would run the
 * wrong model for a full 89×5 job and only surface on the leaderboard.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resolveTerminalRunConfig, TERMINAL_PROFILE_KNOBS, TERMINAL_PROFILES } from "./config"
import { TERMINAL_BENCH_DATASET, TERMINAL_BENCH_DATASET_REF } from "./dataset"
import {
  buildBrainDeliveryEnv,
  buildHarborRunCommand,
  formatHarborDryRunReceipt,
  HARBOR_AGENT_SELECTOR,
  SECRET_ENV_NAME_SUFFIXES,
} from "./harbor-command"
import { buildTerminalRunManifest } from "./manifest"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")

const manifestFor = (extra: readonly string[] = [], dirty = false) =>
  buildTerminalRunManifest({
    cfg: resolveTerminalRunConfig({
      argv: [
        "bun",
        "cli.ts",
        "terminal",
        "run",
        "--profile",
        "quanta-full",
        "--model",
        "gpt-5.5",
        "--provider",
        "openai",
        "--effort",
        "xhigh",
        "--sandbox",
        "docker",
        "--k",
        "5",
        "--concurrency",
        "4",
        ...extra,
      ],
      env: {},
    }),
    provenance: { packageVersion: "1.0.025", sha: "9d5369d310bb", dirty },
    harborVersion: "0.21.0",
    timestamp: "2026-08-22T00:00:00.000Z",
  })

const cmd = (extra: readonly string[] = []) =>
  buildHarborRunCommand(manifestFor(extra), { outputRoot: "/tmp/tb-out" })

/** The token that FOLLOWS `flag`, or undefined. */
const after = (argv: readonly string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i < 0 ? undefined : argv[i + 1]
}

describe("ANTI-VACUUM — every load-bearing argument is present AND correctly paired", () => {
  test("dataset, agent selector, model, effort, sandbox, -k and concurrency", () => {
    const { argv } = cmd()
    expect(after(argv, "-d")).toBe(`${TERMINAL_BENCH_DATASET}@${TERMINAL_BENCH_DATASET_REF}`)
    expect(after(argv, "--agent")).toBe(HARBOR_AGENT_SELECTOR)
    expect(HARBOR_AGENT_SELECTOR).toBe("quanta_agent:QuantaAgent")
    expect(after(argv, "-m")).toBe("gpt-5.5")
    expect(after(argv, "--ak")).toBe("reasoning_effort=xhigh")
    expect(after(argv, "-e")).toBe("docker")
    expect(after(argv, "-k")).toBe("5")
    expect(after(argv, "-n")).toBe("4")
    expect(after(argv, "-o")).toBe("/tmp/tb-out")
    expect(after(argv, "--timeout-multiplier")).toBe("1")
  })

  test("the flags it uses are the PINNED harbor 0.21.0 spellings", () => {
    // Read from the locked venv's own CLI source — the flag names are upstream's,
    // never ours, and a harbor bump that renames one must fail here.
    const jobs = join(
      REPO_ROOT,
      "adapters/terminal-bench/.venv/lib/python3.13/site-packages/harbor/cli/jobs.py",
    )
    let source: string
    try {
      source = readFileSync(jobs, "utf8")
    } catch {
      // The locked venv is not materialized on this machine — skip VISIBLY.
      expect(true, "SKIPPED: adapters/terminal-bench/.venv not synced").toBe(true)
      return
    }
    for (const flag of [
      '"-d"',
      '"--agent"',
      '"-m"',
      '"--ak"',
      '"-e"',
      '"-k"',
      '"-n"',
      '"-o"',
      '"--timeout-multiplier"',
      '"--ae"',
      '"-i"',
      '"--upload"',
    ]) {
      expect(source, `harbor 0.21.0 no longer declares ${flag}`).toContain(flag)
    }
    // The retired 0.16 spelling must NOT be what we emit.
    expect(cmd().argv).not.toContain("--agent-import-path")
  })

  test("it runs through the LOCKED adapter project, not an ambient harbor", () => {
    const { bin, argv } = cmd()
    expect(bin).toBe("uv")
    expect(argv.slice(0, 5)).toEqual([
      "run",
      "--project",
      "adapters/terminal-bench",
      "harbor",
      "run",
    ])
  })
})

describe("knob + provenance delivery", () => {
  test("every resolved knob rides --ae, so it wins over the host env", () => {
    const m = manifestFor()
    const { argv } = buildHarborRunCommand(m, { outputRoot: "/tmp/o" })
    const aeValues = argv.filter((_, i) => argv[i - 1] === "--ae")
    for (const [key, value] of Object.entries(m.resolvedKnobs)) {
      expect(aeValues, `${key} not delivered via --ae`).toContain(
        `${key}=${typeof value === "boolean" ? (value ? "1" : "0") : String(value)}`,
      )
    }
    expect(aeValues).toContain(`QUANTA_TB_AGENT_VERSION=${m.agentVersion}`)
  })

  test("the effort is an agent KWARG (--ak), not only an env var", () => {
    // `leaderboard/flows/filter.py` reads the submission's effort from
    // `config.agents[].kwargs.reasoning_effort`; an env-only delivery renders the
    // leaderboard row as "none".
    const { argv } = cmd()
    expect(after(argv, "--ak")).toBe("reasoning_effort=xhigh")
    expect(buildBrainDeliveryEnv(manifestFor()).QUANTA_REASONING_EFFORT).toBe("xhigh")
  })

  test("PROFILE DIFFERENTIAL — the two profiles produce DIFFERENT --ae sets", () => {
    const sets = TERMINAL_PROFILES.map((profile) => {
      const m = buildTerminalRunManifest({
        cfg: resolveTerminalRunConfig({
          argv: [
            "bun",
            "cli.ts",
            "terminal",
            "run",
            "--profile",
            profile,
            "--model",
            "gpt-5.5",
            "--provider",
            "openai",
            "--effort",
            "xhigh",
          ],
          env: {},
        }),
        provenance: { packageVersion: "1.0.025", sha: "9d5369d310bb", dirty: false },
        harborVersion: "0.21.0",
        timestamp: "2026-08-22T00:00:00.000Z",
      })
      const { argv } = buildHarborRunCommand(m, { outputRoot: "/tmp/o" })
      return argv.filter((_, i) => argv[i - 1] === "--ae").sort()
    })
    expect(sets[0]).not.toEqual(sets[1] as string[])
    expect(Object.keys(TERMINAL_PROFILE_KNOBS.control).length).toBeGreaterThan(0)
  })
})

describe("task selection", () => {
  test("a full run passes NO -i include filter", () => {
    expect(cmd().argv).not.toContain("-i")
  })

  test("oracle / canary runs pass exactly their pinned ids", () => {
    for (const purpose of ["oracle", "canary"] as const) {
      const m = manifestFor(["--tasks", purpose])
      const { argv } = buildHarborRunCommand(m, { outputRoot: "/tmp/o" })
      const includes = argv.filter((_, i) => argv[i - 1] === "-i")
      if (m.taskSelection === "full") throw new Error("narrow")
      expect(includes.sort()).toEqual([...m.taskSelection.ids].sort())
    }
  })
})

describe("upload posture is never inferred", () => {
  test("no upload flags at all when upload is off", () => {
    const { argv } = cmd()
    expect(argv).not.toContain("--upload")
    expect(argv).not.toContain("--public")
    expect(argv).not.toContain("--private")
  })

  test("an explicit posture emits BOTH --upload and the visibility flag", () => {
    expect(cmd(["--upload", "--public"]).argv).toContain("--public")
    expect(cmd(["--upload", "--public"]).argv).toContain("--upload")
    expect(cmd(["--upload", "--private"]).argv).toContain("--private")
    expect(cmd(["--upload", "--private"]).argv).not.toContain("--public")
  })
})

describe("the dry-run receipt shows argv and env NAMES, never secret values", () => {
  const SECRET = "sk-live-DO-NOT-PRINT-0123456789"

  test("no argv token carries a credential VALUE", () => {
    const env = { OPENAI_API_KEY: SECRET, PATH: "/usr/bin" }
    const { argv } = buildHarborRunCommand(manifestFor(), { outputRoot: "/tmp/o", env })
    expect(argv.join(" ")).not.toContain(SECRET)
  })

  test("the receipt lists the credential NAME but redacts its value", () => {
    const env = { OPENAI_API_KEY: SECRET, ANTHROPIC_API_KEY: "also-secret", PATH: "/usr/bin" }
    const receipt = formatHarborDryRunReceipt(
      buildHarborRunCommand(manifestFor(), { outputRoot: "/tmp/o", env }),
      env,
    )
    expect(receipt).toContain("OPENAI_API_KEY")
    expect(receipt).not.toContain(SECRET)
    expect(receipt).not.toContain("also-secret")
    expect(receipt).toMatch(/redacted/i)
    // Anti-vacuity: it really did print the command.
    expect(receipt).toContain(HARBOR_AGENT_SELECTOR)
    expect(receipt).toContain(`${TERMINAL_BENCH_DATASET}@${TERMINAL_BENCH_DATASET_REF}`)
  })

  test("the secret-name vocabulary covers the provider keys the adapter documents", () => {
    const declared: readonly string[] = SECRET_ENV_NAME_SUFFIXES
    for (const suffix of ["_API_KEY", "_KEY", "_TOKEN", "_SECRET", "_PASSWORD"]) {
      expect(declared).toContain(suffix)
    }
  })

  test("RED RAIL — a knob whose VALUE looks like a live credential is refused from argv", () => {
    const env = { OPENAI_API_KEY: SECRET }
    expect(() =>
      buildHarborRunCommand(
        {
          ...manifestFor(),
          resolvedKnobs: { ...manifestFor().resolvedKnobs, QUANTA_MAX_TURNS: SECRET },
        },
        { outputRoot: "/tmp/o", env },
      ),
    ).toThrow(/secret|credential/i)
  })
})

describe("the -i include id matches the PINNED harbor filter contract", () => {
  // `_filter_task_ids` does `fnmatch(task_id.get_name(), pattern)`, and for a
  // PACKAGE dataset (a `name` containing "/", which `terminal-bench/terminal-bench-2-1`
  // is) the ids are `PackageTaskId`s whose `get_name()` is `f"{org}/{name}"`.
  // So the include pattern must be the FULL `org/name`, not the bare task name.
  // If a harbor bump flips that to the bare name, every canary run aborts with
  // "No tasks matched the filter(s)" — this reads upstream's bytes so the bump
  // is caught at test time instead of at job-start time.
  const VENV = join(REPO_ROOT, "adapters/terminal-bench/.venv/lib/python3.13/site-packages/harbor")

  test("upstream still keys the filter on get_name() == org/name", () => {
    let idSource: string
    let filterSource: string
    try {
      idSource = readFileSync(join(VENV, "models/task/id.py"), "utf8")
      filterSource = readFileSync(join(VENV, "models/job/config.py"), "utf8")
    } catch {
      expect(true, "SKIPPED: adapters/terminal-bench/.venv not synced").toBe(true)
      return
    }
    expect(filterSource).toContain("fnmatch(task_id.get_name(), pattern_id)")
    expect(idSource).toContain('return f"{self.org}/{self.name}"')
    // And an unmatched filter ABORTS — it does not widen to the whole dataset.
    expect(filterSource).toContain("No tasks matched the filter(s)")

    const m = manifestFor(["--tasks", "canary"])
    const { argv } = buildHarborRunCommand(m, { outputRoot: "/tmp/o" })
    const includes = argv.filter((_, i) => argv[i - 1] === "-i")
    expect(includes.length).toBe(3)
    for (const id of includes) expect(id).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+$/)
  })
})

/**
 * aug-22 audit — the receipt's credential line was PROVIDER-BLIND, the same
 * defect the doctor's `credentials` check carried. With no env key present it
 * printed "the run would have no provider credential"; for `chatgpt-oauth`,
 * whose credential is an on-disk token bundle and which reads no env key at all,
 * that is false — and it tells an operator with a working setup to abort the run
 * they were about to make. The env-key providers keep the warning, because for
 * them an empty list really does mean the run cannot authenticate.
 */
describe("dry-run receipt — the credential line is provider-aware", () => {
  const receiptFor = (provider: string) =>
    formatHarborDryRunReceipt(cmd(["--provider", provider]), {})

  test("chatgpt-oauth: an empty env is the NORMAL state, not a missing credential", () => {
    const receipt = receiptFor("chatgpt-oauth")
    expect(receipt).toContain("on-disk token bundle")
    expect(receipt).not.toContain("would have no provider credential")
  })

  test("PAIRED CONTROL — an env-key provider still warns", () => {
    // openai only: this fixture requests `xhigh`, which the anthropic surface
    // cannot deliver, and the config REFUSES that combination outright (a
    // separate, correct rail) — so anthropic cannot be exercised from here.
    expect(receiptFor("openai")).toContain("would have no provider credential")
  })

  test("a present env key is still listed by NAME with its value redacted", () => {
    const receipt = formatHarborDryRunReceipt(cmd(["--provider", "openai"]), {
      OPENAI_API_KEY: "sk-super-secret-value",
    })
    expect(receipt).toContain("OPENAI_API_KEY=<redacted>")
    expect(receipt).not.toContain("sk-super-secret-value")
  })
})
