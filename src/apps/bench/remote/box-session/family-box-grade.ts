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
import type { DatasetFamily } from "../../dataset-family-token"
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

export interface FamilyBoxGradeInput {
  readonly ssh: BoxSession["ssh"]
  readonly log: (m: string) => void
  readonly family: DatasetFamily
  readonly bootstrap: FamilyRemoteBootstrap | undefined
  readonly paths: ChunkPaths
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
  if (preds.code !== 0 || preds.stdout.trim() === "" || preds.stdout.trim() === "[]") {
    input.log(
      `[full-remote] ${input.family}: patch-gen produced no predictions at ${input.paths.preds} — ` +
        "SKIPPING the on-box grade. The answer key is not materialized for a grade that would " +
        "have nothing to score; every assigned instance is reported as an infra error.",
    )
    return undefined
  }

  const home = await resolveBoxHome(input.ssh)

  // CONVERT the predictions into the format this family's grader reads, if it
  // says it needs one. The bench writes JSONL for every family; ProMax's pinned
  // evaluator does `json.load` and needs a JSON array, and handing it the JSONL
  // yields a parse error — or, for a single row, a dict whose VALUES are read as
  // entries and therefore zero jobs.
  //
  // Written to its own path rather than over `preds`: that file is the run's own
  // artifact and is fetched as evidence, so rewriting it would destroy the bytes
  // the agent actually produced.
  const prepare = profile.prepareBoxGradePredictions
  let gradedPredictionsPath = input.paths.preds
  if (prepare !== undefined) {
    const converted = prepare(preds.stdout)
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
      observation = {
        argv: invocation.argv,
        cwd: invocation.cwd,
        exitCode: graded.code,
        stdout: graded.stdout,
        stderr: graded.stderr,
        // The grader phase refused unless the box reported this digest for the
        // evaluator, so it is an OBSERVED identity, not a hopeful constant.
        evaluatorSha256: verifiedEvaluatorSha256(bootstrap),
      }
      if (graded.code !== 0) {
        throw new Error(
          `[full-remote] ${input.family} on-box grade failed (code ${graded.code}): ` +
            `${graded.stderr || graded.stdout}`,
        )
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
    if (expectation !== undefined && expectation.path.endsWith("test_run.py")) {
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
