/**
 * PMX — THE ANSWER KEY IS NOT MATERIALIZED WHILE ANYTHING FROM THE RUN'S OWN
 * SESSION IS STILL ON THE BOX.
 *
 * The gold boundary's liveness gate asked ONE question:
 *
 *     pgrep -f '[a]pps/bench/cli.ts run'
 *
 * — is the command line we launched still running. That is a single command
 * line, and the agent has an unsandboxed shell as the bench user for the whole
 * of its own phase. A reader left behind like
 *
 *     setsid sh -c 'while :; do cat …/upstream/data/*.json && break; sleep 0.2; done > /tmp/.k'
 *
 * carries a completely different command line, survives the agent phase, is
 * invisible to that pgrep, and reads the answer key the instant the grader phase
 * materializes it. The gate answered "the agent is gone" and the clone went
 * ahead.
 *
 * What makes a real answer possible: the bench is launched as its OWN session
 * leader (`setsid bash -c … &`), so its session id is knowable AT LAUNCH and the
 * whole session is reapable. The launcher records it beside `run.exit`, and the
 * grade refuses until `pgrep -s <sid>` reports the session EMPTY.
 *
 * SCOPE, stated so the residual hole is named rather than implied closed: a
 * process that starts its OWN new session (`setsid`, a daemonizing double-fork)
 * leaves the recorded session and this gate cannot see it. Closing THAT needs an
 * enumeration of the box's legitimate baseline — sshd, `systemd --user`, the
 * agent's own transient units — which cannot be written honestly without a real
 * box, and a guessed whitelist would refuse healthy runs. The reap covers what
 * the sid provably contains; it does not claim more.
 */
import { describe, expect, test } from "bun:test"
import { familyRemoteBootstrap } from "@/apps/bench/profiles/bootstrap"
import { runBenchDetachedPoll } from "@/apps/bench/remote/box-session/detached-poll"
import { runFamilyBoxGrade } from "@/apps/bench/remote/box-session/family-box-grade"
import { DEFAULT_CHUNK_PATHS, runSidPathFor } from "@/apps/bench/remote/box-session/types"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"
import type { Reply } from "./_fake-box"
import { cannedReply } from "./_fake-box"

const promaxBootstrap = () =>
  familyRemoteBootstrap(resolveBenchRunConfig({ argvFamily: "promax", env: {} }))

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

const SID = "4242"
/** where the launcher records the run's session id, derived exactly as the code does */
const RUN_SID_PATH = runSidPathFor("~/run.exit")
const ok = (stdout = ""): Reply => ({ code: 0, stdout, stderr: "" })
const NOTHING_MATCHED: Reply = { code: 1, stdout: "", stderr: "" }

interface BoxOpts {
  /** what `cat run.sid` answers. OMITTED ⇒ the file is not there at all. */
  readonly sid?: string
  /** how many SESSION probes report a survivor before the session reads empty.
   *  `Infinity` ⇒ a survivor no signal ever removes. */
  readonly survivesProbes?: number
  /** the survivor ignores SIGTERM and only a SIGKILL-strength reap removes it. */
  readonly ignoresTerm?: boolean
  /** `pgrep -s` cannot run at all (not installed / failed). */
  readonly sessionProbeExit?: number
}

/**
 * A box whose BENCH COMMAND is gone — `pgrep -f '[a]pps/bench/cli.ts run'`
 * answers "nothing matched", exactly as it does for the detached reader the
 * defect is about — while its SESSION still holds a process.
 */
