/**
 * Box STATUS-SNAPSHOT + RUNTIME-PROBE + INSPECTION machinery, plus the grade-time
 * snapshot CONTROLLER. Extracted from `box-session.ts`. Two halves of one concern:
 *   - READ side ({@link readBoxSnapshot}, {@link readBoxRuntimeProbe},
 *     {@link resolveSnapshotInspection}, {@link boxRunLogPath}) — what `box ls` /
 *     `inspectBox` use to render operator-visible state.
 *   - WRITE side ({@link createSnapshotController} + its helpers) — what
 *     `gradeChunkOnBox` uses to publish the running → fetching → idle lifecycle.
 * Both share the normalization coercers + the `~/.quanta/bench-box-status.json`
 * path. IO routes through an injected `ssh` (the {@link BoxSession}) so it stays
 * unit-testable offline.
 */

import { basename } from "node:path"
import { errMessage, parseLspGroundingStatus } from "@/shared"
import type { SpawnResult } from "../backend"
import { readDatasetInstanceIds } from "./dataset-preflight"
import {
  BOX_STATUS_PATH,
  BOX_STATUS_TMP_PATH,
  type BoxInspection,
  type BoxRuntimeProbe,
  type BoxSession,
  type BoxStatusSnapshot,
  type ChunkPaths,
  DEFAULT_CHUNK_PATHS,
  type GradeChunkParams,
} from "./types"

/**
 * Reassemble a byte/chunk stream into COMPLETE lines and `emit` each one (blank
 * lines dropped). A trailing partial line (no newline yet) is held in the buffer
 * until its newline arrives — so a line split across two stdout chunks
 * ("Instances comp" + "leted: 1\n") is emitted ONCE, intact, not as fragments.
 * This is what makes the streamed remote-run feed readable instead of garbled.
 */
export const createLineStreamer = (emit: (line: string) => void): ((chunk: string) => void) => {
  let buf = ""
  return (chunk: string) => {
    buf += chunk
    let nl = buf.indexOf("\n")
    while (nl !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim() !== "") emit(line)
      nl = buf.indexOf("\n")
    }
  }
}

export const normalizeStatusText = (s: string): string =>
  s
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E]/g, " ")
    .trim()
    .slice(0, 200)

const workloadLabel = (params: GradeChunkParams): string => {
  if (params.instanceIds !== undefined && params.instanceIds.length === 1)
    return params.instanceIds[0] ?? "1 instance"
  if (params.instanceIds !== undefined && params.instanceIds.length > 1)
    return `${params.instanceIds.length} instances`
  return basename(params.datasetPath)
}

const snapshotMode = (params: GradeChunkParams): "pool" | "full-remote" =>
  params.paths === undefined ? "full-remote" : "pool"

const selectionMeta = (
  params: GradeChunkParams,
): { instanceCount: number; instancePreview?: readonly string[] } => {
  const ids =
    params.instanceIds !== undefined && params.instanceIds.length > 0
      ? [...params.instanceIds]
      : readDatasetInstanceIds(params.datasetPath)
  return {
    instanceCount: ids.length,
    ...(ids.length > 0 ? { instancePreview: ids.slice(0, 3) } : {}),
  }
}

const writeBoxSnapshot = async (
  session: BoxSession,
  snapshot: BoxStatusSnapshot,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  try {
    const out = await session.ssh(
      `mkdir -p ~/.quanta && cat > ${BOX_STATUS_TMP_PATH} && mv ${BOX_STATUS_TMP_PATH} ${BOX_STATUS_PATH}`,
      `${JSON.stringify(snapshot)}\n`,
    )
    if (out.code !== 0) {
      return {
        ok: false,
        error: `exit ${out.code}: ${(out.stderr || out.stdout || "no output").trim()}`,
      }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errMessage(err) }
  }
}

const asSnapshotPhase = (value: unknown): BoxStatusSnapshot["phase"] | undefined =>
  value === "running" || value === "fetching" || value === "idle" ? value : undefined

const asSnapshotMode = (value: unknown): BoxStatusSnapshot["mode"] | undefined =>
  value === "pool" || value === "full-remote" ? value : undefined

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const asInstancePreview = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v !== "").slice(0, 3)
    : undefined

