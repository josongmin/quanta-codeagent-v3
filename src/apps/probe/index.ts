/**
 * `bun run probe <run-dir | trajectory.jsonl> [--instance ID] [--failed]
 *  [--slow] [--cost] [--funnel] [--json]` — RFC-0002 §7, Wave E.
 *
 * READ-ONLY, NON-authoritative inspector (RFC §1.2 / §3 원칙8). Never writes
 * or deletes anything; never crashes on malformed input (degrades with a clear
 * message). Exit 0 on success; exit 1 ONLY on a usage error (bad/missing path
 * or no argument). `main(argv)` is exported so tests invoke it directly.
 */
import type { TrajectoryEvent } from "@/shared"
import { errMessage, logger, setTerminalIo } from "@/shared"
import { observeFunnel, renderFunnel } from "./funnel"
import { type AttemptTraj, loadRun, type ParsedRun, type RunSummaryLike } from "./parse"
import { costJson, renderCost, renderHotspots, renderTimeline } from "./render"
import { triage } from "./triage"

setTerminalIo({
  stdout: (chunk) => {
    void process.stdout.write(chunk)
  },
  stderr: (chunk) => {
    void process.stderr.write(chunk)
  },
  stdoutIsTTY: process.stdout.isTTY,
  stderrIsTTY: process.stderr.isTTY,
})

interface Args {
  path?: string
  instance?: string
  failed: boolean
  slow: boolean
  cost: boolean
  funnel: boolean
  json: boolean
}