const box = (opts: BoxOpts = {}) => {
  const issued: string[] = []
  let sessionProbes = 0
  let reapedForce = false
  let reapedTerm = false

  const sessionAlive = (): boolean => {
    // the TRULY unreapable survivor — it outlives every signal, which is the
    // case the refusal exists for.
    if (opts.survivesProbes === Number.POSITIVE_INFINITY) return true
    if (opts.ignoresTerm === true) return !reapedForce
    if (reapedTerm || reapedForce) return false
    return sessionProbes <= (opts.survivesProbes ?? 0)
  }

  const readSid = (): Reply =>
    opts.sid === undefined
      ? { code: 1, stdout: "", stderr: "cat: ~/run.sid: No such file or directory" }
      : ok(`${opts.sid}\n`)

  const sessionProbe = (): Reply => {
    sessionProbes += 1
    if (opts.sessionProbeExit !== undefined) {
      return { code: opts.sessionProbeExit, stdout: "", stderr: "pgrep: broken" }
    }
    return sessionAlive() ? ok("31337\n") : NOTHING_MATCHED
  }

  const reap = (cmd: string): Reply => {
    if (cmd.includes("-9")) reapedForce = true
    else reapedTerm = true
    return ok()
  }

  const ssh = async (cmd: string): Promise<Reply> => {
    issued.push(cmd)
    // the SESSION reap — recognized BEFORE the probes, because it sets the state
    // the next probe reads.
    if (cmd.includes("kill")) return reap(cmd)
    if (cmd.includes("pgrep -s")) return sessionProbe()
    // the BENCH COMMAND is gone. This is the whole point: the old gate stops here
    // and says the box is clean.
    if (cmd.includes("pgrep")) return NOTHING_MATCHED
    if (cmd.startsWith("cat ") && cmd.includes(RUN_SID_PATH)) return readSid()
    return cannedReply(cmd, { predictions: PREDS, passRate: PASS_RATE })
  }

  return { issued, sessionProbes: () => sessionProbes, ssh }
}

const grade = (b: ReturnType<typeof box>) =>
  runFamilyBoxGrade({
    ssh: b.ssh,
    log: () => {},
    family: "promax",
    bootstrap: promaxBootstrap(),
    paths: DEFAULT_CHUNK_PATHS,
    // the WAIT is the behaviour under test, not the wall clock
    sleep: async () => {},
  })

/** `git init` of the pinned upstream — the first gold-bearing command. */
const materializedGold = (issued: readonly string[]): boolean =>
  issued.some((c) => c.includes("'git'"))

describe("the launcher records the detached run's session id", () => {
  test("🔴 the launch writes run.sid beside run.exit, and still says LAUNCHED", async () => {
    const issued: string[] = []
    const ssh = async (cmd: string): Promise<Reply> => {
      issued.push(cmd)
      if (cmd.includes("setsid bash -c")) return ok("LAUNCHED\n")
      // the very first poll reports the run finished
      return ok(`0\n==XQ-RUN-EXIT-XQ==\n`)
    }
    const out = await runBenchDetachedPoll({
      ssh,
      aws: async () => ({ code: 0, stdout: "running", stderr: "" }),
      iid: "i-abc",
      benchCmd: "bun apps/bench/cli.ts run",
      runLog: "~/run.log",
      runExit: "~/run.exit",
      onLine: () => {},
      sleep: async () => {},
      now: () => 0,
    })
    expect(out.code).toBe(0)
    const launch = issued.find((c) => c.includes("setsid bash -c")) ?? ""
    expect(launch, "no launch command was issued").not.toBe("")
    // the sid file, beside the exit sentinel, written from INSIDE the new session
    expect(
      launch,
      "the launcher does not record the new session's id, so the grade has nothing to reap",
    ).toContain("~/run.sid")
    expect(launch, "the sid is not read from the session the bench actually runs in").toMatch(
      /ps -o sid=/,
    )
    // the marker `detached-poll` and every fake box in the suite key on
    expect(launch).toContain("LAUNCHED")
    // …and it is GUARDED: a launch whose session was never recorded can never be
    // proven reaped later, so it must not report success. Surfacing that at
    // launch beats discovering it after an hour of paid patch-gen.
    const guardAt = launch.search(/\[ -s ~\/run\.sid \] \|\|/)
    expect(guardAt, "the launch reports LAUNCHED without checking the sid landed").toBeGreaterThan(
      -1,
    )
    expect(guardAt).toBeLessThan(launch.indexOf("echo LAUNCHED"))
  })
})

