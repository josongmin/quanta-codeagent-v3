/**
 * CHUNK ARTIFACT TRANSPORT — pull a finished chunk's evidence off the box before
 * it dies, and save it where a post-mortem can find it.
 *
 * Split out of `box-session.ts` when that module crossed the god-module line.
 * The cut is along a real seam: everything here is FETCH-AND-SAVE. It decides no
 * verdict, drives no phase, and owns no lifecycle — it moves bytes from a box to
 * `fullRemoteArtifactDir()` and reports what it could not find.
 *
 * Why it is worth its own file: a box is DESTROYED at end of run, so an artifact
 * not fetched here is an artifact investigated by live ssh-babysitting, or lost.
 * That is why the run.log fetch is unconditional rather than gated on
 * `recordTrajectory`, and why an absent artifact is logged rather than thrown —
 * a failed fetch must not discard the result that was already earned.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { mirrorReportToSsot } from "@/runner/batch/report"
import { benchHome } from "../../corpus"
import type { DatasetFamily } from "../../dataset-family-token"
import { resolveDatasetFamilyProfile } from "../../profiles/registry"
import type { SpawnResult } from "../backend"
import { closureDiagnosticsPathFor, trajectoriesDirFor } from "./chunk-scrub"
import { shq } from "./shell"
import { normalizeStatusText } from "./snapshot"
import type { BoxSession, ChunkPaths } from "./types"
import { detectRateLimit } from "./verdict-parse"

/** Durable dir for fetched full-remote artifacts. NEVER /tmp — the OS reaps it on
 *  the next session and silently destroys the only post-mortem signal (jun-19:
 *  lost the patches needed to RCA a grading false-negative). */
export const fullRemoteArtifactDir = (): string => {
  const dir = join(benchHome(), "full-remote")
  mkdirSync(dir, { recursive: true })
  return dir
}

const fetchRemoteFile = async (ssh: BoxSession["ssh"], remotePath: string): Promise<SpawnResult> =>
  await ssh(`cat ${remotePath} 2>/dev/null`)

const fetchRemoteCommand = async (ssh: BoxSession["ssh"], command: string): Promise<SpawnResult> =>
  await ssh(command)

export const saveLocalArtifact = (
  localPath: string,
  content: string,
  log: (msg: string) => void,
  label: string,
): string | undefined => {
  if (content.trim() === "") return undefined
  try {
    writeFileSync(localPath, content)
    log(`${label}: ${localPath}`)
    return localPath
  } catch {
    return undefined
  }
}

const fetchOptionalArtifact = async (args: {
  ssh: BoxSession["ssh"]
  remotePath: string
  localPath: string
  log: (msg: string) => void
  label: string
}): Promise<string | undefined> => {
  try {
    const fetched = await fetchRemoteFile(args.ssh, args.remotePath)
    if (fetched.code !== 0) return undefined
    return saveLocalArtifact(args.localPath, fetched.stdout, args.log, args.label)
  } catch {
    return undefined
  }
}

const fetchOptionalCommandArtifact = async (args: {
  ssh: BoxSession["ssh"]
  command: string
  localPath: string
  log: (msg: string) => void
  label: string
}): Promise<string | undefined> => {
  try {
    const fetched = await fetchRemoteCommand(args.ssh, args.command)
    if (fetched.code !== 0 || fetched.stdout.length === 0) return undefined
    return saveLocalArtifact(args.localPath, fetched.stdout, args.log, args.label)
  } catch {
    return undefined
  }
}

/**
 * Fetch the box's PER-INSTANCE trajectory cassettes (one FILE per instance run,
 * SWE-agent shape) + their `.meta.json` sidecars, and extract them into a
 * per-box subdir under the local full-remote artifact dir:
 *   `<artifactDir>/trajectories/<suffix>/<ts>-<instanceId>.jsonl`
 *
 * One `tar | base64` round-trip (mirrors the observe archive), then a local
 * `base64 -d | tar -x`. Best-effort: any failure (no dir, empty run, no local
 * tar) logs nothing fatal and leaves the run untouched. The per-box subdir keeps
 * two boxes that re-ran the same instance from colliding, and the viewer's
 * folder scan turns each extracted file into one session.
 */
