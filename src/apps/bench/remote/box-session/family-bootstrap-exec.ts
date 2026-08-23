/**
 * LEAF — EXECUTE a family's declared REMOTE BOOTSTRAP on a box, FOR ONE PHASE.
 *
 * ## 🔴 READ FIRST — WHICH of these clauses is LIVE today
 *
 * Everything below is implemented, tested and fail-closed. Only part of it is
 * currently REACHED, and the distinction matters because a receipt must not cite
 * a guard that never runs:
 *
 *   • the AGENT phase (its gold-bearing cross-check, and the absence probe it
 *     demands) HAS a production caller — `family-box-setup.ts`, which is the
 *     ONLY non-test call site of {@link executeFamilyRemoteBootstrap} and passes
 *     `phase: "agent"`. It is nonetheless reached by NO SHIPPED FAMILY today,
 *     because ProMax is the only family declaring a bootstrap and its `admitBox`
 *     refuses the lane (PMX-04);
 *   • the GRADER phase and the TEARDOWN bound to it have NO production caller AT
 *     ALL. Nothing under `src/` invokes this function with `phase: "grader"`.
 *
 * So the answer-key lifecycle described below is PRODUCTION-INERT, not a live
 * defence. That is safe rather than leaky — the grader phase is the only thing
 * that materializes gold, and a phase nobody executes materializes nothing — but
 * it is not what the previous version of this comment implied.
 *
 * The claim is DATA, not prose: `profiles/bootstrap-phase-wiring.ts` declares
 * which phases have production callers, {@link assertFamilyBootstrapPhaseWiringInSync}
 * re-checks it on this function's default path, the operator sees it on every
 * `--dry-run` plan, and `promax-bootstrap-phase-reachability.test.ts` refuses to
 * let a shipped family start ADMITTING boxes while its teardown is still
 * unreachable.
 *
 * PMX-04 split the question in two on purpose:
 *
 *   • WHAT a box must become — which commit, which interpreter, which hashes,
 *     in which order — belongs to the family's own owner module and arrives here
 *     as DATA ({@link FamilyRemoteBootstrap}, an ordered argv list);
 *   • RUNNING it on a box is transport, and transport is `remote/**`'s job.
 *
 * This file is the second half, and it is deliberately incapable of the first:
 * it never reads a family name, never inspects a step label, and never derives a
 * command. Packet invariant 10 (`box-session.ts` / `ec2-lifecycle.ts` grow no
 * family branch) therefore holds structurally — the ONLY thing a new family adds
 * is its own profile leaf.
 *
 * ## 🔴 PHASE is a hard gate, not a label
 *
 * Invariant 3 forbids the answer key (gold patch, test patch, eval script,
 * golden output, derived image receipts) from existing anywhere the agent can
 * reach. On a bench box the agent's `bash` tool is unsandboxed, so "anywhere the
 * agent can reach" means "anywhere on the box during the agent phase" — a
 * quanta-owned path outside `$HOME` is a filename, not a boundary.
 *
 * So the caller must name the phase it is bootstrapping, and:
 *
 *   1. only commands declared for THAT phase are executed;
 *   2. if any of them is `goldBearing` while the phase is `agent`, the whole
 *      bootstrap is REFUSED before a single ssh round trip. That cross-check is
 *      what makes a mislabelled command fail closed instead of leaking: `phase`
 *      is what a family INTENDS, `goldBearing` is what the command DOES, and a
 *      disagreement between the two is exactly the regression shape that put a
 *      gold-bearing checkout on an agent box in the first place.
 *
 * ## The digest expectation is compared HERE
 *
 * A command may declare `verifies` — the sha256 its output must report for an
 * on-box path. That comparison runs in this executor. It used to live only in a
 * pure classifier no wired caller invoked, which meant the box executed argv
 * with nothing checking the observed digest while the receipt cited the check as
 * its guard. A gate that cannot fail is worse than no gate, because it is cited
 * as evidence.
 *
 * FAIL-CLOSED and ORDERED. Commands run strictly in the declared order and the
 * first non-zero exit — or the first digest mismatch, or the first output that
 * reports NO digest at all — aborts, because a bootstrap is a sequence of
 * preconditions: hashing a file that was never checked out, or launching an
 * evaluator whose interpreter failed to build, produces a confidently wrong
 * campaign rather than an honest failure. The refusal names the step, the argv
 * and the box's own output, so an operator does not need to ssh in to find out
 * what broke.
 *
 * `undefined` spec ⇒ NOT ONE ssh round trip. That is what keeps every family
 * without a remote bootstrap (verified / live / pro) byte-identical.
 */