const optionalSnapshotString = <K extends keyof BoxStatusSnapshot>(
  key: K,
  value: unknown,
): Partial<Pick<BoxStatusSnapshot, K>> => {
  const parsed = asNonEmptyString(value)
  if (parsed === undefined) return {}
  return {
    [key]: key === "lastLogLine" ? normalizeStatusText(parsed) : parsed,
  } as Partial<Pick<BoxStatusSnapshot, K>>
}

const optionalSnapshotNumber = <K extends keyof BoxStatusSnapshot>(
  key: K,
  value: unknown,
): Partial<Pick<BoxStatusSnapshot, K>> => {
  const parsed = asFiniteNumber(value)
  return parsed === undefined ? {} : ({ [key]: parsed } as Partial<Pick<BoxStatusSnapshot, K>>)
}

const snapshotPathMeta = (parsed: Partial<BoxStatusSnapshot>): Partial<BoxStatusSnapshot> => ({
  ...optionalSnapshotString("runLogPath", parsed.runLogPath),
  ...optionalSnapshotString("reportPath", parsed.reportPath),
  ...optionalSnapshotString("predictionsPath", parsed.predictionsPath),
  ...optionalSnapshotString("observeDir", parsed.observeDir),
  ...optionalSnapshotString("trajectoryPath", parsed.trajectoryPath),
})

const snapshotVerdictMeta = (parsed: Partial<BoxStatusSnapshot>): Partial<BoxStatusSnapshot> => ({
  ...optionalSnapshotNumber("resolvedCount", parsed.resolvedCount),
  ...optionalSnapshotNumber("unresolvedCount", parsed.unresolvedCount),
  ...optionalSnapshotNumber("erroredCount", parsed.erroredCount),
  ...optionalSnapshotNumber("emptyPatchCount", parsed.emptyPatchCount),
  ...(parsed.rateLimited === true ? { rateLimited: true } : {}),
  ...optionalSnapshotNumber("lastExitCode", parsed.lastExitCode),
  ...optionalSnapshotString("lastLogLine", parsed.lastLogLine),
})

const lspGroundingMeta = (
  parsed: Partial<BoxStatusSnapshot>,
): Partial<Pick<BoxStatusSnapshot, "lspGrounding">> => {
  const status = parseLspGroundingStatus(parsed.lspGrounding)
  return status === undefined ? {} : { lspGrounding: status }
}

const normalizeSnapshotPayload = (
  parsed: Partial<BoxStatusSnapshot>,
): BoxStatusSnapshot | undefined => {
  const phase = asSnapshotPhase(parsed.phase)
  const mode = asSnapshotMode(parsed.mode)
  const instancePreview = asInstancePreview(parsed.instancePreview)
  if (phase === undefined || mode === undefined) return undefined
  return {
    phase,
    mode,
    ...optionalSnapshotString("runId", parsed.runId),
    ...optionalSnapshotString("accountLabel", parsed.accountLabel),
    workload: asNonEmptyString(parsed.workload) ?? "unknown",
    dataset: asNonEmptyString(parsed.dataset) ?? "unknown",
    instanceCount: asFiniteNumber(parsed.instanceCount) ?? 0,
    ...(instancePreview !== undefined ? { instancePreview } : {}),
    preset: asNonEmptyString(parsed.preset) ?? "unknown",
    model: asNonEmptyString(parsed.model) ?? "unknown",
    concurrency: asFiniteNumber(parsed.concurrency) ?? 0,
    ...optionalSnapshotString("startedAt", parsed.startedAt),
    updatedAt: asNonEmptyString(parsed.updatedAt) ?? "unknown",
    ...snapshotPathMeta(parsed),
    ...snapshotVerdictMeta(parsed),
    ...lspGroundingMeta(parsed),
  }
}

const BOX_SNAPSHOT_MISSING_MARKER = "__QUANTA_BOX_SNAPSHOT_MISSING__"

const boxSnapshotReadCommand = `if test -f ${BOX_STATUS_PATH}; then cat ${BOX_STATUS_PATH}; else printf '%s\\n' '${BOX_SNAPSHOT_MISSING_MARKER}'; fi`

export type BoxSnapshotRead = {
  readonly snapshotHealthy: boolean
  readonly snapshotState: "ok" | "missing" | "invalid" | "read-failed"
  readonly snapshot?: BoxStatusSnapshot
}

