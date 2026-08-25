/**
 * PMX-04 — THE ANSWER KEY IS NOT MATERIALIZED WHILE THE AGENT MAY STILL BE ALIVE.
 *
 * The bench is launched detached, and the completion probe accepts EITHER
 * `run.exit` or a fallback:
 *
 *     if [ -s run.exit ]; then cat run.exit;
 *     elif <report parses> && <preds non-empty>; then echo 0; fi
 *
 * On that second branch the wrapper never wrote `run.exit`, so the bench's state
 * is unknown — the artifacts merely look finished. `runChunkBench` then returns
 * and the grader phase clones the pinned upstream onto the box.
 *
 * The whole gold boundary rests on the agent and the answer key never coexisting.
 * The agent phase proves the key is absent before it starts; nothing proved the
 * AGENT was gone before the key arrived. Every abnormal exit already throws
 * `BoxDiedDuringRunError` and skips the grade, so the hole is precisely the
 * benign-looking artifact fallback.
 *
 * The probe is the literal command we launched, not a guess at process names.
 */
import { describe, expect, test } from "bun:test"
import { familyRemoteBootstrap } from "@/apps/bench/profiles/bootstrap"
import { PROMAX_V1_SNAPSHOT } from "@/apps/bench/promax/provenance/frozen-snapshot"
import { runFamilyBoxGrade } from "@/apps/bench/remote/box-session/family-box-grade"
import { DEFAULT_CHUNK_PATHS } from "@/apps/bench/remote/box-session/types"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"

const promaxBootstrap = () =>
  familyRemoteBootstrap(resolveBenchRunConfig({ argvFamily: "promax", env: {} }))

const DIGESTS: ReadonlyArray<readonly [string, string]> = [
  ["data/swe-bench-promax.json", PROMAX_V1_SNAPSHOT.dataset_sha256],
  ["data/eval.json", PROMAX_V1_SNAPSHOT.eval_sha256],
  ["src/evaluation/test_run.py", PROMAX_V1_SNAPSHOT.evaluator_sha256],
]
const PREDS = `${JSON.stringify({ instance_id: "aws__s2n-tls-5464", model_patch: "P" })}\n`
const PASS_RATE = JSON.stringify([
  {
    instance_id: "aws__s2n-tls-5464",
    language: "c",
    passed: true,
    model: { final_result: "success", raw_reason: "success", returncode: 0, script_exit_code: 0 },
    golden: { final_result: "success", raw_reason: "success", returncode: 0, script_exit_code: 0 },
  },
])

/** `agentAlive` ⇒ the box reports a live bench process. */
/**
 * `agentAlive` ⇒ alive forever (a wedged agent).
 * `aliveForProbes` ⇒ alive for the first N probes, then gone — the REAL shape,
 * because the wrapper writes `run.exit` LAST and so outlives the artifacts.
 */
interface RecorderOpts {
  agentAlive?: boolean
  aliveForProbes?: number
  /** probes the process stays ALIVE after SIGTERM before dying — a real process
   *  does not vanish the instant `pkill` returns. */
  diesAfterTermProbes?: number
  /** the process ignores SIGTERM entirely and only SIGKILL ends it. */
  ignoresTerm?: boolean
  /** `pkill` is not on the box at all: exit 127, nothing killed. */
  pkillMissing?: boolean
}

type Reply = { code: number; stdout: string; stderr: string }
const ok = (stdout = ""): Reply => ({ code: 0, stdout, stderr: "" })
const ALIVE = ok("ALIVE\n")
const GONE: Reply = { code: 1, stdout: "", stderr: "" }

/** The box's canned answers to everything that is NOT the liveness dance. */
const staticReply = (cmd: string): Reply | undefined => {
  if (cmd.includes('printf %s "$HOME"')) return ok("/home/ubuntu")
  if (cmd.includes("--version")) return ok("Python 3.11.14\n")
  if (cmd.includes("sha256sum")) {
    const hit = DIGESTS.find(([s]) => cmd.includes(s))
    return hit === undefined ? { code: 1, stdout: "", stderr: "no such file" } : ok(`${hit[1]}  x`)
  }
  if (cmd.startsWith("cat ") && cmd.includes(DEFAULT_CHUNK_PATHS.preds)) return ok(PREDS)
  if (cmd.startsWith("cat ") && cmd.includes(DEFAULT_CHUNK_PATHS.passRate)) return ok(PASS_RATE)
  return undefined
}