import { errMessage } from "@/shared"
import {
  assertFamilyBootstrapPhaseWiringInSync,
  bootstrapMaterializesGold,
} from "../../profiles/bootstrap-phase-wiring"
import {
  describePythonFloorRefusal,
  meetsPythonFloor,
  parsePythonVersion,
} from "../../profiles/python-version"
import type {
  FamilyBootstrapCommand,
  FamilyBootstrapPhase,
  FamilyRemoteBootstrap,
} from "../../profiles/types"
import type { SpawnResult } from "../backend"
import { shq } from "./shell"

/** Render one argv as a single-quoted bash command string. argv is the contract;
 *  the quoting exists only because the ssh transport carries a STRING. Nothing
 *  in a family's argv can therefore reach the box's shell as syntax. */
export const renderBootstrapCommand = (command: FamilyBootstrapCommand): string =>
  command.argv.map(shq).join(" ")

export class FamilyBootstrapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FamilyBootstrapError"
  }
}

export interface FamilyBootstrapExecInput {
  /** The family's declared bootstrap, or `undefined` for a family with none. */
  readonly bootstrap: FamilyRemoteBootstrap | undefined
  /** WHICH phase is being bootstrapped. Required — there is no default, because
   *  a default would decide the answer-key question by omission. */
  readonly phase: FamilyBootstrapPhase
  readonly ssh: (cmd: string) => Promise<SpawnResult>
  readonly log: (m: string) => void
  /**
   * Work to run WHILE the grader phase's materialized state exists — i.e. the
   * grade itself. Runs after the grader commands and before the teardown.
   * Ignored for every other phase, because the window it names exists only here.
   *
   * A callback rather than exported `materialize()` / `teardown()` halves that a
   * caller sequences: this module's rule is that a teardown with its own call
   * site is a teardown that gets forgotten, which is exactly how the checkout
   * survived into the next chunk. With the work INSIDE the call there is no code
   * path that materializes the answer key and does not remove it.
   *
   * A throw here is treated exactly like a grader-command failure: the teardown
   * still runs, and this error wins over a teardown error because it carries the
   * diagnosis.
   */
  readonly whileMaterialized?: () => Promise<void>
}

/** A well-formed sha256 as `sha256sum`/`shasum -a 256` print it: the digest is
 *  the first token, the path follows. Anchored to 64 hex so a truncated or
 *  error-laden line cannot be mistaken for a digest. */
const SHA256_IN_OUTPUT = /\b([0-9a-f]{64})\b/

/**
 * Compare a command's declared digest expectation against what the box actually
 * reported. Returns an operator-facing problem string, or `undefined` when the
 * command declares no expectation or the observed digest matches.
 *
 * Pure, and exported so the comparison is testable without a box.
 */
export const classifyBootstrapDigest = (
  command: FamilyBootstrapCommand,
  observedOutput: string,
): string | undefined => {
  const expectation = command.verifies
  if (expectation === undefined) return undefined
  const match = SHA256_IN_OUTPUT.exec(observedOutput)
  if (match === null) {
    return (
      `step "${command.step}" reported NO sha256 for ${expectation.absolutePath}. ` +
      "An UNVERIFIED upstream file may not be graded against — refusing rather than " +
      `skipping the check (expected ${expectation.sha256}).`
    )
  }
  const observed = match[1]
  if (observed === expectation.sha256) return undefined
  return (
    `step "${command.step}": ${expectation.path} hashes to ${observed} on-box, not the frozen ` +
    `${expectation.sha256} (${expectation.absolutePath}).`
  )
}

/**
 * Compare a command's declared INTERPRETER FLOOR against the version the box
 * reported. Returns an operator-facing problem string, or `undefined` when the
 * command declares no floor or the box satisfies it.
 *
 * Same posture as {@link classifyBootstrapDigest}, for the same reason: an
 * output that reports NO version is a REFUSAL, not a skipped check. A box whose
 * interpreter cannot be identified is a box whose grading run would fail much
 * later and much less legibly.
 *
 * Pure, and exported so the comparison is testable without a box.
 */
export const classifyBootstrapPythonFloor = (
  command: FamilyBootstrapCommand,
  observedOutput: string,
): string | undefined => {
  const floor = command.pythonFloor
  if (floor === undefined) return undefined
  const observed = parsePythonVersion(observedOutput)
  if (observed !== null && meetsPythonFloor(observed, floor.minimum)) return undefined
  return `step "${command.step}": ${describePythonFloorRefusal({
    label: "interpreter",
    // argv[0] IS the interpreter being probed — the plan builds these commands
    // as `[<python>, "--version"]`.
    executable: command.argv[0] ?? "(no executable in argv)",
    observed,
    floor,
  })}`
}

/**
 * Select the commands that belong to `phase`, refusing outright if any of them
 * is gold-bearing while the phase is `agent`.
 *
 * Pure and exported: the absence claim ("no gold-bearing path exists on the box
 * during the agent phase") is decided HERE, so it can be proven without a box.
 */