export const readBoxSnapshot = async (
  ssh: (cmd: string) => Promise<SpawnResult>,
): Promise<BoxSnapshotRead> => {
  const raw = await ssh(boxSnapshotReadCommand).catch(() => undefined)
  if (raw === undefined || raw.code !== 0) {
    return { snapshotHealthy: false, snapshotState: "read-failed" }
  }
  const stdout = raw.stdout.trim()
  if (stdout === BOX_SNAPSHOT_MISSING_MARKER) {
    return { snapshotHealthy: false, snapshotState: "missing" }
  }
  if (stdout === "") {
    return { snapshotHealthy: false, snapshotState: "invalid" }
  }
  try {
    const snapshot = normalizeSnapshotPayload(JSON.parse(raw.stdout) as Partial<BoxStatusSnapshot>)
    if (snapshot === undefined) return { snapshotHealthy: false, snapshotState: "invalid" }
    return { snapshotHealthy: true, snapshotState: "ok", snapshot }
  } catch {
    return { snapshotHealthy: false, snapshotState: "invalid" }
  }
}

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined

const normalizeRuntimeProbePayload = (
  parsed: Partial<BoxRuntimeProbe>,
): BoxRuntimeProbe | undefined => {
  const activeRunDetected = asBoolean(parsed.activeRunDetected) ?? false
  const runLogPath = asNonEmptyString(parsed.runLogPath)
  const runLogUpdatedAt = asNonEmptyString(parsed.runLogUpdatedAt)
  const reportPath = asNonEmptyString(parsed.reportPath)
  const reportExists = asBoolean(parsed.reportExists)
  const predictionsPath = asNonEmptyString(parsed.predictionsPath)
  const predictionsLines = asFiniteNumber(parsed.predictionsLines)
  const observeDir = asNonEmptyString(parsed.observeDir)
  const runExitPath = asNonEmptyString(parsed.runExitPath)
  const runExitExists = asBoolean(parsed.runExitExists)
  const lastLogLine = asNonEmptyString(parsed.lastLogLine)
  if (
    !activeRunDetected &&
    runLogPath === undefined &&
    runLogUpdatedAt === undefined &&
    reportPath === undefined &&
    reportExists === undefined &&
    predictionsPath === undefined &&
    predictionsLines === undefined &&
    observeDir === undefined &&
    runExitPath === undefined &&
    runExitExists === undefined &&
    lastLogLine === undefined
  ) {
    return undefined
  }
  return {
    activeRunDetected,
    ...(runLogPath !== undefined ? { runLogPath } : {}),
    ...(runLogUpdatedAt !== undefined ? { runLogUpdatedAt } : {}),
    ...(reportPath !== undefined ? { reportPath } : {}),
    ...(reportExists !== undefined ? { reportExists } : {}),
    ...(predictionsPath !== undefined ? { predictionsPath } : {}),
    ...(predictionsLines !== undefined ? { predictionsLines } : {}),
    ...(observeDir !== undefined ? { observeDir } : {}),
    ...(runExitPath !== undefined ? { runExitPath } : {}),
    ...(runExitExists !== undefined ? { runExitExists } : {}),
    ...(lastLogLine !== undefined ? { lastLogLine: normalizeStatusText(lastLogLine) } : {}),
  }
}

const BOX_RUNTIME_PROBE_MARKER = "__QUANTA_BOX_RUNTIME_PROBE__"

