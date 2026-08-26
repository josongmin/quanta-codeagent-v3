/**
 * PMX-04 — THE SECOND ON-BOX INVOCATION, for a family that grades inside its own
 * grader phase.
 *
 * Every other family grades inline during patch-gen: one on-box command does
 * both, and nothing here runs for them (no ssh, no profile call, byte-identical).
 *
 * ProMax cannot share that shape. Its grader phase materializes the answer key,
 * and its agent phase must run while the key is ABSENT — the agent bootstrap
 * carries an `absenceProbe` that proves it. One invocation cannot satisfy both,
 * so the chunk is:
 *
 *   1. patch-gen only, key absent          (the bench command, grading shim off)
 *   2. grader phase materializes the key
 *   3. THE GRADE                            ← this module, inside that window
 *   4. teardown removes the key             (bound to the same executor call)
 *
 * Steps 2-4 are one `executeFamilyRemoteBootstrap({ phase: "grader" })` call, so
 * the teardown cannot be skipped — not on success, not when the grade throws.
 * This module never sequences them itself; handing the command to the
 * `whileMaterialized` seam is what makes that guarantee structural.
 *
 * No `family === "promax"` branch: which families do this is decided by whether
 * their profile declares `boxGrade`, per packet invariant 10.
 */
import { abortableSleep } from "@/shared"
import type { DatasetFamily } from "../../dataset-family-token"
import {
  buildProMaxImageProvenanceCommand,
  PROMAX_IMAGE_PROVENANCE_SCRIPT,
  PROMAX_IMAGE_PROVENANCE_SCRIPT_PATH,
  parseProMaxImageProvenance,
} from "../../harness/promax/image-provenance"
import { resolveDatasetFamilyProfile } from "../../profiles/registry"
import type { FamilyBoxGradeVerdicts, FamilyRemoteBootstrap } from "../../profiles/types"
import { executeFamilyRemoteBootstrap } from "./family-bootstrap-exec"
import type { BoxSession, ChunkPaths } from "./types"

/**
 * Turn a chunk path into a real absolute on-box path.
 *
 * `~/x` and `$HOME/x` are shell-expansion forms, not paths: they mean nothing to
 * a quoted argv token, and nothing to a receipt that claims to be replayable.
 * Already-absolute paths pass through untouched.
 */
export const absolutizeOnBox = (path: string, home: string): string => {
  const root = home.replace(/\/+$/, "")
  if (path.startsWith("~/")) return `${root}/${path.slice(2)}`
  if (path.startsWith("$HOME/")) return `${root}/${path.slice(6)}`
  return path
}

/** Ask the box where its home is. One round trip, and only for a family that
 *  actually grades on-box — an inline-grading family never reaches here. */
const resolveBoxHome = async (ssh: BoxSession["ssh"]): Promise<string> => {
  const r = await ssh('printf %s "$HOME"')
  const home = r.stdout.trim()
  if (r.code !== 0 || home === "" || !home.startsWith("/")) {
    throw new Error(
      `[full-remote] could not resolve the box's $HOME (code ${r.code}, got ${JSON.stringify(home)}). ` +
        "The on-box grade needs absolute paths — a quoted `~` expands to nothing and the " +
        "evaluator would read an empty predictions file and grade every instance as a miss.",
    )
  }
  return home
}

/**
 * PMX-04 — RE-PROVE the box is free of the answer key, before THIS chunk's agent
 * phase.
 *
 * The agent-phase bootstrap carries `absenceProbe`, and it is executed when a box
 * is provisioned and when a warm box is attached — but a pool worker holds one
 * live session across many chunks, so chunks 2..N started their agent phase with
 * nothing re-checking that the previous chunk's teardown actually worked.
 *
 * The teardown is bound to the grade call and runs on every in-process exit, and
 * a failing teardown throws (the pool then terminates the box). So the uncovered
 * case is narrow and exact: a teardown that exits 0 WITHOUT having removed
 * everything. That is precisely the case the probe exists to catch as a second
 * gate — and at the chunk boundary that gate was missing.
 *
 * It runs the AGENT phase, so the executor's own cross-check applies: a
 * gold-bearing command in this phase is refused before a single ssh. Re-proving
 * absence can therefore never materialize the thing it is checking for.
 *
 * A family with no declared bootstrap issues nothing — not one round trip.
 */