const fetchTrajectoryFiles = async (args: {
  ssh: BoxSession["ssh"]
  paths: ChunkPaths
  artifactSuffix: string
  log: (msg: string) => void
}): Promise<void> => {
  const trajDir = trajectoriesDirFor(args.paths)
  const b64Path = join(fullRemoteArtifactDir(), `trajectories-${args.artifactSuffix}.tar.b64`)
  const saved = await fetchOptionalCommandArtifact({
    ssh: args.ssh,
    // Only the .jsonl cassettes + .meta.json sidecars; skip if the dir is absent
    // or empty so `fetchOptionalCommandArtifact` treats it as "nothing to fetch".
    command: `if [ -d ${trajDir} ] && [ -n "$(ls -A ${trajDir} 2>/dev/null)" ]; then tar -C ${trajDir} -cf - . | base64 -w0; fi`,
    localPath: b64Path,
    log: args.log,
    label: "[full-remote] trajectory cassettes archived",
  })
  if (saved === undefined) return
  // Extract locally into a per-box subdir. Best-effort: never let a missing
  // local `tar`/`base64` or a corrupt archive crash the post-run fetch.
  try {
    const dest = join(fullRemoteArtifactDir(), "trajectories", args.artifactSuffix)
    mkdirSync(dest, { recursive: true })
    execFileSync("bash", ["-c", `base64 -d < ${shq(b64Path)} | tar -x -C ${shq(dest)}`], {
      stdio: "ignore",
    })
    // Extract succeeded ⇒ the per-instance .jsonl files are the artifact; drop the
    // now-redundant archive. (On failure we keep it as the fallback.)
    rmSync(b64Path, { force: true })
    args.log(`[full-remote] trajectory cassettes extracted: ${dest}`)
  } catch {
    // leave the .tar.b64 in place as the fallback artifact
  }
}

export const fetchChunkArtifacts = async (args: {
  ssh: BoxSession["ssh"]
  /** decides whether this report belongs on the SSOT; see `shouldMirrorReportToSsot`. */
  datasetFamily: DatasetFamily
  paths: ChunkPaths
  artifactSuffix: string
  recordTrajectory: boolean
  log: (msg: string) => void
}): Promise<{ reportText: string; reportPath?: string }> => {
  const fetchedReport = await fetchRemoteFile(args.ssh, args.paths.report)
  await fetchOptionalArtifact({
    ssh: args.ssh,
    remotePath: args.paths.preds,
    localPath: join(fullRemoteArtifactDir(), `preds-${args.artifactSuffix}.jsonl`),
    log: args.log,
    label: "[full-remote] predictions saved",
  })
  // ALWAYS pull the operational run.log back before the box is terminated. It
  // holds the only on-box diagnostics — LSP server-exit WARNs (crash/OOM),
  // throttle/429 markers, warm-up exhaustion — and the box is destroyed at
  // end-of-run, so a death NOT fetched here is a death investigated by live
  // ssh-babysitting (or lost entirely). Not gated on `recordTrajectory`: this is
  // the cheap, always-useful failure-forensics artifact, not the heavy cassette.
  await fetchOptionalArtifact({
    ssh: args.ssh,
    remotePath: args.paths.runLog,
    localPath: join(fullRemoteArtifactDir(), `runlog-${args.artifactSuffix}.log`),
    log: args.log,
    label: "[full-remote] run.log saved",
  })
  await fetchOptionalCommandArtifact({
    ssh: args.ssh,
    command: `if [ -d ${args.paths.observeDir} ]; then tar -C ${args.paths.observeDir} -cf - . | base64 -w0; fi`,
    localPath: join(fullRemoteArtifactDir(), `observe-${args.artifactSuffix}.tar.b64`),
    log: args.log,
    label: "[full-remote] observe archive saved",
  })
  await fetchOptionalArtifact({
    ssh: args.ssh,
    remotePath: closureDiagnosticsPathFor(args.paths),
    localPath: join(fullRemoteArtifactDir(), `closure-${args.artifactSuffix}.json`),
    log: args.log,
    label: "[full-remote] closure diagnostics saved",
  })
  if (args.recordTrajectory) {
    await fetchTrajectoryFiles({
      ssh: args.ssh,
      paths: args.paths,
      artifactSuffix: args.artifactSuffix,
      log: args.log,
    })
  }
  const reportPath = saveLocalArtifact(
    join(fullRemoteArtifactDir(), `report-${args.artifactSuffix}.json`),
    fetchedReport.stdout,
    args.log,
    "[full-remote] report saved",
  )
  if (reportPath !== undefined) {
    // Canonical SSOT mirror — same sink as the local batch's writeReport, so
    // full-remote per-box reports also collect in one fixed place. Skipped for a
    // family whose report is a patch-gen-only pass; see the predicate.
    if (shouldMirrorReportToSsot(args.datasetFamily)) {
      await mirrorReportToSsot(reportPath, fetchedReport.stdout)
    } else {
      args.log(
        "[full-remote] report NOT mirrored to the results SSOT — this family grades in its own " +
          "grader phase, so this report is a patch-gen-only pass and its verdicts are not the " +
          "run's result. The grade document and its receipt are saved instead.",
      )
    }
    return {
      reportText: fetchedReport.stdout,
      reportPath,
    }
  }
  return {
    reportText: fetchedReport.stdout,
  }
}