export const selectBootstrapCommandsForPhase = (
  bootstrap: FamilyRemoteBootstrap,
  phase: FamilyBootstrapPhase,
): readonly FamilyBootstrapCommand[] => {
  const selected = bootstrap.commands.filter((command) => command.phase === phase)
  if (phase === "grader") {
    assertGoldIsTornDown(bootstrap)
    return selected
  }
  if (phase !== "agent") return selected
  const leaking = selected.filter((command) => command.goldBearing)
  if (leaking.length > 0) {
    throw new FamilyBootstrapError(
      `[full-remote] ${bootstrap.family} bootstrap REFUSED: ${leaking.length} command(s) are ` +
        `declared phase="agent" but are GOLD-BEARING — ` +
        `${leaking.map((c) => `"${c.step}"`).join(", ")}. The agent's shell is unsandboxed on a ` +
        "bench box, so answer-key bytes present during the agent phase are reachable regardless " +
        "of path (invariant 3). Gold-bearing work belongs to the GRADER phase.",
    )
  }
  assertAbsenceIsProven(bootstrap, selected)
  return selected
}

/** Does this bootstrap put answer-key bytes on the box at all? Families that
 *  never do are untouched by the two lifecycle clauses below.
 *
 *  Defined in `profiles/bootstrap-phase-wiring.ts` rather than here so the gate
 *  and the operator-facing dry-run note cannot drift into two different
 *  meanings of "materializes gold". */
const materializesGold = bootstrapMaterializesGold

/**
 * A family that MATERIALIZES gold must declare its REMOVAL.
 *
 * The regression this closes is not "the teardown ran late", it is that there
 * was no teardown at all: the grader phase created a gold-bearing checkout and
 * nothing removed it, so the box carried the answer key into the next chunk. A
 * plan that can create gold but not destroy it is refused BEFORE the first
 * fetch, because after the fetch the only remedy is a box that must be thrown
 * away.
 */
const assertGoldIsTornDown = (bootstrap: FamilyRemoteBootstrap): void => {
  if (!materializesGold(bootstrap)) return
  if (bootstrap.commands.some((command) => command.phase === "teardown")) return
  throw new FamilyBootstrapError(
    `[full-remote] ${bootstrap.family} GRADER bootstrap REFUSED: it declares gold-bearing ` +
      'command(s) but NO phase="teardown" command. Materializing the answer key on a box with ' +
      "no declared removal leaves it there for the next chunk's AGENT phase, which is the leak " +
      "invariant 3 forbids. Declare the teardown — the executor runs it for you.",
  )
}

/**
 * A family that materializes gold must PROVE its absence before the agent runs.
 *
 * Teardown and probe are deliberately two gates, not one: a teardown that
 * silently failed (a full disk, a killed ssh, a box reused from a campaign that
 * crashed mid-grade) leaves gold behind, and the only way to notice is to look.
 * Absence must be established, not assumed.
 */
const assertAbsenceIsProven = (
  bootstrap: FamilyRemoteBootstrap,
  agentCommands: readonly FamilyBootstrapCommand[],
): void => {
  if (!materializesGold(bootstrap)) return
  if (agentCommands.some((command) => command.absenceProbe !== undefined)) return
  throw new FamilyBootstrapError(
    `[full-remote] ${bootstrap.family} AGENT bootstrap REFUSED: the family materializes ` +
      "answer-key bytes in its grader phase but declares NO agent-phase absence probe, so " +
      '"the box is clean" would be an assumption. Declare a probe (`absenceProbe`) that exits ' +
      "non-zero when the gold-bearing path exists.",
  )
}

/**
 * Run the declared bootstrap FOR ONE PHASE. Returns the number of commands
 * executed — `0` for a family that declares none (and for a phase a family
 * declares nothing in), which is the byte-identical control every other lane
 * relies on.
 */