export const proveAnswerKeyAbsentForAgent = async (input: {
  readonly ssh: BoxSession["ssh"]
  readonly log: (m: string) => void
  readonly family: DatasetFamily
  readonly bootstrap: FamilyRemoteBootstrap | undefined
}): Promise<void> => {
  if (input.bootstrap === undefined) return
  await executeFamilyRemoteBootstrap({
    bootstrap: input.bootstrap,
    phase: "agent",
    ssh: input.ssh,
    log: input.log,
  })
}

/**
 * How long to let a finishing bench run exit before ENDING it, and how often to
 * ask.
 *
 * MEASURED across runs: by the time control reaches here the run's own artifacts
 * — report.json and preds.jsonl — are already on the box, because that is the
 * very condition the detached poll used to declare it complete. So the work is
 * done and this is only about the process.
 *
 * Two outcomes were both observed on real boxes: it exits on its own within
 * seconds, or it finishes its work and then spins at ~70% CPU indefinitely with
 * `run.exit` never landing (confirmed by ssh: PID alive 20 minutes, no children,
 * artifacts written, final summary printed). A long grace helps neither — the
 * first needs seconds, the second never comes back — so it is 60s, after which
 * the process is ended and re-verified rather than waited on.
 *
 * It was 600s. That cost ten minutes of paid box time per run to reach the same
 * decision.
 */
const AGENT_EXIT_GRACE_MS = 60_000
const AGENT_EXIT_POLL_MS = 5_000
const AGENT_EXIT_LOG_EVERY_MS = 30_000
/**
 * How long a signalled process is given to actually die.
 *
 * Ending a process is not instant. The kill path used to `continue` straight
 * into the next probe, so a process that would have died a moment later
 * answered ALIVE once and a run whose report and predictions were already
 * written got refused as "survived being ended".
 */
const AGENT_KILL_SETTLE_MS = 15_000

/**
 * What ONE liveness probe means.
 *
 * The three readings were spelled out inline and their ORDER is the contract:
 * "it survived being ended" outranks "the box went away", which outranks "it is
 * gone" — because a process we killed and that answered ALIVE anyway is the one
 * case where continuing would materialize the answer key beside something we
 * cannot account for, and that must be said even if the transport is also
 * misbehaving. Stating the order once, here, is what stops a later edit from
 * reshuffling it while the branches still read plausibly.
 *
 * `refuse` carries the full message so the caller is a `throw new Error(reason)`
 * with no second copy of the wording.
 */
type ExitProbeVerdict =
  | { readonly kind: "gone" }
  | { readonly kind: "alive" }
  | { readonly kind: "refuse"; readonly reason: string }

/**
 * Where the kill LADDER stands. "survived being ended" may only be claimed from
 * `exhausted` — after SIGTERM, a settle window, SIGKILL, and a second settle
 * window. Anything earlier is a process that has not been given time to die.
 */
type KillStage = "none" | "settling" | "exhausted"

const classifyExitProbe = (
  probe: { readonly code: number; readonly stdout: string; readonly stderr: string },
  kill: KillStage,
  family: DatasetFamily,
): ExitProbeVerdict => {
  if (kill === "exhausted" && probe.stdout.trim() === "ALIVE") {
    return {
      kind: "refuse",
      reason:
        `[full-remote] ${family}: the bench process survived being ended — REFUSING to ` +
        "materialize the answer key beside a process we cannot account for.",
    }
  }
  if (probe.code === 255) {
    return {
      kind: "refuse",
      reason:
        `[full-remote] ${family}: the box became unreachable while waiting for the bench ` +
        "process to exit, so whether an agent is still running there could not be established. " +
        `REFUSING to materialize the answer key on it. (${probe.stderr.trim() || "ssh exit 255"})`,
    }
  }
  if (probe.stdout.trim() === "ALIVE") return { kind: "alive" }
  // `pgrep … >/dev/null && echo ALIVE` exits 0 with ALIVE when the agent is up
  // and 1 with nothing when it is gone. EVERY other exit — 127 when pgrep is not
  // installed, 2 or 3 when it fails — also prints nothing, and reading that as
  // "gone" materializes the answer key beside a process nobody accounted for.
  // The negative has to be an ANSWER, not merely the absence of one; this file
  // already applies that rule to `pkill`'s 127 and the grader-container probe.
  if (probe.code !== 1) {
    return {
      kind: "refuse",
      reason:
        `[full-remote] ${family}: the liveness probe could not run (exit ${probe.code}` +
        `${probe.stderr.trim() === "" ? "" : `: ${probe.stderr.trim()}`}), so whether an agent ` +
        "is still running could not be established. REFUSING to materialize the answer key on it.",
    }
  }
  return { kind: "gone" }
}