const boxRuntimeProbeCommand = [
  "python3 - <<'PY'",
  `# ${BOX_RUNTIME_PROBE_MARKER}`,
  "import glob, json, os, re, subprocess",
  "from datetime import datetime, timezone",
  "",
  "HOME = os.path.expanduser('~')",
  "",
  "def ps_lines():",
  "    try:",
  "        out = subprocess.check_output(['ps', '-Ao', 'args='], text=True, stderr=subprocess.DEVNULL)",
  "        return [line.strip() for line in out.splitlines() if line.strip()]",
  "    except Exception:",
  "        return []",
  "",
  "def first_group(pattern, lines):",
  "    regex = re.compile(pattern)",
  "    for line in lines:",
  "        match = regex.search(line)",
  "        if match is None:",
  "            continue",
  "        for group in match.groups():",
  "            if group:",
  "                return group",
  "    return None",
  "",
  "def latest_log():",
  "    candidates = [os.path.join(HOME, 'run.log')] + glob.glob(os.path.join(HOME, 'runs', '*', 'run.log'))",
  "    existing = [path for path in candidates if os.path.exists(path)]",
  "    if not existing:",
  "        return None",
  "    return max(existing, key=os.path.getmtime)",
  "",
  "def iso_mtime(path):",
  "    if not path or not os.path.exists(path):",
  "        return None",
  "    try:",
  "        return datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).isoformat().replace('+00:00', 'Z')",
  "    except Exception:",
  "        return None",
  "",
  "def count_lines(path):",
  "    if not path or not os.path.exists(path):",
  "        return None",
  "    try:",
  "        with open(path, 'r', encoding='utf-8', errors='ignore') as handle:",
  "            return sum(1 for _ in handle)",
  "    except Exception:",
  "        return None",
  "",
  "def last_line(path):",
  "    if not path or not os.path.exists(path):",
  "        return None",
  "    try:",
  "        with open(path, 'r', encoding='utf-8', errors='ignore') as handle:",
  "            lines = [line.strip() for line in handle.readlines() if line.strip()]",
  "        return lines[-1] if lines else None",
  "    except Exception:",
  "        return None",
  "",
  "def user_path(path):",
  "    if not path:",
  "        return None",
  "    return path.replace(HOME, '~', 1) if path.startswith(HOME) else path",
  "",
  "def is_driver_line(line):",
  "    return bool(re.search(r'\\bbun\\b.*src/apps/bench/cli\\.ts\\s+run\\b', line))",
  "",
  "def is_grade_line(line):",
  "    return 'python' in line and 'swebench.harness.run_evaluation' in line",
  "",
  "lines = ps_lines()",
  "driver_lines = [line for line in lines if is_driver_line(line)]",
  "grade_lines = [line for line in lines if is_grade_line(line)]",
  "",
  "run_log = first_group(r'(?:>\\s*|tee\\s+)(\\S*run\\.log)\\b', driver_lines)",
  "report = first_group(r'--report\\s+(\\S+)', driver_lines)",
  "preds = first_group(r'--predictions\\s+(\\S+)', driver_lines)",
  "observe = first_group(r'--observe-dir\\s+(\\S+)', driver_lines)",
  "if run_log is None:",
  "    run_log = latest_log()",
  "if report is None and run_log:",
  "    report = os.path.join(os.path.dirname(run_log), 'report.json')",
  "if preds is None and run_log:",
  "    preds = os.path.join(os.path.dirname(run_log), 'preds.jsonl')",
  "if observe is None and run_log:",
  "    observe = os.path.join(os.path.dirname(run_log), 'observe')",
  "run_exit = re.sub(r'run\\.log$', 'run.exit', run_log) if run_log else None",
  "",
  "payload = {",
  "    'activeRunDetected': bool(driver_lines or grade_lines),",
  "    'runLogPath': user_path(run_log),",
  "    'runLogUpdatedAt': iso_mtime(run_log),",
  "    'reportPath': user_path(report),",
  "    'reportExists': bool(report and os.path.exists(report)),",
  "    'predictionsPath': user_path(preds),",
  "    'predictionsLines': count_lines(preds),",
  "    'observeDir': user_path(observe),",
  "    'runExitPath': user_path(run_exit),",
  "    'runExitExists': bool(run_exit and os.path.exists(run_exit)),",
  "    'lastLogLine': last_line(run_log),",
  "}",
  "print(json.dumps(payload))",
  "PY",
].join("\n")

export const readBoxRuntimeProbe = async (
  ssh: (cmd: string) => Promise<SpawnResult>,
): Promise<BoxRuntimeProbe | undefined> => {
  const raw = await ssh(boxRuntimeProbeCommand).catch(() => undefined)
  if (raw === undefined || raw.code !== 0 || raw.stdout.trim() === "") return undefined
  try {
    return normalizeRuntimeProbePayload(JSON.parse(raw.stdout) as Partial<BoxRuntimeProbe>)
  } catch {
    return undefined
  }
}