describe("a survivor in the run's own session blocks the grader window", () => {
  test("🔴 the bench command is gone but its session still holds a process — REFUSE", async () => {
    // The detached reader: a different command line, invisible to the bench-command
    // pgrep, sitting in the session waiting for the answer key to appear.
    const b = box({ sid: SID, survivesProbes: Number.POSITIVE_INFINITY })
    await expect(grade(b)).rejects.toThrow(/session|survivor|survived/i)
    expect(
      materializedGold(b.issued),
      "the answer key was cloned onto a box still holding processes from the run",
    ).toBe(false)
  })

  test("🔴 the session is probed with the RECORDED sid, not a guess", async () => {
    const b = box({ sid: SID, survivesProbes: Number.POSITIVE_INFINITY })
    await grade(b).catch(() => {})
    const probe = b.issued.find((c) => c.includes("pgrep -s")) ?? ""
    expect(probe, "no session probe was issued").not.toBe("")
    expect(probe).toContain(`pgrep -s ${SID}`)
    // …and it asked the box for that sid first
    const readAt = b.issued.findIndex((c) => c.startsWith("cat ") && c.includes("run.sid"))
    expect(readAt).toBeGreaterThan(-1)
    expect(b.issued.indexOf(probe)).toBeGreaterThan(readAt)
  })

  test("PAIRED CONTROL: an EMPTY session lets the grade proceed normally", async () => {
    const b = box({ sid: SID })
    const out = await grade(b)
    expect(out?.artifactText).toBe(PASS_RATE)
    expect(materializedGold(b.issued)).toBe(true)
    // and it did not reap a session that had nothing in it
    expect(b.issued.some((c) => c.includes("kill"))).toBe(false)
  })
})

describe("a survivor is REAPED and re-probed before anything is refused", () => {
  test("🔴 a survivor the reap removes is NOT refused — the grade proceeds", async () => {
    // Refusing without trying is what threw away completed runs before. The
    // session is reaped, then it has to be OBSERVED empty.
    const b = box({ sid: SID, survivesProbes: 1 })
    const out = await grade(b)
    expect(out?.artifactText).toBe(PASS_RATE)
    const reap = b.issued.find((c) => c.includes("kill")) ?? ""
    expect(reap, "nothing was reaped").not.toBe("")
    // the whole GROUP, not one pid — a detached reader is not the pid we know
    expect(reap, "the reap does not target the session's process group(s)").toMatch(/kill .*-- -/)
    expect(reap).toContain(SID)
    // re-probed AFTER the reap, before any gold-bearing command
    const reapAt = b.issued.indexOf(reap)
    const reprobeAt = b.issued.findIndex((c, i) => i > reapAt && c.includes("pgrep -s"))
    const cloneAt = b.issued.findIndex((c) => c.includes("'git'"))
    expect(reprobeAt).toBeGreaterThan(reapAt)
    expect(cloneAt).toBeGreaterThan(reprobeAt)
  })

  test("🔴 a survivor that ignores SIGTERM is escalated before the grade proceeds", async () => {
    const b = box({ sid: SID, ignoresTerm: true })
    const out = await grade(b)
    expect(out?.artifactText).toBe(PASS_RATE)
    expect(
      b.issued.some((c) => c.includes("kill") && c.includes("-9")),
      "the reap was never escalated",
    ).toBe(true)
  })

  test("🔴 a survivor nothing removes is refused AFTER the full ladder", async () => {
    const b = box({ sid: SID, survivesProbes: Number.POSITIVE_INFINITY })
    await expect(grade(b)).rejects.toThrow(/session/i)
    const kills = b.issued.filter((c) => c.includes("kill"))
    expect(kills.length, "it refused without attempting a reap").toBeGreaterThan(0)
    expect(
      kills.some((c) => c.includes("-9")),
      "it refused without escalating",
    ).toBe(true)
    expect(materializedGold(b.issued)).toBe(false)
  })
})

describe("every unreadable state fails CLOSED", () => {
  test("🔴 a MISSING run.sid refuses — it does not proceed as if the box were clean", async () => {
    const b = box({})
    await expect(grade(b)).rejects.toThrow(/run\.sid|session/i)
    expect(materializedGold(b.issued)).toBe(false)
  })

  test("🔴 a run.sid that is not a session id refuses", async () => {
    const b = box({ sid: "not-a-pid" })
    await expect(grade(b)).rejects.toThrow(/session/i)
    expect(materializedGold(b.issued)).toBe(false)
  })

  test("🔴 a session probe that could not RUN is not read as `nothing survived`", async () => {
    // `pgrep` exits 1 when nothing matched and 2/3/127 when it FAILED — and both
    // print nothing. Reading the second as an empty session is the same collapse
    // the bench-command probe already refuses.
    const b = box({ sid: SID, sessionProbeExit: 127 })
    await expect(grade(b)).rejects.toThrow(/could not|establish|session/i)
    expect(materializedGold(b.issued)).toBe(false)
  })

  test("🔴 the box going unreachable during the session probe refuses", async () => {
    const b = box({ sid: SID, sessionProbeExit: 255 })
    await expect(grade(b)).rejects.toThrow(/unreachable|could not be established/i)
    expect(materializedGold(b.issued)).toBe(false)
  })
})