const flagValue = (argv: string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

const parseArgs = (argv: string[]): Args => {
  const positional = argv.find(
    (a) => !a.startsWith("-") && argv[argv.indexOf(a) - 1] !== "--instance",
  )
  const instance = flagValue(argv, "--instance")
  return {
    ...(positional !== undefined ? { path: positional } : {}),
    ...(instance !== undefined ? { instance } : {}),
    failed: argv.includes("--failed"),
    slow: argv.includes("--slow"),
    cost: argv.includes("--cost"),
    funnel: argv.includes("--funnel"),
    json: argv.includes("--json"),
  }
}

const emit = (s: string): void => {
  process.stdout.write(`${s}\n`)
}

/** Flatten one instance's attempts into a single seq-ordered event list. */
const eventsOf = (attempts: AttemptTraj[]): TrajectoryEvent[] =>
  attempts.flatMap((a) => a.parsed.events).sort((x, y) => x.seq - y.seq)

const selectInstances = (run: ParsedRun, only?: string): Array<[string, AttemptTraj[]]> => {
  const all = [...run.instances.entries()].sort()
  return only === undefined ? all : all.filter(([id]) => id === only)
}

const isFailed = (summary: RunSummaryLike | undefined, id: string): boolean => {
  const hit = summary?.instances?.find((i) => i.id === id)
  if (hit === undefined) return true // no summary ⇒ inspect all (can't prove pass)
  return hit.passed !== true || hit.verdict === "degraded"
}

const scoreLine = (summary: RunSummaryLike | undefined): string | undefined => {
  const score = summary?.score
  if (score === undefined) return undefined
  const total = summary?.total ?? 0
  return (
    `score official_harness ${score.officialHarness ?? 0}/${total} ` +
    `(${score.officialResolvedPct ?? 0}%) | local_structural ${score.localStructural ?? 0} | ` +
    `research_contaminated ${score.researchContaminated ?? 0} | unlabeled_passed ${score.unlabeledPassed ?? 0}`
  )
}

const skippedTotal = (run: ParsedRun): number => {
  let n = 0
  for (const list of run.instances.values()) for (const a of list) n += a.parsed.skipped
  return n
}

const renderOverview = (run: ParsedRun, args: Args): void => {
  const s = run.summary
  emit(`run ${run.runId ?? "(unknown id)"}`)
  if (s !== undefined) {
    emit(`passed ${s.resolved ?? 0}/${s.total ?? 0} (${s.degraded ?? 0} degraded)`)
    const line = scoreLine(s)
    if (line !== undefined) emit(line)
  }
  for (const [id, attempts] of selectInstances(run, args.instance)) {
    const hit = s?.instances?.find((i) => i.id === id)
    const passed = hit?.passed
    const mark = passed === true ? "PASS" : passed === false ? "FAIL" : "----"
    const score = hit?.scoreLabel !== undefined ? `[${hit.scoreLabel}]` : ""
    emit(`  [${mark}]${score} ${id} (${attempts.length} attempt(s))`)
  }
  const skipped = skippedTotal(run)
  if (skipped > 0) emit(`note: skipped ${skipped} unparseable/foreign line(s)`)
  for (const w of run.warnings) emit(`warning: ${w}`)
}

const renderTriage = (run: ParsedRun, args: Args): void => {
  emit("triage (NON-authoritative hypotheses — verify the evidence yourself):")
  for (const [id, attempts] of selectInstances(run, args.instance)) {
    if (!isFailed(run.summary, id)) continue
    const t = triage(eventsOf(attempts))
    emit(`  ${id}: likely=${t.likely_failure_class} confidence≈${t.confidence.toFixed(2)}`)
    emit(`    hint: ${t.triage_hint}`)
    for (const e of t.evidence) emit(`    evidence: ${e}`)
  }
}

/** Project W-D summary into a certainty-free shape (drop `verdict` etc.). */
const summaryJson = (s: RunSummaryLike | undefined): unknown => {
  if (s === undefined) return null
  return {
    resolved: s.resolved ?? 0,
    total: s.total ?? 0,
    degraded: s.degraded ?? 0,
    ...(s.score !== undefined ? { score: s.score } : {}),
    instances: (s.instances ?? []).map((i) => ({
      id: i.id,
      passed: i.passed === true,
      turns: i.turns ?? 0,
      ...(i.scoreLabel !== undefined ? { scoreLabel: i.scoreLabel } : {}),
    })),
  }
}

const buildJson = (run: ParsedRun, args: Args): unknown => {
  const instances = selectInstances(run, args.instance).map(([id, attempts]) => ({
    instanceId: id,
    attempts: attempts.length,
    skipped: attempts.reduce((n, a) => n + a.parsed.skipped, 0),
    ...(args.failed ? { triage_hypothesis: triage(eventsOf(attempts)) } : {}),
  }))
  return {
    runId: run.runId ?? null,
    summary: summaryJson(run.summary),
    cost: costJson(run.instances),
    instances,
    warnings: run.warnings,
  }
}

/** Funnel-adherence view: per-instance 3-stage localization observation. */
const renderFunnelView = (run: ParsedRun, args: Args): void => {
  emit("localization funnel (NON-authoritative — a low stage is not a defect):")
  for (const [id, attempts] of selectInstances(run, args.instance)) {
    const report = observeFunnel(eventsOf(attempts))
    emit(`  ${id}:`)
    for (const line of renderFunnel(report).split("\n")) emit(`  ${line}`)
  }
}

/** A single-attempt path with no summary ⇒ behave as a single trajectory. */
const renderSingle = (run: ParsedRun, args: Args): void => {
  const attempts = [...run.instances.values()][0] ?? []
  const events = eventsOf(attempts)
  if (args.slow) emit(renderHotspots(events))
  else if (args.cost) emit(renderCost(run.instances, run.summary))
  else if (args.funnel) emit(renderFunnel(observeFunnel(events)))
  else if (args.failed) renderTriage(run, args)
  else emit(renderTimeline(events))
}

/**
 * Probe entrypoint. Returns the process exit code (0 ok, 1 usage error).
 * Never throws — malformed input degrades to a clear message.
 */
export const main = async (argv: string[]): Promise<number> => {
  const args = parseArgs(argv)
  if (args.path === undefined) {
    logger.error(
      "usage: probe <run-dir | trajectory.jsonl> [--instance ID] [--failed] [--slow] [--cost] [--funnel] [--json]",
    )
    return 1
  }
  let run: ParsedRun
  try {
    run = loadRun(args.path)
  } catch (e) {
    logger.error(`probe: ${errMessage(e)}`)
    return 1
  }
  if (run.instances.size === 0) {
    logger.error(`probe: nothing to inspect at "${args.path}"`)
    for (const w of run.warnings) logger.error(`  ${w}`)
    return 1
  }

  if (args.json) {
    emit(JSON.stringify(buildJson(run, args), null, 2))
    return 0
  }
  const single = run.instances.size === 1 && run.summary === undefined
  if (single) {
    renderSingle(run, args)
    return 0
  }
  if (args.slow) {
    for (const [, attempts] of selectInstances(run, args.instance)) {
      emit(renderHotspots(eventsOf(attempts)))
    }
    return 0
  }
  if (args.cost) {
    emit(renderCost(run.instances, run.summary))
    return 0
  }
  if (args.funnel) {
    renderFunnelView(run, args)
    return 0
  }
  if (args.failed) {
    renderTriage(run, args)
    return 0
  }
  renderOverview(run, args)
  return 0
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
