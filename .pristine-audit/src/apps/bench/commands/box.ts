/**
 * `quanta-bench box` (ls|status|logs|rm|up) — the WARM box pool manager
 * (jun-20 box-lifecycle), extracted from cli.ts (ADR-0536 P0). Boxes are SPOT +
 * TTL-self-terminating; this is visibility + manual cleanup + pre-warming.
 * Moved verbatim; behaviour-identical.
 *
 *   quanta-bench box ls                  # list running quanta-bench boxes + runtime status
 *   quanta-bench box ls --json           # same, machine-readable
 *   quanta-bench box status              # operator summary + suggested follow target
 *   quanta-bench box rm <iid|all>        # terminate a box (or all of them)
 *   quanta-bench box up                  # provision + bootstrap ONE warm box, leave it alive
 */
import { errMessage, gateOn, logger, renderLspGroundingStatus } from "@/shared"
import { resolveBenchmarkRunConfig } from "../benchmark-suite"
import { boxRunLogPath, D, inspectBox, provisionBox } from "../remote/box-session"
import { BENCH_SSH_SAFE_OPTS } from "../remote/box-session/shell"
import { type PatchGenBudgetState, readPatchGenBudgetState } from "../remote/token-budget"
import { type BenchRunConfig, readDatasetFamilySelector } from "../run-config"
import { argValue, hasFlag, positionals, printBlock } from "./shared"

const BOX_TAG_FILTERS = [
  "--filters",
  "Name=tag:Name,Values=quanta-bench-full",
  "Name=instance-state-name,Values=running,pending",
]