const recorder = (opts: RecorderOpts = {}) => {
  const issued: string[] = []
  let probes = 0
  let termedAtProbe: number | null = null
  let killed9 = false

  /** Models the REAL command: `pgrep -f … >/dev/null && echo ALIVE`. When
   *  nothing matches, the `&&` short-circuits — empty stdout, non-zero exit. */
  const liveness = (): Reply => {
    probes += 1
    // `agentAlive` is the TRULY unkillable process: it outlives every signal,
    // which is the case the refusal exists for.
    if (opts.agentAlive === true) return ALIVE
    if (killed9) return GONE
    if (termedAtProbe !== null && opts.ignoresTerm !== true) {
      return probes - termedAtProbe > (opts.diesAfterTermProbes ?? 0) ? GONE : ALIVE
    }
    return probes <= (opts.aliveForProbes ?? 0) ? ALIVE : GONE
  }

  const signal = (cmd: string): Reply => {
    if (opts.pkillMissing === true) {
      return { code: 127, stdout: "", stderr: "pkill: command not found" }
    }
    if (cmd.includes("-9")) killed9 = true
    else if (termedAtProbe === null) termedAtProbe = probes
    return ok()
  }

  return {
    issued,
    probeCount: () => probes,
    ssh: async (cmd: string): Promise<Reply> => {
      issued.push(cmd)
      if (cmd.includes("pkill")) return signal(cmd)
      if (cmd.includes("pgrep")) return liveness()
      return staticReply(cmd) ?? ok()
    },
  }
}

const grade = (r: ReturnType<typeof recorder>) =>
  runFamilyBoxGrade({
    ssh: r.ssh,
    log: () => {},
    family: "promax",
    bootstrap: promaxBootstrap(),
    paths: DEFAULT_CHUNK_PATHS,
    // no real sleeping in a unit test — the WAIT is the behaviour under test,
    // not the wall clock.
    sleep: async () => {},
  })

const materializedGold = (issued: readonly string[]): boolean =>
  issued.some((c) => c.includes("'git'"))

describe("a live agent process blocks the grader window", () => {
  test("🔴 a bench that will not die even when ENDED still blocks the window", async () => {
    // `agentAlive: true` models a process that survives everything — the guard
    // waits, ends it, re-probes, and only THEN refuses. A refusal that comes
    // after an attempt to fix the situation is the honest one; refusing without
    // trying is what threw away a completed run earlier.
    const r = recorder({ agentAlive: true })
    await expect(grade(r)).rejects.toThrow(/survived being ended|cannot account for/i)
    expect(
      materializedGold(r.issued),
      "the answer key was cloned onto a box still running the agent",
    ).toBe(false)
  })

  test("🔴 the check happens BEFORE anything is materialized", async () => {
    const r = recorder({ agentAlive: true })
    await grade(r).catch(() => {})
    const probeAt = r.issued.findIndex((c) => c.includes("pgrep"))
    expect(probeAt).toBeGreaterThan(-1)
    // nothing gold-bearing issued at all, so ordering is trivially satisfied
    expect(r.issued.filter((c) => c.includes("'git'"))).toEqual([])
  })

  test("🔴 an agent that is FINISHING is WAITED for, not refused", async () => {
    // The real shape: the wrapper writes `run.exit` last, so the process outlives
    // the artifacts by moments. Refusing there discards a completed run.
    const r = recorder({ aliveForProbes: 2 })
    const out = await grade(r)
    expect(out?.artifactText).toBe(PASS_RATE)
    expect(r.probeCount(), "it did not re-probe — it decided on the first answer").toBeGreaterThan(
      1,
    )
    expect(materializedGold(r.issued)).toBe(true)
  })

  test("PAIRED CONTROL: with the agent gone, the grade proceeds normally", async () => {
    const r = recorder({ agentAlive: false })
    const out = await grade(r)
    expect(out?.artifactText).toBe(PASS_RATE)
    expect(materializedGold(r.issued)).toBe(true)
  })

  test("the probe names the bench command we actually launched", async () => {
    const r = recorder({ agentAlive: false })
    await grade(r)
    const probe = r.issued.find((c) => c.includes("pgrep")) ?? ""
    // the bracket form — see the self-match test below. It still NAMES the bench
    // command; it just cannot find the shell asking the question.
    expect(probe).toContain("[a]pps/bench/cli.ts run")
  })
})