/**
 * Signal the bench process, and REFUSE if the signal itself could not be sent.
 *
 * NOT `pkill … ; true`. That discarded pkill's own status, so a box without
 * `pkill` (exit 127, nothing signalled) still counted as "we ended it" and the
 * next probe refused the run as "survived being ended" — a diagnosis naming the
 * wrong subsystem entirely. pkill exits 1 when nothing MATCHED, which here means
 * the process died on its own between the probe and the signal: not an error.
 */
const signalAgent = async (
  input: { readonly ssh: BoxSession["ssh"]; readonly family: DatasetFamily },
  force: boolean,
): Promise<void> => {
  const ended = await input.ssh(`pkill ${force ? "-9 " : ""}-f '[a]pps/bench/cli.ts run'`)
  if (ended.code === 255) {
    throw new Error(
      `[full-remote] ${input.family}: the box became unreachable while ending the finished ` +
        "bench process. REFUSING to materialize the answer key on it.",
    )
  }
  if (ended.code !== 0 && ended.code !== 1) {
    throw new Error(
      `[full-remote] ${input.family}: could not end the finished bench process — \`pkill\` ` +
        `itself failed (code ${ended.code}: ` +
        `${ended.stderr.trim() || ended.stdout.trim() || "no output"}). REFUSING to materialize ` +
        "the answer key beside a process we did not signal.",
    )
  }
}

/** Where the kill ladder stands between probes. */
interface KillLadder {
  readonly kill: KillStage
  readonly sentSigkill: boolean
  readonly settledFor: number
}

/**
 * Advance ONE settle tick. Splitting this out of the wait loop keeps the loop
 * readable and puts the ladder's only state transition in one place: settle,
 * escalate once, and only then declare the ladder spent.
 */
const advanceKillLadder = async (
  input: {
    readonly ssh: BoxSession["ssh"]
    readonly log: (m: string) => void
    readonly family: DatasetFamily
  },
  state: KillLadder,
): Promise<KillLadder> => {
  const settledFor = state.settledFor + AGENT_EXIT_POLL_MS
  if (settledFor < AGENT_KILL_SETTLE_MS) return { ...state, settledFor }
  if (state.sentSigkill) return { ...state, kill: "exhausted", settledFor }
  input.log(
    `[full-remote] ${input.family}: the bench process ignored SIGTERM for ` +
      `${Math.round(AGENT_KILL_SETTLE_MS / 1000)}s; escalating to SIGKILL.`,
  )
  await signalAgent(input, true)
  return { kill: "settling", sentSigkill: true, settledFor: 0 }
}

/**
 * Wait for the bench process to leave the box, then let the caller proceed.
 *
 * The completion probe accepts EITHER `run.exit` or a fallback ("the report
 * parses and predictions is non-empty"). On the fallback the wrapper has not
 * written `run.exit` yet, so the process is typically alive for a moment longer.
 * That is the common case, not a failure.
 *
 * Throws only when it is STILL alive after the grace period — a wedged agent, and
 * the one case where materializing the answer key beside it would be wrong.
 */
