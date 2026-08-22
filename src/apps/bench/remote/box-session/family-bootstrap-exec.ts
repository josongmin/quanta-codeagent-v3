/**
 * LEAF — EXECUTE a family's declared REMOTE BOOTSTRAP on a box, FOR ONE PHASE.
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
  return selected
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
  const bootstrap = input.bootstrap
  if (bootstrap === undefined) return 0
  // Refuses BEFORE any ssh, so a mislabelled gold command never reaches the box.
  const commands = selectBootstrapCommandsForPhase(bootstrap, input.phase)
  if (commands.length === 0) return 0
  input.log(
    `[full-remote] ${bootstrap.family}: running ${commands.length} declared ${input.phase}-phase ` +
      `bootstrap command(s) (grader workers=${bootstrap.graderWorkers})…`,
  )
  let ran = 0
  for (const command of commands) {
    const rendered = renderBootstrapCommand(command)
    const result = await input.ssh(rendered)
    ran += 1
    if (result.code !== 0) {
      throw new FamilyBootstrapError(
        `[full-remote] ${bootstrap.family} bootstrap step "${command.step}" FAILED ` +
          `(exit ${result.code}): ${rendered}\n` +
          `  purpose: ${command.purpose}\n` +
          `${result.stdout}${result.stderr}`,
      )
    }
    const digestProblem = classifyBootstrapDigest(command, `${result.stdout}${result.stderr}`)
    if (digestProblem !== undefined) {
      throw new FamilyBootstrapError(
        `[full-remote] ${bootstrap.family} bootstrap VERIFICATION FAILED — ${digestProblem}\n` +
          `  command: ${rendered}\n` +
          `  purpose: ${command.purpose}`,
      )
    }
  }
  return ran
}