const probeShowsRuntimeEvidence = (probe: BoxRuntimeProbe | undefined): boolean =>
  probe?.activeRunDetected === true ||
  probe?.runLogPath !== undefined ||
  probe?.runLogUpdatedAt !== undefined ||
  probe?.reportPath !== undefined ||
  probe?.reportExists !== undefined ||
  probe?.predictionsPath !== undefined ||
  probe?.predictionsLines !== undefined ||
  probe?.observeDir !== undefined ||
  probe?.runExitPath !== undefined ||
  probe?.runExitExists !== undefined ||
  probe?.lastLogLine !== undefined

/**
 * `gradeChunkOnBox()` publishes the running snapshot BEFORE dataset upload,
 * token ship, and the detached bench run start. Once the runtime probe can see
 * an active run or any run artifacts, the snapshot file should already exist.
 * If it does not, the snapshot publish path regressed and the operator must see
 * that as stronger than a generic "missing file".
 */
export const resolveSnapshotInspection = (
  snapshotRead: BoxSnapshotRead,
  probe: BoxRuntimeProbe | undefined,
  busy: boolean,
): Pick<BoxInspection, "snapshotHealthy" | "snapshotState" | "snapshot"> => {
  if (snapshotRead.snapshotState === "missing" && (busy || probeShowsRuntimeEvidence(probe))) {
    return { snapshotHealthy: false, snapshotState: "write-failed" }
  }
  return {
    snapshotHealthy: snapshotRead.snapshotHealthy,
    snapshotState: snapshotRead.snapshotState,
    ...(snapshotRead.snapshot !== undefined ? { snapshot: snapshotRead.snapshot } : {}),
  }
}

export const boxRunLogPath = (
  snapshot?: Pick<BoxStatusSnapshot, "mode" | "runId" | "runLogPath">,
): string | undefined => {
  if (snapshot?.runLogPath !== undefined && snapshot.runLogPath !== "") return snapshot.runLogPath
  if (snapshot?.mode === "pool" && snapshot.runId !== undefined && snapshot.runId !== "") {
    return `~/runs/${snapshot.runId}/run.log`
  }
  if (snapshot?.mode === "full-remote") return DEFAULT_CHUNK_PATHS.runLog
  return undefined
}

const SNAPSHOT_HEARTBEAT_MS = 15_000
const SNAPSHOT_LINE_FLUSH_MS = 2_000

export interface GradeChunkState {
  wroteRunningSnapshot: boolean
  finalExitCode?: number
  finalLastLogLine?: string
  finalResolvedCount?: number
  finalUnresolvedCount?: number
  finalErroredCount?: number
  finalEmptyPatchCount?: number
  finalRateLimited: boolean
  /** #9: report bytes were present but failed to parse (truncated/corrupt fetch),
   *  distinct from a genuinely-absent report. */
  finalReportUnparseable?: boolean
  latestLogLine?: string
  sawLiveLogLine: boolean
  lastSnapshotFlushAt: number
  snapshotWrites: Promise<void>
  heartbeat?: ReturnType<typeof setInterval>
}

export const createGradeChunkState = (): GradeChunkState => ({
  wroteRunningSnapshot: false,
  finalRateLimited: false,
  sawLiveLogLine: false,
  lastSnapshotFlushAt: 0,
  snapshotWrites: Promise.resolve(),
})

export const createSnapshotBase = (
  params: GradeChunkParams,
  paths: ChunkPaths,
  artifactSuffix: string,
): Omit<BoxStatusSnapshot, "phase" | "updatedAt"> => {
  const selection = selectionMeta(params)
  return {
    mode: snapshotMode(params),
    ...(snapshotMode(params) === "pool" ? { runId: artifactSuffix } : {}),
    ...(params.accountLabel !== undefined && params.accountLabel !== ""
      ? { accountLabel: params.accountLabel }
      : {}),
    workload: workloadLabel(params),
    dataset: basename(params.datasetPath),
    instanceCount: selection.instanceCount,
    ...(selection.instancePreview !== undefined
      ? { instancePreview: selection.instancePreview }
      : {}),
    preset: params.preset,
    model: params.model,
    concurrency: params.concurrency,
    startedAt: new Date().toISOString(),
    runLogPath: paths.runLog,
    reportPath: paths.report,
    predictionsPath: paths.preds,
    observeDir: paths.observeDir,
    ...(params.recordTrajectory ? { trajectoryPath: paths.trajectory } : {}),
  }
}