const awaitAgentExit = async (input: {
  readonly ssh: BoxSession["ssh"]
  readonly log: (m: string) => void
  readonly family: DatasetFamily
  readonly sleep?: (ms: number) => Promise<void>
}): Promise<void> => {
  // The shared timer-clearing sleep, never a raw `new Promise(setTimeout)`: that
  // form leaks its timer and keeps waiting the full 5 s after a cancellation, so
  // the silent-failure ratchet caps how many exist. `abortableSleep` clears the
  // timer on every path and becomes abort-aware for free if this slice ever
  // gains a signal (it has none today — `BoxSession` carries no `AbortSignal`).
  const sleep = input.sleep ?? ((ms: number) => abortableSleep(ms))
  const deadline = AGENT_EXIT_GRACE_MS
  let waited = 0
  // Where the kill ladder stands, and how long the CURRENT rung has been
  // settling. The loop continues after each signal, so the process still has to
  // be observed gone; what changed is that it is given time to go.
  let kill: KillStage = "none"
  let sentSigkill = false
  let settledFor = 0
  for (;;) {
    // `pgrep … && echo ALIVE` prints ALIVE (exit 0) when the agent is up, and
    // nothing (exit 1) when it is gone. A TRANSPORT failure — ssh 255 on a box
    // being reclaimed — also prints nothing, and a bare `stdout !== "ALIVE"` test
    // read that as a clean agent exit. MEASURED: the second canary box was
    // spot-reclaimed mid-wait, and the next step would have been to materialize
    // the answer key on a box we could no longer reach.
    //
    // So the probe must ANSWER, not merely fail to say ALIVE. ssh's own 255 is
    // the transport's signal; pgrep never exits 255.
    // `[a]pps` is not a typo, and it is a PRECAUTION rather than a fix for
    // something measured. `pgrep -f` matches full command lines, and the shell
    // running this probe carries the pattern in its own; the bracket form makes
    // the pattern differ, as TEXT, from what it matches, so the probe can never
    // find itself. Verified locally that it still finds a real process carrying
    // the bench command line — the property that matters — while a self-match was
    // NOT reproducible on macOS, so it is not claimed as the cause of anything.
    const probe = await input.ssh("pgrep -f '[a]pps/bench/cli.ts run' >/dev/null && echo ALIVE")
    const verdict = classifyExitProbe(probe, kill, input.family)
    if (verdict.kind === "refuse") throw new Error(verdict.reason)
    if (verdict.kind === "gone") return
    // THE KILL LADDER. `waited >= deadline` fires ONCE, because `kill` leaves
    // "none" the moment a signal is sent; reusing the deadline as the condition
    // for every rung re-signalled forever and never reached the settle window.
    if (kill === "none" && waited >= deadline) {
      // MEASURED by ssh-ing into a real box: the bench had written report.json
      // and preds.jsonl and printed its final summary ("7/7 instances",
      // "failures: grader_invalid=7"), yet the process was still `Rl` at ~70% CPU
      // with NO children and `run.exit` absent, twenty minutes in. It finishes
      // its work and then SPINS — which is the pre-existing hang the artifact
      // fallback exists to work around, and it means waiting for an exit can
      // never succeed.
      //
      // We own this box and its work is demonstrably done, so END it rather than
      // refuse a completed run. Then RE-VERIFY: the loop continues, so a later
      // probe has to actually report it gone before anything is materialized —
      // "no agent is running" becomes true rather than assumed.
      input.log(
        `[full-remote] ${input.family}: the bench run finished its work but has not exited in ` +
          `${Math.round(deadline / 1000)}s (a known post-completion hang — its report and ` +
          "predictions are already written). Ending it, then re-checking before the answer key " +
          "is materialized.",
      )
      await signalAgent(input, false)
      kill = "settling"
      settledFor = 0
      await sleep(AGENT_EXIT_POLL_MS)
      continue
    }
    // A signalled process gets a BOUNDED window to actually die. Only when the
    // whole ladder — SIGTERM, settle, SIGKILL, settle — is spent does a probe
    // answering ALIVE mean "survived being ended".
    if (kill === "settling") {
      ;({ kill, sentSigkill, settledFor } = await advanceKillLadder(input, {
        kill,
        sentSigkill,
        settledFor,
      }))
      await sleep(AGENT_EXIT_POLL_MS)
      continue
    }
    // Log at the start and every AGENT_EXIT_LOG_EVERY_MS after: a silent wait is
    // indistinguishable from a hang.
    if (waited % AGENT_EXIT_LOG_EVERY_MS === 0) {
      input.log(
        `[full-remote] ${input.family}: the bench run has not exited yet (${Math.round(waited / 1000)}s ` +
          `of ${Math.round(AGENT_EXIT_GRACE_MS / 1000)}s). Its tail — trace flush, sandbox ` +
          "teardown, artifact writes — normally finishes well inside this budget; past it the " +
          "process is ended rather than waited on. Waiting before the answer key is " +
          "materialized…",
      )
    }
    await sleep(AGENT_EXIT_POLL_MS)
    waited += AGENT_EXIT_POLL_MS
  }
}