/**
 * Does this family's bench report belong on the canonical leaderboard SSOT?
 *
 * For a family that grades in its OWN grader phase the report is a
 * PATCH-GEN-ONLY pass: the grading shim is off, so every instance in it is an
 * explicit "harness not wired" infra error by construction and its verdicts are
 * discarded (that is what `parseBoxGradeVerdicts` exists for). Mirroring it
 * created a campaign row whose every instance is a measurement hole.
 *
 * Keyed on the PORT, never on a family name — packet invariant 10 — so a future
 * on-box-grading family inherits this without editing transport.
 *
 * The report is still SAVED locally: it is real forensics for the agent phase.
 * It just stops claiming to be a result, when the result is the pass-rate
 * document and the grade receipt saved beside it.
 */
export const shouldMirrorReportToSsot = (family: DatasetFamily): boolean =>
  resolveDatasetFamilyProfile(family).boxGrade === undefined

export const collectRunDiagnostics = async (args: {
  ssh: BoxSession["ssh"]
  runLogPath: string
  latestLogLine: string | undefined
  remoteRunCode: number
  emptyVerdicts: boolean
  log: (msg: string) => void
}): Promise<{ lastLogLine?: string; rateLimited: boolean }> => {
  const tail = await args.ssh(`tail -60 ${args.runLogPath} 2>/dev/null`)
  // #8: the rate-limit signal drives ALL worker backoff. Reading only the last 60
  // lines makes a 429 storm that happened during patch-gen invisible once grading
  // output scrolls past it → no backoff → the next chunk hammers a still-throttled
  // login. Scan the FULL log for throttle markers; the tail is kept ONLY for the
  // human-facing status line. The TS `detectRateLimit` regex stays authoritative —
  // the remote grep merely hauls candidate lines out of the whole file so they
  // survive into the window we re-validate.
  const throttleScan = await args.ssh(
    `grep -aiE 'generation_error|too many requests|rate[ _-]?limit|(http|status)[ /:]*429' ${args.runLogPath} 2>/dev/null | head -20`,
  )
  const lastLogLine = normalizeStatusText(
    tail.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1) ??
      args.latestLogLine ??
      "",
  )
  const rateLimited = detectRateLimit(tail.stdout) || detectRateLimit(throttleScan.stdout)
  if (args.emptyVerdicts) {
    args.log(
      `[full-remote] ⚠️ no verdicts in report (run exit ${args.remoteRunCode}). Box run.log tail:`,
    )
    args.log(tail.stdout || "(run.log empty)")
  }
  if (rateLimited) {
    args.log(
      "[full-remote] ⚠️ rate-limit signal (generation_error / 429) in run log — caller should back off.",
    )
  }
  return {
    ...(lastLogLine !== "" ? { lastLogLine } : {}),
    rateLimited,
  }
}