const idleSnapshotExtras = (state: GradeChunkState): Partial<BoxStatusSnapshot> => ({
  ...(state.finalExitCode !== undefined ? { lastExitCode: state.finalExitCode } : {}),
  ...(state.finalResolvedCount !== undefined ? { resolvedCount: state.finalResolvedCount } : {}),
  ...(state.finalUnresolvedCount !== undefined
    ? { unresolvedCount: state.finalUnresolvedCount }
    : {}),
  ...(state.finalErroredCount !== undefined ? { erroredCount: state.finalErroredCount } : {}),
  ...(state.finalEmptyPatchCount !== undefined
    ? { emptyPatchCount: state.finalEmptyPatchCount }
    : {}),
  ...(state.finalRateLimited ? { rateLimited: true } : {}),
  ...(state.finalReportUnparseable ? { reportUnparseable: true } : {}),
  ...(state.finalLastLogLine !== undefined && state.finalLastLogLine !== ""
    ? { lastLogLine: state.finalLastLogLine }
    : {}),
})

export const createSnapshotController = (
  session: BoxSession,
  snapshotBase: Omit<BoxStatusSnapshot, "phase" | "updatedAt">,
  state: GradeChunkState,
): {
  publish: (phase: BoxStatusSnapshot["phase"], extras?: Partial<BoxStatusSnapshot>) => Promise<void>
  flush: (force?: boolean) => void
  makeLineStreamer: () => (chunk: string) => void
  start: () => Promise<void>
  stop: () => void
  finish: () => Promise<void>
} => {
  const { log } = session
  let snapshotWriteFailures = 0
  let snapshotWriteWarned = false
  const publish = async (
    phase: BoxStatusSnapshot["phase"],
    extras: Partial<BoxStatusSnapshot> = {},
  ): Promise<void> => {
    state.snapshotWrites = state.snapshotWrites.then(async () => {
      const write = await writeBoxSnapshot(session, {
        ...snapshotBase,
        phase,
        updatedAt: new Date().toISOString(),
        ...extras,
      })
      if (!write.ok) {
        snapshotWriteFailures += 1
        if (!snapshotWriteWarned) {
          snapshotWriteWarned = true
          log(`[box] snapshot publish failed (${phase}): ${write.error}`)
        }
      }
    })
    await state.snapshotWrites
  }

  const flush = (force = false): void => {
    if (!state.wroteRunningSnapshot) return
    const now = Date.now()
    if (!force && now - state.lastSnapshotFlushAt < SNAPSHOT_LINE_FLUSH_MS) return
    state.lastSnapshotFlushAt = now
    void publish("running", {
      ...(state.latestLogLine !== undefined && state.latestLogLine !== ""
        ? { lastLogLine: state.latestLogLine }
        : {}),
    })
  }

  const makeLineStreamer = (): ((chunk: string) => void) =>
    createLineStreamer((line) => {
      log(`[box] ${line}`)
      const normalized = normalizeStatusText(line)
      if (normalized !== "") {
        state.latestLogLine = normalized
        if (!state.sawLiveLogLine) {
          state.sawLiveLogLine = true
          flush(true)
          return
        }
      }
      flush()
    })

  const start = async (): Promise<void> => {
    await publish("running")
    state.wroteRunningSnapshot = true
    state.lastSnapshotFlushAt = Date.now()
    state.heartbeat = setInterval(() => flush(true), SNAPSHOT_HEARTBEAT_MS)
    state.heartbeat.unref?.()
  }

  const stop = (): void => {
    if (state.heartbeat !== undefined) clearInterval(state.heartbeat)
  }

  const finish = async (): Promise<void> => {
    if (!state.wroteRunningSnapshot) return
    await publish("idle", idleSnapshotExtras(state))
    if (snapshotWriteFailures > 0) {
      log(
        `[box] snapshot publish degraded: ${snapshotWriteFailures} failure(s) total; ` +
          "later `box status` may report snapshot=write-failed.",
      )
    }
  }

  return { publish, flush, makeLineStreamer, start, stop, finish }
}