export interface FamilyBoxGradeInput {
  readonly ssh: BoxSession["ssh"]
  readonly log: (m: string) => void
  readonly family: DatasetFamily
  readonly bootstrap: FamilyRemoteBootstrap | undefined
  readonly paths: ChunkPaths
  /** the chunk's assigned instance ids — the set image provenance is reconciled
   *  against. Absent ⇒ no capture (nothing to reconcile). */
  readonly assignedInstanceIds?: readonly string[]
  /** test seam for the agent-exit wait; real runs use `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Run the family's own on-box grade, if it has one, and return the fetched grade
 * artifact TEXT.
 *
 * `undefined` ⇒ this family grades inline; the caller keeps reading verdicts from
 * the bench report exactly as before.
 *
 * The artifact is read back INSIDE the window, before the teardown removes the
 * checkout. Reading it afterwards would work today (the evaluator writes it
 * outside the checkout) but would depend on that staying true — and the file the
 * teardown is allowed to delete is exactly the kind of thing a later change moves.
 */
/** PREFLIGHT 1 — refuse to materialize the answer key while the agent may still
 *  be running. Split out of {@link runFamilyBoxGrade} so that function reads as
 *  its four stages; the reasoning is unchanged and travels with it. */
const assertNoLiveBenchProcess = async (input: FamilyBoxGradeInput): Promise<void> => {
  // IS THE AGENT GONE? Asked BEFORE the answer key is materialized.
  //
  // The bench is launched detached and the completion probe accepts EITHER
  // `run.exit` or a fallback — "the report parses and preds is non-empty". On
  // that fallback the wrapper never wrote `run.exit`, so the bench's state is
  // unknown: the artifacts merely LOOK finished. Every abnormal exit already
  // throws and skips the grade, so the hole is exactly the benign-looking case.
  //
  // The whole gold boundary rests on the agent and the answer key never
  // coexisting. The agent phase proves the key is absent before it starts;
  // nothing proved the AGENT was gone before the key arrived.
  //
  // The probe matches the literal command the box was told to run, not a guess
  // at process names. `pgrep` exits non-zero when nothing matches, which is the
  // answer we want.
  //
  // MEASURED on a live box: this is the NORMAL path, not an edge case. Patch-gen
  // finished all 7 instances, the poll accepted the artifact fallback, and the
  // wrapper was still finishing — it writes `run.exit` LAST. Refusing outright
  // discarded a completed run and bought another box, so the guard WAITS: the
  // safety property is "never materialize beside a live agent", not "never wait".
  await awaitAgentExit(input)
}

/** PREFLIGHT 2 — the predictions to grade, or `undefined` when there is nothing
 *  to grade and the chunk must be reported as an infra failure instead. */
const readGradablePredictions = async (input: FamilyBoxGradeInput): Promise<string | undefined> => {
  // IS THERE ANYTHING TO GRADE? Asked BEFORE the answer key is materialized.
  //
  // `runChunkBench` RETURNS its exit code rather than throwing, so a patch-gen
  // pass that died still arrives here. Grading nothing would clone the pinned
  // upstream onto the box, run the evaluator against an absent or empty
  // predictions file, and tear it down again — cost and exposure for a grade that
  // cannot say anything.
  //
  // The gate is deliberately NOT the exit code: a partially failed patch-gen
  // still produced patches for the instances that finished, and those must be
  // graded. "Are there predictions" is the question that actually decides it.
  //
  // Returning "" (rather than throwing) lets the assigned-set reconciliation turn
  // this into an infra error for every assigned instance — the chunk reads as the
  // total infra failure it was, instead of as a clean empty run.
  const preds = await input.ssh(`cat ${input.paths.preds}`)
  // A TRANSPORT failure is not an answer. `preds.code !== 0` used to fold ssh-255
  // into "patch-gen produced no predictions", which skips the grade and files
  // EVERY assigned instance as an infra error — so a dropped connection erased
  // real patches. Run 3's log shows it: the box had logged
  // `wrote /home/ubuntu/preds.jsonl (7 prediction(s))` eleven lines earlier.
  // `cat` never exits 255; ssh's own signal is distinguishable for free.
  if (preds.code === 255) {
    throw new Error(
      `[full-remote] ${input.family}: the box became unreachable while reading the predictions ` +
        `at ${input.paths.preds}, so whether patch-gen produced any could not be established. ` +
        `REFUSING to report them as absent. (${preds.stderr.trim() || "ssh exit 255"})`,
    )
  }
  if (preds.code !== 0 || preds.stdout.trim() === "" || preds.stdout.trim() === "[]") {
    input.log(
      `[full-remote] ${input.family}: patch-gen produced no predictions at ${input.paths.preds} — ` +
        "SKIPPING the on-box grade. The answer key is not materialized for a grade that would " +
        "have nothing to score; every assigned instance is reported as an infra error.",
    )
    return undefined
  }

  return preds.stdout
}

/** PREFLIGHT 3 — the on-box path whose bytes the family's grader will read. */
const materializeGradedPredictions = async (
  input: FamilyBoxGradeInput,
  prepare: ((raw: string) => string) | undefined,
  predictionsText: string,
): Promise<string> => {
  // CONVERT the predictions into the format this family's grader reads, if it
  // says it needs one. The bench writes JSONL for every family; ProMax's pinned
  // evaluator does `json.load` and needs a JSON array, and handing it the JSONL
  // yields a parse error — or, for a single row, a dict whose VALUES are read as
  // entries and therefore zero jobs.
  //
  // Written to its own path rather than over `preds`: that file is the run's own
  // artifact and is fetched as evidence, so rewriting it would destroy the bytes
  // the agent actually produced.
  let gradedPredictionsPath = input.paths.preds
  if (prepare !== undefined) {
    const converted = prepare(predictionsText)
    const wrote = await input.ssh(
      `cat > ${input.paths.boxGradePredictions} <<'QUANTA_PROMAX_PREDS_EOF'\n${converted}\nQUANTA_PROMAX_PREDS_EOF`,
    )
    if (wrote.code !== 0) {
      throw new Error(
        `[full-remote] ${input.family}: could not write the converted predictions to ` +
          `${input.paths.boxGradePredictions} (code ${wrote.code}): ${wrote.stderr || wrote.stdout}`,
      )
    }
    gradedPredictionsPath = input.paths.boxGradePredictions
  }

  return gradedPredictionsPath
}

/**
 * What a completed on-box grade OBSERVED, as a receipt needs it.
 *
 * `argv` and `cwd` come from the family's own command builder rather than from
 * splitting the rendered shell string: a receipt has to name the invocation that
 * produced its verdicts, and re-deriving argv from quoting would be a guess.
 *
 * `evaluatorSha256` is the family's frozen pin — and it is only reported because
 * the grader phase HASH-VERIFIED it on the box moments earlier, refusing the
 * whole bootstrap on a mismatch. Reporting it without that check would be a
 * receipt citing a guard that never ran.
 */
export interface FamilyBoxGradeObservation {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly evaluatorSha256: string
  /**
   * Which image each assigned instance was graded against, pinned by DIGEST.
   *
   * Captured INSIDE the window — the names come from the checkout's own golden,
   * which only exists there. Empty when the family declares no capture; a
   * capture that FAULTS fails the grade rather than shipping a receipt that
   * cannot say what it ran against.
   */
  readonly images: readonly { instanceId: string; imageName: string; repoDigest: string }[]
}

/**
 * Ask the box which images the grade ran against, and refuse a grade that cannot
 * say. A family with no assigned ids to reconcile against reports none.
 */
const captureImageProvenance = async (
  input: FamilyBoxGradeInput,
  checkoutRoot: string,
): Promise<readonly { instanceId: string; imageName: string; repoDigest: string }[]> => {
  const assigned = input.assignedInstanceIds ?? []
  if (assigned.length === 0) return []
  // UPLOAD the program over ssh stdin rather than embedding it in a command.
  // The embedded form was quoted with `JSON.stringify`, which is not a shell
  // quoter: the source arrived as one line with literal `\n` and Python raised a
  // SyntaxError while the pipeline still exited 0. Shipping it as a file is the
  // idiom this repo already uses for the swebench shim, and it leaves no
  // embedded-quoting question to get wrong.
  const wroteScript = await input.ssh(
    `cat > ${PROMAX_IMAGE_PROVENANCE_SCRIPT_PATH}`,
    PROMAX_IMAGE_PROVENANCE_SCRIPT,
  )
  if (wroteScript.code === 255) {
    throw new Error(
      `[full-remote] ${input.family}: the box became unreachable while uploading the ` +
        "image-provenance program. REFUSING to report that as an image fault.",
    )
  }
  if (wroteScript.code !== 0) {
    throw new Error(
      `[full-remote] ${input.family}: could not write the image-provenance program to ` +
        `${PROMAX_IMAGE_PROVENANCE_SCRIPT_PATH} (code ${wroteScript.code}): ` +
        `${wroteScript.stderr || wroteScript.stdout}`,
    )
  }
  const command = buildProMaxImageProvenanceCommand({
    checkoutRoot,
    venvPython: `${checkoutRoot.replace(/\/upstream$/, "")}/venv/bin/python`,
    scriptPath: PROMAX_IMAGE_PROVENANCE_SCRIPT_PATH,
    instanceIds: assigned,
  })
  const answered = await input.ssh(command)
  // Same rule as every other probe: a dropped connection is a NETWORK event, and
  // reporting it as "the box reported no image for it at all" would misfile it —
  // the sibling transport module warns about exactly this collapse.
  if (answered.code === 255) {
    throw new Error(
      `[full-remote] ${input.family}: the box became unreachable while recording which images ` +
        `the grade ran against. REFUSING to report that as an image fault. ` +
        `(${answered.stderr.trim() || "ssh exit 255"})`,
    )
  }
  // A program that could not RUN is not "the box reported no image". Reading a
  // non-zero exit's empty stdout as data misfiles a completed, paid grade as an
  // image fault — the same collapse the quoting fix removed one cause of, left
  // standing in its structural form.
  if (answered.code !== 0) {
    throw new Error(
      `[full-remote] ${input.family}: the image-provenance program failed on the box ` +
        `(exit ${answered.code}): ${answered.stderr.trim() || answered.stdout.trim() || "no output"}. ` +
        "REFUSING to report that as an image fault — the grade itself already succeeded.",
    )
  }
  const parsed = parseProMaxImageProvenance(answered.stdout, assigned)
  if (!parsed.ok) {
    throw new Error(
      `[full-remote] ${input.family}: could not record which images the grade ran against — ` +
        `REFUSING to report a result whose images cannot be pinned. ${parsed.faults.join("; ")}`,
    )
  }
  return parsed.images
}

export interface FamilyBoxGradeResult {
  readonly artifactText: string
  readonly observation: FamilyBoxGradeObservation
}

export const runFamilyBoxGrade = async (
  input: FamilyBoxGradeInput,
): Promise<FamilyBoxGradeResult | undefined> => {
  const profile = resolveDatasetFamilyProfile(input.family)
  const boxGrade = profile.boxGrade
  if (boxGrade === undefined) return undefined

  if (input.bootstrap === undefined) {
    // A family that grades in its grader phase MUST carry that phase's commands.
    // Without them the checkout and venv this command needs were never created,
    // and the grade would fail in a way that reads like an evaluator bug.
    throw new Error(
      `[full-remote] dataset-family=${input.family} grades in its own grader phase but the ` +
        "chunk carried NO declared bootstrap — the pinned checkout and venv its evaluator " +
        "needs were never materialized. REFUSING rather than running a grade that cannot work.",
    )
  }
  const bootstrap = input.bootstrap

  // Chunk paths are `~/…` / `$HOME/…` because they are interpolated UNQUOTED
  // into the bench command, where the shell expands them. This command quotes
  // every token (it runs a campaign path on a box that is holding the answer
  // key), and neither `~` nor `$HOME` expands inside quotes — so they are
  // resolved to real absolute paths HERE, once, before the command is built.
  //
  // That is also what the invocation builder demands, and rightly: a
  // cwd-relative path cannot be replayed from a receipt. This is the one place
  // that knows the box's home, so it is the one place that can honour both.
  await assertNoLiveBenchProcess(input)

  const predictionsText = await readGradablePredictions(input)
  if (predictionsText === undefined) return undefined

  const home = await resolveBoxHome(input.ssh)

  const gradedPredictionsPath = await materializeGradedPredictions(
    input,
    profile.prepareBoxGradePredictions,
    predictionsText,
  )

  const invocation = boxGrade({
    predictionsPath: absolutizeOnBox(gradedPredictionsPath, home),
    outputPath: absolutizeOnBox(input.paths.passRate, home),
  })

  let artifact = ""
  let observation: FamilyBoxGradeObservation | undefined
  input.log(
    `[full-remote] ${input.family}: grading on box with its own pinned evaluator ` +
      "(inside the grader window; the answer key is torn down straight after)…",
  )
  await executeFamilyRemoteBootstrap({
    bootstrap: input.bootstrap,
    phase: "grader",
    ssh: input.ssh,
    log: input.log,
    whileMaterialized: async () => {
      const graded = await input.ssh(invocation.command)
      // The GRADE's own verdict first. Capturing provenance ahead of this made a
      // failed evaluator surface as an image fault — the wrong diagnosis for the
      // wrong subsystem, in the message an operator reads first.
      if (graded.code !== 0) {
        throw new Error(
          `[full-remote] ${input.family} on-box grade failed (code ${graded.code}): ` +
            `${graded.stderr || graded.stdout}`,
        )
      }
      // WHICH IMAGES. Asked here, inside the window: the names live in the
      // checkout's golden, which the teardown is about to remove. A tag is not
      // provenance, so this asks the daemon that actually ran them for digests.
      const provenance = await captureImageProvenance(input, invocation.cwd)

      observation = {
        images: provenance,
        argv: invocation.argv,
        cwd: invocation.cwd,
        exitCode: graded.code,
        stdout: graded.stdout,
        stderr: graded.stderr,
        // The grader phase refused unless the box reported this digest for the
        // evaluator, so it is an OBSERVED identity, not a hopeful constant.
        evaluatorSha256: verifiedEvaluatorSha256(bootstrap),
      }
      // Read it back HERE — still inside the window, still under this call's
      // teardown guarantee.
      const read = await input.ssh(`cat ${input.paths.passRate}`)
      if (read.code !== 0) {
        throw new Error(
          `[full-remote] ${input.family} produced no readable grade artifact at ` +
            `${input.paths.passRate} (code ${read.code}): ${read.stderr || read.stdout}`,
        )
      }
      artifact = read.stdout
      // Remove the on-box copy now that it is in hand. It is a per-instance
      // oracle at a predictable path, and the run-scoped scrub only ever clears
      // the CURRENT chunk's paths — it cannot reach an earlier chunk's, so a
      // later chunk's unsandboxed agent would otherwise share a box with it.
      // Best-effort: the grade itself already succeeded, and failing the run over
      // a cleanup would discard a real result. A leftover is caught by the next
      // chunk's absence probe on the paths that carry the answer key itself.
      const swept = await input.ssh(`rm -f ${input.paths.passRate}`)
      if (swept.code !== 0) {
        input.log(
          `[full-remote] ⚠️ ${input.family}: could not remove the on-box grade document at ` +
            `${input.paths.passRate} (code ${swept.code}) — it stays readable to a later chunk's agent.`,
        )
      }
    },
  })
  if (observation === undefined) {
    throw new Error(
      `[full-remote] ${input.family}: the grade completed without recording its own invocation — ` +
        "refusing to report a result whose receipt could not name what produced it.",
    )
  }
  return { artifactText: artifact, observation }
}

/**
 * The evaluator digest the family's GRADER phase declared and the box confirmed.
 *
 * Read off the declared plan rather than re-hashed here: the executor already
 * compared it against the box's own `sha256sum` output and refused the bootstrap
 * on a mismatch, so this is the value that was proven — and it cannot drift from
 * the one that was checked, because it is the same field.
 */
const verifiedEvaluatorSha256 = (bootstrap: FamilyRemoteBootstrap): string => {
  for (const command of bootstrap.commands) {
    const expectation = command.verifies
    if (expectation?.path.endsWith("test_run.py") === true) {
      return expectation.sha256
    }
  }
  throw new Error(
    "[full-remote] the family's grader phase declares no evaluator digest to verify — a grade " +
      "whose receipt cannot name the bytes that produced it is not evidence.",
  )
}

/**
 * Project a family's grade artifact into the chunk's verdict sets.
 *
 * A family that declares `boxGrade` must also declare this: without it there is
 * no honest verdict source at all, because its bench report was written by a
 * patch-gen-only pass in which every instance is an explicit "harness not wired"
 * infra error.
 */
export const parseFamilyBoxGradeVerdicts = (
  family: DatasetFamily,
  artifactText: string,
): FamilyBoxGradeVerdicts => {
  const parse = resolveDatasetFamilyProfile(family).parseBoxGradeVerdicts
  if (parse === undefined) {
    throw new Error(
      `[full-remote] dataset-family=${family} declares an on-box grade but no ` +
        "`parseBoxGradeVerdicts` — its verdicts have no source, since its own bench report is " +
        "a patch-gen-only pass in which every instance is an infra error by construction.",
    )
  }
  // Returned as-is: this module TRANSPORTS the verdicts, it does not decide
  // which bucket a row belongs in. Re-spelling the four names here would make it
  // a second place they are written down, which is what the campaign's
  // `legacy_verdict_consumer` audit exists to prevent.
  return parse(artifactText)
}