export const executeFamilyRemoteBootstrap = async (
  input: FamilyBootstrapExecInput,
): Promise<number> => {
  // 🔴 The reachability TABLE this module's docs now rest on (which phases a
  // production caller actually executes) is re-checked HERE, on the default
  // path, for every family and every phase — before the `undefined` early
  // return, so it is not gated on a family happening to declare a bootstrap.
  // Pure: it issues no command, so a family without a bootstrap is still
  // byte-identical.
  assertFamilyBootstrapPhaseWiringInSync()
  const bootstrap = input.bootstrap
  if (bootstrap === undefined) return 0
  // The grader phase MATERIALIZES the answer key, so its teardown is bound to
  // THIS call rather than being a step a caller has to remember. A teardown with
  // its own call site is a teardown that gets forgotten — which is exactly how
  // the checkout survived into the next chunk.
  if (input.phase !== "grader") return runBootstrapPhase(bootstrap, input.phase, input)
  let graderError: unknown
  let ran = 0
  try {
    ran = await runBootstrapPhase(bootstrap, "grader", input)
    // THE GRADING WINDOW. The grader commands materialize the answer key; they
    // do not use it. Whatever does — the pinned evaluator — runs here, inside the
    // same call, so the teardown below covers it too. A throw is deliberately
    // NOT distinguished from a grader-command failure: both leave the key on the
    // box, and both are a reason to tear down rather than to skip it.
    if (input.whileMaterialized !== undefined) await input.whileMaterialized()
  } catch (err) {
    graderError = err
  }
  // ALWAYS — a grader phase that died half-way is precisely when gold is left
  // behind, so a failure is a reason to tear down, not a reason to skip it.
  const teardown = await runTeardownPhase(bootstrap, input)
  if (graderError !== undefined) {
    // The GRADER error wins (same keystone as `resolveChunkOutcome`): it carries
    // the diagnosis. A teardown failure underneath it is logged loudly rather
    // than swallowed, and the next chunk's absence probe is what stops the run.
    if (teardown.error !== undefined) input.log(teardownFailureNote(bootstrap, teardown.error))
    throw graderError
  }
  if (teardown.error !== undefined) throw teardown.error
  return ran + teardown.ran
}

const teardownFailureNote = (bootstrap: FamilyRemoteBootstrap, err: unknown): string =>
  `[full-remote] ⚠️ ${bootstrap.family} TEARDOWN also failed — the box may still carry ` +
  `answer-key bytes; it must not be reused for an agent phase: ${errMessage(err)}`

/** Run the declared teardown, capturing rather than throwing so the caller can
 *  decide which error wins. */
const runTeardownPhase = async (
  bootstrap: FamilyRemoteBootstrap,
  input: FamilyBootstrapExecInput,
): Promise<{ ran: number; error?: unknown }> => {
  try {
    return { ran: await runBootstrapPhase(bootstrap, "teardown", input) }
  } catch (err) {
    return { ran: 0, error: err }
  }
}

/** Execute exactly the commands declared for ONE phase, in order, fail-closed. */
const runBootstrapPhase = async (
  bootstrap: FamilyRemoteBootstrap,
  phase: FamilyBootstrapPhase,
  input: FamilyBootstrapExecInput,
): Promise<number> => {
  // Refuses BEFORE any ssh, so a mislabelled gold command never reaches the box.
  const commands = selectBootstrapCommandsForPhase(bootstrap, phase)
  if (commands.length === 0) return 0
  input.log(
    `[full-remote] ${bootstrap.family}: running ${commands.length} declared ${phase}-phase ` +
      `bootstrap command(s) (grader workers=${bootstrap.graderWorkers})…`,
  )
  let ran = 0
  for (const command of commands) {
    const rendered = renderBootstrapCommand(command)
    const result = await input.ssh(rendered)
    ran += 1
    if (result.code !== 0) {
      throw new FamilyBootstrapError(classifyNonZeroExit(bootstrap, command, rendered, result))
    }
    const output = `${result.stdout}${result.stderr}`
    const problem =
      classifyBootstrapDigest(command, output) ?? classifyBootstrapPythonFloor(command, output)
    if (problem !== undefined) {
      throw new FamilyBootstrapError(
        `[full-remote] ${bootstrap.family} bootstrap VERIFICATION FAILED — ${problem}\n` +
          `  command: ${rendered}\n` +
          `  purpose: ${command.purpose}`,
      )
    }
  }
  return ran
}

/**
 * A failed ABSENCE PROBE is not a broken step — it is the leak. Classify it as
 * such, naming the path that exists, because "step gold-absence FAILED (exit 1)"
 * reads like flaky infrastructure and this is the one failure an operator must
 * never retry past.
 */
const classifyNonZeroExit = (
  bootstrap: FamilyRemoteBootstrap,
  command: FamilyBootstrapCommand,
  rendered: string,
  result: SpawnResult,
): string => {
  const probe = command.absenceProbe
  if (probe !== undefined) {
    return (
      `[full-remote] ${bootstrap.family} bootstrap REFUSED — ANSWER KEY PRESENT: ` +
      `${probe.absolutePath} EXISTS on this box at AGENT time (probe "${command.step}" exited ` +
      `${result.code}). A prior chunk's grader phase left it behind, or its teardown failed. ` +
      "The agent's shell is unsandboxed on a bench box, so running here would grade against a " +
      "box that holds the gold and test patches. Remove the tree, or launch a fresh box."
    )
  }
  return (
    `[full-remote] ${bootstrap.family} bootstrap step "${command.step}" FAILED ` +
    `(exit ${result.code}): ${rendered}\n` +
    `  purpose: ${command.purpose}\n` +
    `${result.stdout}${result.stderr}`
  )
}
