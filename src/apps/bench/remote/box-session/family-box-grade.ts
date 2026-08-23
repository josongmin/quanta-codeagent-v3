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
export const runFamilyBoxGrade = async (
  input: FamilyBoxGradeInput,
): Promise<string | undefined> => {
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

  // Chunk paths are `~/…` / `$HOME/…` because they are interpolated UNQUOTED
  // into the bench command, where the shell expands them. This command quotes
  // every token (it runs a campaign path on a box that is holding the answer
  // key), and neither `~` nor `$HOME` expands inside quotes — so they are
  // resolved to real absolute paths HERE, once, before the command is built.
  //
  // That is also what the invocation builder demands, and rightly: a
  // cwd-relative path cannot be replayed from a receipt. This is the one place
  // that knows the box's home, so it is the one place that can honour both.
  const home = await resolveBoxHome(input.ssh)
  const command = boxGrade({
    predictionsPath: absolutizeOnBox(input.paths.preds, home),
    outputPath: absolutizeOnBox(input.paths.passRate, home),
  })

  let artifact = ""
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
      const graded = await input.ssh(command)
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
    },
  })
  return artifact
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