describe("a FAILED probe is not an answer", () => {
  test("🔴 ssh failing during the wait must NOT read as `the agent exited`", async () => {
    // MEASURED: the second canary box was spot-reclaimed WHILE the guard was
    // waiting. `pgrep … && echo ALIVE` over a dead box returns empty stdout and a
    // non-zero exit — identical, to a `stdout !== "ALIVE"` test, to "nothing
    // matched". So a dying box read as a clean agent exit, and the next thing the
    // code would do is materialize the answer key on it.
    const issued: string[] = []
    const ssh = async (cmd: string) => {
      issued.push(cmd)
      if (cmd.includes("pgrep")) {
        return { code: 255, stdout: "", stderr: "ssh: connect to host: Connection refused" }
      }
      return { code: 0, stdout: "", stderr: "" }
    }
    await expect(
      runFamilyBoxGrade({
        ssh,
        log: () => {},
        family: "promax",
        bootstrap: promaxBootstrap(),
        paths: DEFAULT_CHUNK_PATHS,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/could not be established|unreachable|ssh/i)
    // and NOTHING gold-bearing was issued on a box we could not reach
    expect(issued.some((c) => c.includes("'git'"))).toBe(false)
  })
})

describe("the probe cannot match ITSELF", () => {
  test("🔴 the pattern is written so the probing shell's own command line does not match it", () => {
    // A PRECAUTION, not a fix for something measured. `pgrep -f` matches full
    // command lines and the probing shell carries the pattern in its own, so a
    // literal pattern could in principle find the probe itself and answer ALIVE
    // forever. A self-match was NOT reproducible on macOS, so it is not claimed
    // as the cause of anything — but the bracket form costs nothing and removes
    // the possibility: `[a]pps/…` matches the literal `apps/…` in another
    // process, while this command line contains `[a]pps/…`, which it does not
    // match. Verified separately that it still finds a real process.
    const issued: string[] = []
    const ssh = async (cmd: string) => {
      issued.push(cmd)
      if (cmd.includes("pgrep")) return { code: 1, stdout: "", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    }
    return runFamilyBoxGrade({
      ssh,
      log: () => {},
      family: "promax",
      bootstrap: promaxBootstrap(),
      paths: DEFAULT_CHUNK_PATHS,
      sleep: async () => {},
    })
      .catch(() => {})
      .then(() => {
        const probe = issued.find((c) => c.includes("pgrep")) ?? ""
        expect(probe, "no probe was issued").not.toBe("")
        // the regex, applied to the probe's OWN text, must not match it
        const pattern = /\[a\]pps\/bench\/cli\.ts run/
        expect(probe, "the probe does not use a self-excluding pattern").toMatch(pattern)
        const asRegex = /apps\/bench\/cli\.ts run/
        expect(
          asRegex.test(probe),
          "the probe's own command line still matches the pattern it searches for",
        ).toBe(false)
      })
  })
})

describe("a bench that FINISHED but will not exit is ended, not waited on forever", () => {
  test("🔴 a process that never exits is TERMINATED, then re-verified gone", async () => {
    // MEASURED on a real box, by ssh-ing in: the bench had written report.json
    // and preds.jsonl and printed its final summary ("7/7 instances",
    // "failures: grader_invalid=7", "$6.52"), yet PID 4826 was still `Rl` at
    // 69.7% CPU with NO children and `run.exit` absent — twenty minutes in. It
    // completes its work and then spins forever. That is the pre-existing bench
    // hang the artifact fallback exists to work around, and it means waiting for
    // an exit can never succeed.
    //
    // We own the box and the work is demonstrably done, so the honest move is to
    // END it and then PROVE it is gone — "no agent is running" becomes true
    // rather than assumed.
    const issued: string[] = []
    let killed = false
    // The fake is a TABLE, matched in order, because the order is part of what
    // it models: `pkill` must be recognized before `pgrep` (it sets the flag the
    // liveness answer reads), and the two `cat` arms differ only by path. As an
    // if-chain this scored 31 cognitive complexity — in a file that exists to
    // pin a safety boundary, where the fake being hard to read is the last thing
    // anyone wants.
    const SSH_CASES: ReadonlyArray<{
      readonly when: (cmd: string) => boolean
      readonly reply: (cmd: string) => { code: number; stdout: string; stderr: string }
    }> = [
      {
        when: (c) => c.includes("pkill"),
        reply: () => {
          killed = true
          return { code: 0, stdout: "", stderr: "" }
        },
      },
      {
        // The stuck bench answers ALIVE until it is ended, then reports gone.
        when: (c) => c.includes("pgrep"),
        reply: () =>
          killed ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: "ALIVE\n", stderr: "" },
      },
      {
        when: (c) => c.includes("$HOME"),
        reply: () => ({ code: 0, stdout: "/home/ubuntu", stderr: "" }),
      },
      {
        when: (c) => c.includes("--version"),
        reply: () => ({ code: 0, stdout: "Python 3.11.14\n", stderr: "" }),
      },
      {
        when: (c) => c.includes("sha256sum"),
        reply: (c) => {
          const hit = DIGESTS.find(([d]) => c.includes(d))
          return hit === undefined
            ? { code: 1, stdout: "", stderr: "no such file" }
            : { code: 0, stdout: `${hit[1]}  x`, stderr: "" }
        },
      },
      {
        when: (c) => c.startsWith("cat ") && c.includes(DEFAULT_CHUNK_PATHS.preds),
        reply: () => ({ code: 0, stdout: PREDS, stderr: "" }),
      },
      {
        when: (c) => c.startsWith("cat ") && c.includes(DEFAULT_CHUNK_PATHS.passRate),
        reply: () => ({ code: 0, stdout: PASS_RATE, stderr: "" }),
      },
    ]
    const ssh = async (cmd: string) => {
      issued.push(cmd)
      return SSH_CASES.find((c) => c.when(cmd))?.reply(cmd) ?? { code: 0, stdout: "", stderr: "" }
    }
    const out = await runFamilyBoxGrade({
      ssh,
      log: () => {},
      family: "promax",
      bootstrap: promaxBootstrap(),
      paths: DEFAULT_CHUNK_PATHS,
      sleep: async () => {},
    })
    expect(out?.artifactText).toBe(PASS_RATE)
    // it really did terminate it …
    expect(
      issued.some((c) => c.includes("pkill")),
      "the stuck bench was never ended",
    ).toBe(true)
    // … and re-verified before any gold-bearing command
    const killAt = issued.findIndex((c) => c.includes("pkill"))
    const cloneAt = issued.findIndex((c) => c.includes("'git'"))
    expect(cloneAt).toBeGreaterThan(killAt)
  })
})

/**
 * ENDING A PROCESS IS NOT INSTANT, and `pkill` is not guaranteed to work.
 *
 * The kill path used to be `pkill … ; true` followed immediately by `continue`:
 * the very next probe decided the verdict, with zero grace. A process that
 * would have died 200ms later answered ALIVE once and the run — whose report
 * and predictions were already written — was refused as "survived being ended".
 * And `; true` discarded `pkill`'s own status, so a box without `pkill` (exit
 * 127, nothing signalled) produced that same refusal under a diagnosis naming
 * the wrong subsystem.
 */
describe("ending the finished bench process", () => {
  test("🔴 a process that dies a moment after SIGTERM is NOT called a survivor", async () => {
    // alive through the grace, then TERMed, then alive for two more probes
    const r = recorder({ aliveForProbes: 999, diesAfterTermProbes: 2 })
    await grade(r)
    expect(materializedGold(r.issued), "a normally-terminating process blocked the grade").toBe(
      true,
    )
    // …and it was not SIGKILLed on the way. Without this the settle window is
    // unpinned: setting it to zero escalates instantly, the SIGKILL kills the
    // process, and "it was not called a survivor" passes for the wrong reason.
    expect(
      r.issued.some((c) => c.includes("pkill") && c.includes("-9")),
      "a process that was dying normally was SIGKILLed anyway",
    ).toBe(false)
  })

  test("🔴 a process that IGNORES SIGTERM is escalated to SIGKILL before being refused", async () => {
    const r = recorder({ aliveForProbes: 999, ignoresTerm: true })
    await grade(r)
    const kills = r.issued.filter((c) => c.includes("pkill"))
    expect(
      kills.some((c) => c.includes("-9")),
      "SIGTERM was never escalated",
    ).toBe(true)
    expect(materializedGold(r.issued)).toBe(true)
  })

  test("🔴 a box with no `pkill` says so, instead of blaming the process", async () => {
    const r = recorder({ agentAlive: true, pkillMissing: true })
    await expect(grade(r)).rejects.toThrow(/could not (be )?end|pkill|command not found/i)
    expect(materializedGold(r.issued), "the answer key was materialized anyway").toBe(false)
  })

  test("PAIRED CONTROL: a truly unkillable process is still refused", async () => {
    // survives SIGTERM *and* SIGKILL — the case the refusal exists for
    const r = recorder({ agentAlive: true })
    await expect(grade(r)).rejects.toThrow(/survived being ended/i)
    expect(materializedGold(r.issued)).toBe(false)
  })
})