const awsText = async (
  region: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> => {
  const p = Bun.spawn(["aws", "--region", region, ...args], { stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  return { code: await p.exited, out, err }
}

interface BoxLsRow {
  readonly iid: string
  readonly state: string
  readonly launchTime: string
  readonly ip: string
  readonly instanceType: string
  readonly launchMode?: string
  readonly launchPreset?: string
  readonly launchModel?: string
  readonly launchDataset?: string
  readonly launchSelection?: string
}

interface BoxRuntimeRow extends BoxLsRow, Awaited<ReturnType<typeof inspectBox>> {
  readonly snapshotAgeSec?: number
  readonly runAgeSec?: number
  readonly logPath?: string
  readonly logAgeSec?: number
  readonly freshness: "fresh" | "stale" | "unknown"
  readonly statusSource: "snapshot" | "probe" | "launch-tags" | "none"
  readonly followHint: string
}

interface BoxStatusSummary {
  readonly total: number
  readonly busy: number
  readonly idle: number
  readonly bootstrapping: number
  readonly unreachable: number
  readonly stale: number
  readonly snapshotIssues: number
  readonly snapshotStateCounts: Partial<
    Record<Awaited<ReturnType<typeof inspectBox>>["snapshotState"], number>
  >
  readonly target?: string
  readonly targetFollowHint?: string
}

const DEFAULT_BOX_LOG_PATH = "~/run.log"
const BUSY_SNAPSHOT_STALE_SEC = 180
const IDLE_SNAPSHOT_STALE_SEC = 900

const parseBoxLsRows = (out: string): BoxLsRow[] =>
  out
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [
        iid = "",
        state = "",
        launchTime = "",
        ip = "",
        instanceType = "",
        launchMode = "",
        launchPreset = "",
        launchModel = "",
        launchDataset = "",
        launchSelection = "",
      ] = line.split(/\s+/)
      return {
        iid,
        state,
        launchTime,
        ip,
        instanceType,
        ...(launchMode !== "" && launchMode !== "None" ? { launchMode } : {}),
        ...(launchPreset !== "" && launchPreset !== "None" ? { launchPreset } : {}),
        ...(launchModel !== "" && launchModel !== "None" ? { launchModel } : {}),
        ...(launchDataset !== "" && launchDataset !== "None" ? { launchDataset } : {}),
        ...(launchSelection !== "" && launchSelection !== "None" ? { launchSelection } : {}),
      }
    })
    .filter((row) => row.iid.startsWith("i-"))

const hasLaunchTags = (
  row: Pick<
    BoxLsRow,
    "launchMode" | "launchPreset" | "launchModel" | "launchDataset" | "launchSelection"
  >,
): boolean =>
  row.launchMode !== undefined ||
  row.launchPreset !== undefined ||
  row.launchModel !== undefined ||
  row.launchDataset !== undefined ||
  row.launchSelection !== undefined

const parseIsoMs = (s: string | undefined): number | undefined => {
  if (s === undefined || s === "") return undefined
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : undefined
}

const ageSecondsFromIso = (s: string | undefined): number | undefined => {
  const ms = parseIsoMs(s)
  if (ms === undefined) return undefined
  return Math.max(0, Math.round((Date.now() - ms) / 1000))
}

const boxStatusSource = (
  row: BoxLsRow,
  inspection: Pick<Awaited<ReturnType<typeof inspectBox>>, "snapshot" | "probe">,
): BoxRuntimeRow["statusSource"] =>
  inspection.snapshot !== undefined
    ? "snapshot"
    : inspection.probe !== undefined
      ? "probe"
      : hasLaunchTags(row)
        ? "launch-tags"
        : "none"

const boxFreshness = (
  lifecycle: BoxRuntimeRow["lifecycle"],
  snapshotAgeSec: number | undefined,
  probe: Awaited<ReturnType<typeof inspectBox>>["probe"],
  logAgeSec: number | undefined,
): BoxRuntimeRow["freshness"] => {
  if (snapshotAgeSec !== undefined) {
    const budgetSec = lifecycle === "busy" ? BUSY_SNAPSHOT_STALE_SEC : IDLE_SNAPSHOT_STALE_SEC
    return snapshotAgeSec > budgetSec ? "stale" : "fresh"
  }
  if (probe?.activeRunDetected === true) return "fresh"
  if (logAgeSec === undefined) return "unknown"
  const budgetSec = lifecycle === "busy" ? BUSY_SNAPSHOT_STALE_SEC : IDLE_SNAPSHOT_STALE_SEC
  return logAgeSec > budgetSec ? "stale" : "fresh"
}

const listBenchBoxes = async (region: string, keyPath: string): Promise<BoxRuntimeRow[]> => {
  const r = await awsText(region, [
    "ec2",
    "describe-instances",
    ...BOX_TAG_FILTERS,
    "--query",
    "Reservations[].Instances[].[InstanceId,State.Name,LaunchTime,PublicIpAddress,InstanceType,Tags[?Key=='QuantaMode']|[0].Value,Tags[?Key=='QuantaPreset']|[0].Value,Tags[?Key=='QuantaModel']|[0].Value,Tags[?Key=='QuantaDataset']|[0].Value,Tags[?Key=='QuantaSelection']|[0].Value]",
    "--output",
    "text",
  ])
  if (r.code !== 0) {
    logger.info(`[box] describe failed: ${r.err.trim()}`)
    process.exit(1)
  }
  const rows = parseBoxLsRows(r.out)
  if (rows.length === 0) return []
  const baseCfg = {
    repoDir: process.cwd(),
    authJson: "{}",
    datasetPath: "",
    region,
    keyPath,
  }
  const inspections: Awaited<ReturnType<typeof inspectBox>>[] = await Promise.all(
    rows.map(async (row) => {
      if (row.state !== "running" || row.ip === "" || row.ip === "None") {
        return {
          lifecycle: "bootstrapping",
          bootstrapped: false,
          busy: false,
          snapshotHealthy: false,
          snapshotState: "not-ready",
        }
      }
      return inspectBox(baseCfg, { iid: row.iid, ip: row.ip }).catch(() => ({
        lifecycle: "unreachable",
        bootstrapped: false,
        busy: false,
        snapshotHealthy: false,
        snapshotState: "read-failed",
      }))
    }),
  )
  return rows.map((row, i) => {
    const inspection = inspections[i] ?? {
      lifecycle: "unreachable",
      bootstrapped: false,
      busy: false,
      snapshotHealthy: false,
      snapshotState: "read-failed",
    }
    const snapshot = inspection.snapshot
    const probe = inspection.probe
    const snapshotAgeSec = ageSecondsFromIso(snapshot?.updatedAt)
    const runAgeSec = ageSecondsFromIso(snapshot?.startedAt)
    const logPath = boxRunLogPath(snapshot) ?? probe?.runLogPath
    const logAgeSec = ageSecondsFromIso(probe?.runLogUpdatedAt)
    return {
      ...row,
      ...inspection,
      ...(snapshotAgeSec !== undefined ? { snapshotAgeSec } : {}),
      ...(runAgeSec !== undefined ? { runAgeSec } : {}),
      ...(logPath !== undefined ? { logPath } : {}),
      ...(logAgeSec !== undefined ? { logAgeSec } : {}),
      freshness: boxFreshness(inspection.lifecycle, snapshotAgeSec, probe, logAgeSec),
      statusSource: boxStatusSource(row, inspection),
      followHint: `bun run src/apps/bench/cli.ts box logs ${row.iid} --follow`,
    }
  })
}

const latestLaunchFirst = (rows: readonly BoxRuntimeRow[]): BoxRuntimeRow[] =>
  [...rows].sort(
    (a, b) =>
      (parseIsoMs(b.launchTime) ?? Number.NEGATIVE_INFINITY) -
      (parseIsoMs(a.launchTime) ?? Number.NEGATIVE_INFINITY),
  )

const resolveBoxTarget = (
  rows: readonly BoxRuntimeRow[],
  raw: string | undefined,
): BoxRuntimeRow => {
  if (rows.length === 0) {
    throw new Error("[box] no running quanta-bench boxes")
  }
  const target = raw?.trim()
  if (target === undefined || target === "" || target === "auto") {
    const busy = latestLaunchFirst(rows.filter((row) => row.lifecycle === "busy"))
    if (busy[0] !== undefined) return busy[0]
    return latestLaunchFirst(rows)[0] as BoxRuntimeRow
  }
  if (target === "latest") return latestLaunchFirst(rows)[0] as BoxRuntimeRow
  if (target === "busy") {
    const busy = latestLaunchFirst(rows.filter((row) => row.lifecycle === "busy"))
    if (busy[0] === undefined) throw new Error("[box] no busy box is currently running")
    return busy[0]
  }
  const exact = rows.find((row) => row.iid === target)
  if (exact !== undefined) return exact
  const pref = rows.filter((row) => row.iid.startsWith(target))
  if (pref.length === 1) return pref[0] as BoxRuntimeRow
  if (pref.length > 1) {
    throw new Error(
      `[box] ambiguous box target "${target}" — matches: ${pref.map((row) => row.iid).join(", ")}`,
    )
  }
  throw new Error(`[box] box "${target}" not found`)
}

const summarizeBenchBoxes = (rows: readonly BoxRuntimeRow[]): BoxStatusSummary => {
  const snapshotStateCounts = rows.reduce<
    Partial<Record<Awaited<ReturnType<typeof inspectBox>>["snapshotState"], number>>
  >((acc, row) => {
    if (row.snapshotHealthy) return acc
    acc[row.snapshotState] = (acc[row.snapshotState] ?? 0) + 1
    return acc
  }, {})
  if (rows.length === 0) {
    return {
      total: 0,
      busy: 0,
      idle: 0,
      bootstrapping: 0,
      unreachable: 0,
      stale: 0,
      snapshotIssues: 0,
      snapshotStateCounts,
    }
  }
  const target = resolveBoxTarget(rows, "auto")
  return {
    total: rows.length,
    busy: rows.filter((row) => row.lifecycle === "busy").length,
    idle: rows.filter((row) => row.lifecycle === "idle").length,
    bootstrapping: rows.filter((row) => row.lifecycle === "bootstrapping").length,
    unreachable: rows.filter((row) => row.lifecycle === "unreachable").length,
    stale: rows.filter((row) => row.freshness === "stale").length,
    snapshotIssues: rows.filter((row) => !row.snapshotHealthy).length,
    snapshotStateCounts,
    target: target.iid,
    targetFollowHint: target.followHint,
  }
}

const boxStatusLabel = (row: BoxRuntimeRow): string =>
  `${row.lifecycle}${row.snapshot?.phase !== undefined ? `/${row.snapshot.phase}` : ""}${
    row.freshness === "stale" ? "/stale" : ""
  }`

const snapshotHealthDetail = (
  row: Pick<BoxRuntimeRow, "snapshotHealthy" | "snapshotState">,
): string => (row.snapshotHealthy ? "  snapshot=ok" : `  snapshot=${row.snapshotState}`)

const yesNo = (value: boolean | undefined): string =>
  value === true ? "yes" : value === false ? "no" : "unknown"

const boxSnapshotDetailLine = (row: BoxRuntimeRow): string | undefined => {
  if (row.snapshot === undefined) return undefined
  return `  source=snapshot  mode=${row.snapshot.mode}${row.snapshot.accountLabel !== undefined ? `  account=${row.snapshot.accountLabel}` : ""}  workload=${row.snapshot.runId ?? row.snapshot.workload}  dataset=${row.snapshot.dataset}  instances=${row.snapshot.instanceCount}  preset=${row.snapshot.preset}  model=${row.snapshot.model}  conc=${row.snapshot.concurrency}  updated=${row.snapshot.updatedAt}${row.snapshotAgeSec !== undefined ? ` (${row.snapshotAgeSec}s ago)` : ""}`
}

const boxProbeDetailLine = (row: BoxRuntimeRow): string | undefined => {
  if (row.probe === undefined) return undefined
  return `  source=probe${snapshotHealthDetail(row)}  active=${yesNo(row.probe.activeRunDetected)}  report=${yesNo(row.probe.reportExists)}  runExit=${yesNo(row.probe.runExitExists)}${row.probe.predictionsLines !== undefined ? `  preds=${row.probe.predictionsLines}` : ""}`
}

const boxLaunchTagDetailLine = (row: BoxRuntimeRow): string | undefined => {
  if (!hasLaunchTags(row)) return undefined
  return `  source=launch-tags${snapshotHealthDetail(row)}${row.launchMode !== undefined ? `  mode=${row.launchMode}` : ""}${row.launchPreset !== undefined ? `  preset=${row.launchPreset}` : ""}${row.launchModel !== undefined ? `  model=${row.launchModel}` : ""}${row.launchDataset !== undefined ? `  dataset=${row.launchDataset}` : ""}${row.launchSelection !== undefined ? `  selection=${row.launchSelection}` : ""}`
}

const boxDetailLine = (row: BoxRuntimeRow): string | undefined =>
  boxSnapshotDetailLine(row) ?? boxProbeDetailLine(row) ?? boxLaunchTagDetailLine(row)

const boxLaunchHeaderLine = (row: BoxRuntimeRow): string | undefined =>
  row.snapshot === undefined && row.probe === undefined && hasLaunchTags(row)
    ? boxDetailLine(row)
    : undefined

const boxRuntimeLine = (row: BoxRuntimeRow): string | undefined => {
  if (row.snapshot !== undefined) {
    return `  started=${row.snapshot.startedAt ?? "unknown"}${row.runAgeSec !== undefined ? `  runtime=${row.runAgeSec}s` : ""}${row.logPath !== undefined ? `  logPath=${row.logPath}` : ""}`
  }
  if (row.probe === undefined) return undefined
  return `${row.logPath !== undefined ? `  logPath=${row.logPath}` : "  logPath=unknown"}${
    row.probe.runLogUpdatedAt !== undefined
      ? `  logUpdated=${row.probe.runLogUpdatedAt}${row.logAgeSec !== undefined ? ` (${row.logAgeSec}s ago)` : ""}`
      : ""
  }`
}

const boxOutcomeLine = (row: BoxRuntimeRow): string | undefined =>
  row.snapshot?.resolvedCount !== undefined ||
  row.snapshot?.unresolvedCount !== undefined ||
  row.snapshot?.erroredCount !== undefined ||
  row.snapshot?.emptyPatchCount !== undefined ||
  row.snapshot?.rateLimited === true
    ? `  outcome=resolved:${row.snapshot?.resolvedCount ?? 0} unresolved:${row.snapshot?.unresolvedCount ?? 0} errored:${row.snapshot?.erroredCount ?? 0} empty:${row.snapshot?.emptyPatchCount ?? 0}${row.snapshot?.rateLimited === true ? "  rateLimited=yes" : ""}`
    : undefined

const renderBoxRow = (row: BoxRuntimeRow): string[] => {
  const headline = `${row.iid}  ${row.state}  ${row.instanceType}  ${row.ip}  status=${boxStatusLabel(row)}`
  return [
    headline,
    `  launched=${row.launchTime}`,
    boxDetailLine(row),
    boxRuntimeLine(row),
    boxOutcomeLine(row),
    row.snapshot?.lspGrounding !== undefined
      ? `  lsp=${renderLspGroundingStatus(row.snapshot.lspGrounding)}`
      : undefined,
    row.snapshot?.lastLogLine !== undefined
      ? `  log=${row.snapshot.lastLogLine}`
      : row.probe?.lastLogLine !== undefined
        ? `  log=${row.probe.lastLogLine}`
        : undefined,
    row.logPath !== undefined ? `  follow=${row.followHint}` : undefined,
  ].filter((line): line is string => line !== undefined)
}

const renderBoxList = (rows: readonly BoxRuntimeRow[]): string =>
  ["[box] running boxes:", ...latestLaunchFirst(rows).flatMap((row) => renderBoxRow(row))].join(
    "\n",
  )

const renderPatchGenBudgetLine = (budget: PatchGenBudgetState): string => {
  const holders =
    budget.leases.length === 0
      ? "none"
      : budget.leases
          .slice(0, 3)
          .map((lease) => `${lease.label}:${lease.units}`)
          .join(", ") + (budget.leases.length > 3 ? ` +${budget.leases.length - 3} more` : "")
  return `  patchGenBudget=${budget.inUse}/${budget.limit}  available=${budget.available}  holders=${budget.leases.length}  leases=${holders}`
}

const renderPatchGenBudgetErrorLine = (error: string): string =>
  `  patchGenBudget=unavailable  error=${error}`

const SNAPSHOT_STATE_RENDER_ORDER: ReadonlyArray<
  Awaited<ReturnType<typeof inspectBox>>["snapshotState"]
> = ["write-failed", "read-failed", "invalid", "missing", "not-ready", "ok"]

const renderSnapshotStateCounts = (
  counts: Partial<Record<Awaited<ReturnType<typeof inspectBox>>["snapshotState"], number>>,
): string | undefined => {
  const rendered = SNAPSHOT_STATE_RENDER_ORDER.map((state) => {
    const count = counts[state]
    return count !== undefined && count > 0 ? `${state}:${count}` : undefined
  })
    .filter((entry): entry is string => entry !== undefined)
    .join(",")
  return rendered === "" ? undefined : rendered
}

const renderBoxStatus = (
  summary: BoxStatusSummary,
  rows: readonly BoxRuntimeRow[],
  budget: PatchGenBudgetState | undefined,
  budgetError: string | undefined,
): string => {
  const staleRows = latestLaunchFirst(rows.filter((row) => row.freshness === "stale"))
  const focus =
    latestLaunchFirst(rows.filter((row) => row.lifecycle === "busy"))[0] ??
    latestLaunchFirst(rows)[0]
  return [
    "[box] summary:",
    `  total=${summary.total}  busy=${summary.busy}  idle=${summary.idle}  bootstrapping=${summary.bootstrapping}  unreachable=${summary.unreachable}  stale=${summary.stale}  snapshotIssues=${summary.snapshotIssues}${
      renderSnapshotStateCounts(summary.snapshotStateCounts) !== undefined
        ? `  snapshotStates=${renderSnapshotStateCounts(summary.snapshotStateCounts)}`
        : ""
    }`,
    budget !== undefined ? renderPatchGenBudgetLine(budget) : undefined,
    budget === undefined && budgetError !== undefined
      ? renderPatchGenBudgetErrorLine(budgetError)
      : undefined,
    focus !== undefined
      ? `  target=${focus.iid}  status=${boxStatusLabel(focus)}  source=${focus.statusSource}${snapshotHealthDetail(focus)}${focus.logPath !== undefined ? `  logPath=${focus.logPath}` : ""}${
          focus.logAgeSec !== undefined ? `  logAge=${focus.logAgeSec}s` : ""
        }`
      : undefined,
    summary.targetFollowHint !== undefined ? `  follow=${summary.targetFollowHint}` : undefined,
    ...staleRows.map(
      (row) =>
        `  stale=${row.iid}  status=${boxStatusLabel(row)}  source=${row.statusSource}${snapshotHealthDetail(row)}  updated=${row.snapshot?.updatedAt ?? row.probe?.runLogUpdatedAt ?? "none"}${
          row.snapshotAgeSec !== undefined
            ? ` (${row.snapshotAgeSec}s ago)`
            : row.logAgeSec !== undefined
              ? ` (${row.logAgeSec}s ago)`
              : ""
        }`,
    ),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

const BOX_LOG_MISSING_MARKER = "__QUANTA_LOG_MISSING__"

const boxTailCommand = (logPath: string, lines: number, follow = false): string =>
  `if test -f ${logPath}; then tail -n ${lines}${follow ? " -f" : ""} ${logPath}; else echo "${BOX_LOG_MISSING_MARKER} ${logPath}" >&2; exit 2; fi`

const missingLogPath = (tail: { out: string; err: string }): string | undefined => {
  const match = `${tail.out}\n${tail.err}`.match(/__QUANTA_LOG_MISSING__\s+(\S+)/)
  return match?.[1]
}

const cleanedLogError = (tail: { err: string }): string | undefined => {
  const cleaned = tail.err
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "" && !line.includes(BOX_LOG_MISSING_MARKER))
    .join("\n")
    .trim()
  return cleaned === "" ? undefined : cleaned
}

const boxDisplayedLastLogLine = (row: BoxRuntimeRow): string | undefined =>
  row.snapshot?.lastLogLine ?? row.probe?.lastLogLine

const boxHeaderUpdatedLine = (row: BoxRuntimeRow): string | undefined => {
  if (row.snapshot?.updatedAt !== undefined) {
    return `  updated=${row.snapshot.updatedAt}${row.snapshotAgeSec !== undefined ? ` (${row.snapshotAgeSec}s ago)` : ""}`
  }
  if (row.probe?.runLogUpdatedAt !== undefined) {
    return `  logUpdated=${row.probe.runLogUpdatedAt}${row.logAgeSec !== undefined ? ` (${row.logAgeSec}s ago)` : ""}`
  }
  return undefined
}

const boxHeaderActiveLine = (row: BoxRuntimeRow): string | undefined => {
  if (row.snapshot?.startedAt !== undefined) {
    return `  started=${row.snapshot.startedAt}${row.runAgeSec !== undefined ? `  runtime=${row.runAgeSec}s` : ""}`
  }
  if (row.probe?.activeRunDetected === true) {
    return `  active=yes${row.logAgeSec !== undefined ? `  logAge=${row.logAgeSec}s` : ""}`
  }
  return undefined
}

const renderBoxLogHeader = (
  row: BoxRuntimeRow,
  host: string,
  logPath: string,
  follow: boolean,
): string => {
  return [
    follow ? `[box] following ${row.iid} (${host})` : `[box] ${row.iid}  ${host}`,
    `  status=${boxStatusLabel(row)}`,
    `  source=${row.statusSource}${snapshotHealthDetail(row)}`,
    `  logPath=${logPath}`,
    boxHeaderUpdatedLine(row),
    boxHeaderActiveLine(row),
    boxLaunchHeaderLine(row),
    boxDisplayedLastLogLine(row) !== undefined
      ? `  last=${boxDisplayedLastLogLine(row)}`
      : undefined,
    `  follow=${row.followHint}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

const pendingLogExitCode = (row: BoxRuntimeRow): number =>
  row.lifecycle === "bootstrapping" || row.probe?.activeRunDetected === true ? 0 : 2

const pendingLogMessage = (row: BoxRuntimeRow, logPath: string | undefined): string => {
  if (row.lifecycle === "bootstrapping")
    return "run log not created yet; box is still bootstrapping"
  if (row.probe?.activeRunDetected === true) {
    return `run log not created yet${logPath !== undefined ? ` at ${logPath}` : ""}`
  }
  return `run log not found${logPath !== undefined ? ` at ${logPath}` : ""}`
}

const renderPendingLogJson = (
  row: BoxRuntimeRow,
  logPath: string | undefined,
  lines: number,
  message: string,
  error: string | undefined,
): string =>
  JSON.stringify(
    {
      iid: row.iid,
      ip: row.ip,
      lifecycle: row.lifecycle,
      freshness: row.freshness,
      statusSource: row.statusSource,
      snapshotHealthy: row.snapshotHealthy,
      snapshotState: row.snapshotState,
      logPath,
      lines,
      snapshot: row.snapshot,
      probe: row.probe,
      ...(hasLaunchTags(row)
        ? {
            launchTags: {
              ...(row.launchMode !== undefined ? { mode: row.launchMode } : {}),
              ...(row.launchPreset !== undefined ? { preset: row.launchPreset } : {}),
              ...(row.launchModel !== undefined ? { model: row.launchModel } : {}),
              ...(row.launchDataset !== undefined ? { dataset: row.launchDataset } : {}),
              ...(row.launchSelection !== undefined ? { selection: row.launchSelection } : {}),
            },
          }
        : {}),
      followHint: row.followHint,
      tail: "",
      error,
      pendingLog: true,
      message,
      exitCode: pendingLogExitCode(row),
    },
    null,
    2,
  )

const printPendingLog = (
  row: BoxRuntimeRow,
  host: string,
  logPath: string | undefined,
  lines: number,
  message: string,
): void => {
  if (hasFlag("--json")) {
    printBlock(renderPendingLogJson(row, logPath, lines, message, undefined))
    if (pendingLogExitCode(row) !== 0) process.exit(pendingLogExitCode(row))
    return
  }
  printBlock(
    [
      renderBoxLogHeader(row, host, logPath ?? DEFAULT_BOX_LOG_PATH, false),
      `--- tail -n ${lines} ---`,
      message,
    ].join("\n"),
  )
  if (pendingLogExitCode(row) !== 0) process.exit(pendingLogExitCode(row))
}

const pendingBootstrappingLog = (row: BoxRuntimeRow): boolean =>
  row.lifecycle === "bootstrapping" && row.logPath === undefined

const pendingBootstrappingHost = (row: BoxRuntimeRow): string =>
  row.ip === "" || row.ip === "None" ? "ssh-pending" : `ubuntu@${row.ip}`

const handleMissingLogTail = (
  row: BoxRuntimeRow,
  host: string,
  logPath: string,
  lines: number,
  tail: { out: string; err: string },
): boolean => {
  const pendingLogPath = missingLogPath(tail)
  if (pendingLogPath === undefined) return false
  const message = pendingLogMessage(row, pendingLogPath)
  if (hasFlag("--json")) {
    printBlock(renderPendingLogJson(row, logPath, lines, message, cleanedLogError(tail)))
    if (pendingLogExitCode(row) !== 0) process.exit(pendingLogExitCode(row))
    return true
  }
  printPendingLog(row, host, logPath, lines, message)
  return true
}

const ensureBoxLogArgs = (): void => {
  if (hasFlag("--json") && hasFlag("--follow")) {
    logger.info("[box] --json and --follow are mutually exclusive")
    process.exit(2)
  }
}

const ensureSshReadyBox = (row: BoxRuntimeRow): void => {
  if (row.state !== "running" || row.ip === "" || row.ip === "None") {
    logger.info(
      `[box] ${row.iid} is not ssh-ready yet (state=${row.state}, ip=${row.ip || "none"})`,
    )
    process.exit(1)
  }
}

const printBoxTail = (
  row: BoxRuntimeRow,
  host: string,
  logPath: string,
  lines: number,
  tail: { code: number; out: string; err: string },
): void => {
  if (hasFlag("--json")) {
    printBlock(renderBoxLogsJson(row, logPath, lines, tail))
    if (tail.code !== 0) process.exit(tail.code)
    return
  }
  printBlock(
    [renderBoxLogHeader(row, host, logPath, false), `--- tail -n ${lines} ---`, tail.out.trimEnd()]
      .filter((line) => line !== undefined)
      .join("\n"),
  )
  if (tail.code !== 0) process.exit(tail.code)
}

const renderBoxLogsJson = (
  row: BoxRuntimeRow,
  logPath: string,
  lines: number,
  tail: { code: number; out: string; err: string },
): string =>
  JSON.stringify(
    {
      iid: row.iid,
      ip: row.ip,
      lifecycle: row.lifecycle,
      freshness: row.freshness,
      statusSource: row.statusSource,
      snapshotHealthy: row.snapshotHealthy,
      snapshotState: row.snapshotState,
      phase: row.snapshot?.phase,
      logPath,
      lines,
      snapshot: row.snapshot,
      probe: row.probe,
      ...(hasLaunchTags(row)
        ? {
            launchTags: {
              ...(row.launchMode !== undefined ? { mode: row.launchMode } : {}),
              ...(row.launchPreset !== undefined ? { preset: row.launchPreset } : {}),
              ...(row.launchModel !== undefined ? { model: row.launchModel } : {}),
              ...(row.launchDataset !== undefined ? { dataset: row.launchDataset } : {}),
              ...(row.launchSelection !== undefined ? { selection: row.launchSelection } : {}),
            },
          }
        : {}),
      snapshotAgeSec: row.snapshotAgeSec,
      runAgeSec: row.runAgeSec,
      logAgeSec: row.logAgeSec,
      followHint: row.followHint,
      tail: tail.out,
      error: cleanedLogError(tail),
      exitCode: tail.code,
    },
    null,
    2,
  )

const sshBoxText = async (
  keyPath: string,
  host: string,
  remoteCmd: string,
): Promise<{ code: number; out: string; err: string }> => {
  const proc = Bun.spawn(
    [
      "ssh",
      "-i",
      keyPath,
      ...BENCH_SSH_SAFE_OPTS,
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=20",
      "-o",
      "TCPKeepAlive=yes",
      host,
      remoteCmd,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, out, err }
}

const sshBoxFollow = async (keyPath: string, host: string, remoteCmd: string): Promise<number> => {
  const proc = Bun.spawn(
    [
      "ssh",
      "-i",
      keyPath,
      ...BENCH_SSH_SAFE_OPTS,
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=20",
      "-o",
      "TCPKeepAlive=yes",
      host,
      remoteCmd,
    ],
    { stdout: "inherit", stderr: "inherit" },
  )
  return await proc.exited
}

const cmdBoxLs = async (region: string): Promise<void> => {
  const keyPath = argValue("--key") ?? D.keyPath
  const rows = await listBenchBoxes(region, keyPath)
  if (rows.length === 0) {
    printBlock("[box] no running quanta-bench boxes")
    return
  }
  if (hasFlag("--json")) {
    printBlock(JSON.stringify(rows, null, 2))
    return
  }
  printBlock(renderBoxList(rows))
}

const cmdBoxStatus = async (region: string): Promise<void> => {
  const keyPath = argValue("--key") ?? D.keyPath
  const rows = await listBenchBoxes(region, keyPath)
  const budgetState = await (async (): Promise<{
    budget?: PatchGenBudgetState
    budgetError?: string
  }> => {
    try {
      return { budget: await readPatchGenBudgetState() }
    } catch (err) {
      return { budgetError: `patch-gen budget read failed: ${errMessage(err)}` }
    }
  })()
  const ordered = latestLaunchFirst(rows)
  const summary = summarizeBenchBoxes(ordered)
  if (hasFlag("--json")) {
    printBlock(
      JSON.stringify(
        {
          summary,
          ...(budgetState.budget !== undefined ? { budget: budgetState.budget } : {}),
          ...(budgetState.budgetError !== undefined
            ? { budgetError: budgetState.budgetError }
            : {}),
          boxes: ordered,
        },
        null,
        2,
      ),
    )
    return
  }
  printBlock(renderBoxStatus(summary, ordered, budgetState.budget, budgetState.budgetError))
}

const cmdBoxLogs = async (region: string): Promise<void> => {
  ensureBoxLogArgs()
  const keyPath = argValue("--key") ?? D.keyPath
  const rows = await listBenchBoxes(region, keyPath)
  const row = resolveBoxTarget(rows, positionals()[1])
  const lines = Math.max(1, Math.trunc(Number(argValue("--lines")) || 80))
  if (pendingBootstrappingLog(row)) {
    const host = pendingBootstrappingHost(row)
    printPendingLog(row, host, undefined, lines, pendingLogMessage(row, undefined))
    return
  }
  ensureSshReadyBox(row)
  const logPath = row.logPath ?? DEFAULT_BOX_LOG_PATH
  const host = `ubuntu@${row.ip}`
  if (hasFlag("--follow")) {
    printBlock(renderBoxLogHeader(row, host, logPath, true))
    const code = await sshBoxFollow(keyPath, host, boxTailCommand(logPath, lines, true))
    if (code !== 0) process.exit(code)
    return
  }
  const tail = await sshBoxText(keyPath, host, boxTailCommand(logPath, lines))
  if (handleMissingLogTail(row, host, logPath, lines, tail)) return
  printBoxTail(row, host, logPath, lines, tail)
}

const cmdBoxRm = async (region: string): Promise<void> => {
  const target = positionals()[1]
  if (target === undefined) {
    logger.info("usage: quanta-bench box rm <instance-id|all>")
    process.exit(2)
  }
  let ids: string[]
  if (target === "all") {
    const r = await awsText(region, [
      "ec2",
      "describe-instances",
      ...BOX_TAG_FILTERS,
      "--query",
      "Reservations[].Instances[].InstanceId",
      "--output",
      "text",
    ])
    ids = r.out
      .trim()
      .split(/\s+/)
      .filter((s) => s.startsWith("i-"))
    // BLAST-RADIUS GUARD: EVERY bench box (pool, `grade --mode full`, `box up`)
    // carries the SAME `quanta-bench-full` tag — there is no per-run owner tag —
    // so `rm all` terminates boxes a CONCURRENT run/sweep may be actively grading
    // on (the EC2 form of the "광역 pkill kills the user's bench" hazard). Require
    // an explicit `--yes` and show exactly what will die first.
    if (!hasFlag("--yes")) {
      printBlock(
        [
          `[box] rm all would terminate ${ids.length} box(es) — region-wide, ALL quanta-bench boxes:`,
          ...ids.map((id) => `  ${id}`),
          "⚠️  this kills ANY concurrent run/sweep grading on these boxes. Re-run with --yes to confirm,",
          "    or terminate specific ids: `box rm <i-...>`. Check `box ls` first.",
        ].join("\n"),
      )
      process.exit(2)
    }
  } else {
    ids = [target]
  }
  if (ids.length === 0) {
    logger.info("[box] nothing to terminate")
    return
  }
  const r = await awsText(region, ["ec2", "terminate-instances", "--instance-ids", ...ids])
  logger.info(
    r.code === 0
      ? `[box] terminating: ${ids.join(", ")}`
      : `[box] terminate failed: ${r.err.trim()}`,
  )
  if (r.code !== 0) process.exit(1)
}

/** The provisioner port. Defaults to the real {@link provisionBox}; injected by
 *  the hellgate so `box up`'s launch-config construction can be observed WITHOUT
 *  a RunInstances call. (This seam is not optional hygiene: writing the R1/R2
 *  hellgate against the un-injected root provisioned ten live spot boxes.) */
export type ProvisionBoxPort = typeof provisionBox

export interface CmdBoxDeps {
  readonly provision?: ProvisionBoxPort
}

const cmdBoxUp = async (runConfig: BenchRunConfig, provision: ProvisionBoxPort): Promise<void> => {
  const amiOverride = argValue("--ami") ?? process.env.QUANTA_FULL_REMOTE_AMI
  logger.info("[box] provisioning + bootstrapping ONE warm box (left alive for reuse)…")
  const session = await provision({
    repoDir: process.cwd(),
    authJson: "{}", // no patch-gen here; pool ships the real token per chunk
    datasetPath: "",
    launchMode: "warm-box",
    // aug-22 re-audit R1 — thread the TYPED family onto the launch config.
    // `bootstrapBox` picks the swebench pip-spec / grading shim and runs the
    // family profile's `setupBox` port off THIS field. It used to read
    // `?? process.env.QUANTA_SWEBENCH_DATASET_FAMILY`; the T2 repair deleted that
    // ambient tail without giving `box` a typed thread, so `box up` silently
    // downgraded a Pro/Live box to Verified (stock harness, no Pro bootstrap).
    //
    // Set ONLY for an EXPLICIT selector: `undefined` means "the operator selected
    // nothing", which is what keeps the downstream subprocess wire byte-identical
    // to HEAD (see `buildSubprocessFamilyEnv`).
    ...(runConfig.familySelector === "explicit"
      ? { swebenchDatasetFamily: runConfig.datasetFamily }
      : {}),
    ...(amiOverride !== undefined && amiOverride !== "" ? { ami: amiOverride } : {}),
    onDemand: gateOn(process.env, "QUANTA_FULL_REMOTE_ONDEMAND"),
    keep: true, // leave it alive — that is the whole point of `box up`
    onLog: (m) => logger.info(m),
  })
  logger.info(
    `[box] WARM box ready: ${session.iid} (${session.ip}) — pool will reuse it. TTL self-terminates.`,
  )
}

/** aug-22 re-audit R2 — resolve the SWE-suite run config at the BOX composition
 *  root, fail-closed, exactly like `run` / `grade` / `pool` / `bestk-passk`.
 *  `box` was the one family-BEARING subcommand with no family gate at all: it
 *  neither parsed nor validated `--dataset-family`, so `box up --dataset-family
 *  prow` provisioned (and paid for) a Verified box in silence. Resolved at the
 *  ROOT rather than inside `up` so an operator who typo'd the selector is told
 *  so on every `box` invocation instead of only the expensive one. */
const resolveBoxRunConfig = (argvFamily: string | undefined): BenchRunConfig => {
  const cfg = resolveBenchmarkRunConfig({ subcommand: "box", argvFamily, env: process.env })
  if (cfg.benchmarkSuite !== "swe-bench") {
    throw new Error("box is the swe-bench composition root")
  }
  return cfg.swe
}

export const cmdBox = async (deps: CmdBoxDeps = {}): Promise<void> => {
  const runConfig = resolveBoxRunConfig(readDatasetFamilySelector(process.argv))
  const region = argValue("--region") ?? process.env.QUANTA_FULL_REMOTE_REGION ?? D.region
  const action = positionals()[0] ?? "ls"
  if (action === "ls") return cmdBoxLs(region)
  if (action === "status") return cmdBoxStatus(region)
  if (action === "logs") return cmdBoxLogs(region)
  if (action === "rm") return cmdBoxRm(region)
  if (action === "up") return cmdBoxUp(runConfig, deps.provision ?? provisionBox)
  logger.info(
    "usage: quanta-bench box <ls [--json]|status [--json]|logs [iid|busy|latest] [--lines N] [--follow|--json]|rm <iid|all>|up>",
  )
  process.exit(2)
}
