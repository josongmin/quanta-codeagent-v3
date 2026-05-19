/**
 * Bench observability helpers (RFC-0002 §8, Wave D).
 *
 * Bench is the producer of *non-agent* evidence (`sandbox`, `patch_generated`,
 * `verify`). The agent loop's `AgentEvent` stream is normalized by the
 * stream-slice {@link JsonlRecorder} (W-B). Those bench kinds are NOT
 * `AgentEvent`s, so they cannot flow through the recorder's `emit`; we instead
 * construct them with `@/shared` {@link makeEvent} and append, JSON-line per
 * event, to the SAME attempt file.
 *
 * ── Design: one file, two seq subspaces ───────────────────────────────────
 * `JsonlRecorder` owns its `seq` privately (process-monotonic, 0-based) and is
 * not ours to modify. To keep both writers' lines individually monotonic AND
 * collision-free in one file, bench kinds use a reserved high seq base
 * ({@link BENCH_SEQ_BASE}). Ordering within each producer is preserved; probe
 * (RFC §7) treats `seq` as a per-producer monotonic key, not a global join, so
 * a coherent timeline is still reconstructable. This is the documented seam
 * the brief sanctions ("thin observe.ts helper using makeEvent ... appending
 * through the same file").
 *
 * ── Strict (eval) failure semantics ───────────────────────────────────────
 * Bench runs `strict:true` (RFC §3 원칙2). Any append/serialize failure here
 * rethrows so the runner can mark the instance `verdict:"degraded"` and
 * exclude it from `resolved/total` (RFC §3/§8/§12).
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { costUsd, Metrics, PRICING_VERSION } from "@/observability"
import type { PatchData, RunContext, SandboxData, VerifyData } from "@/shared"
import { makeEvent, redactValue } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { JsonlRecorder } from "@/stream"
import type { InstanceResult, InstanceUsage } from "./types"

/**
 * Passive `StreamPort` that rolls up LLM `usage` events into a per-instance
 * total (last `model` wins). Pure side-effect-free observer — never throws,
 * never alters the event (RFC §3 원칙2: observation must not change behavior).
 */
export class UsageTap implements StreamPort {
  private model = ""
  private inputTokens = 0
  private outputTokens = 0
  private seen = false

  emit(event: AgentEvent): void {
    if (event.type !== "usage") return
    this.seen = true
    this.model = event.model
    this.inputTokens += event.inputTokens
    this.outputTokens += event.outputTokens
  }

  total(): InstanceUsage | undefined {
    if (!this.seen) return undefined
    return {
      model: this.model,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    }
  }
}

/** Per-attempt observation handle the runner threads into a single instance. */
export interface AttemptObservation {
  /** Absolute observe root (`--observe-dir` / `QUANTA_OBSERVE_DIR`). */
  dir: string
  /** One bench run (groups all instances/attempts). */
  runId: string
  /** Best-of-N attempt index (0-based). Default 0. */
  attempt?: number
  /** Wall-clock epoch ms (inject for determinism). Default `Date.now`. */
  now?: () => number
}

/** Run-level observation handle for {@link finalizeRun}. */
export interface RunObservation {
  dir: string
  runId: string
  now?: () => number
}

/**
 * Reserved seq base for bench-produced kinds so they never collide with the
 * recorder's 0-based agent seqs while staying individually monotonic.
 */
export const BENCH_SEQ_BASE = 1_000_000

const tail = (s: string, n = 2000): string => (s.length <= n ? s : s.slice(-n))

/**
 * Owns the per-attempt trajectory file. The agent's `AgentEvent` stream goes
 * through {@link JsonlRecorder} (wrapped by the runner in a `TeeStream`);
 * bench kinds are appended here. Both target the same `<id>.<attempt>.jsonl`.
 */
export class BenchObserver {
  readonly recorder: JsonlRecorder
  private readonly file: string
  private readonly ctx: RunContext
  private readonly now: () => number
  private seq = BENCH_SEQ_BASE

  constructor(obs: AttemptObservation, instanceId: string) {
    const attempt = obs.attempt ?? 0
    this.now = obs.now ?? (() => Date.now())
    this.ctx = { runId: obs.runId, instanceId, attempt }
    this.file = join(obs.dir, obs.runId, `${instanceId}.${attempt}.jsonl`)
    mkdirSync(dirname(this.file), { recursive: true })
    this.recorder = new JsonlRecorder(this.file, {
      ctx: this.ctx,
      strict: true,
      now: this.now,
    })
  }

  /** Append a bench-produced trajectory line. Strict: rethrows on failure so
   *  the caller can mark the instance degraded. */
  private append(
    kind: "sandbox" | "patch_generated" | "verify",
    data: Record<string, unknown>,
  ): void {
    const event = makeEvent(this.seq++, kind, this.ctx, data, { ts: this.now() })
    appendFileSync(this.file, `${JSON.stringify(event)}\n`)
  }

  sandbox(data: SandboxData): void {
    this.append("sandbox", { ...data })
  }

  patchGenerated(data: PatchData): void {
    this.append("patch_generated", { ...data })
  }

  verify(data: VerifyData): void {
    this.append("verify", { ...data })
  }

  /** Flush the agent-stream recorder. Best-effort; never throws. */
  close(): void {
    try {
      this.recorder.close()
    } catch {
      // recorder.close only flushes; a flush failure was already surfaced
    }
  }
}

/** Count files-changed / hunks from a unified `git diff` (empty ⇒ 0/0). */
export const countDiff = (diff: string): { filesChanged: number; hunks: number } => {
  if (diff.trim() === "") return { filesChanged: 0, hunks: 0 }
  let filesChanged = 0
  let hunks = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) filesChanged += 1
    else if (line.startsWith("@@ ")) hunks += 1
  }
  return { filesChanged, hunks }
}

/** Bound a verify log to a tail so JSONL stays small (RFC §12). */
export const verifyLogTail = (log: string | undefined): string => tail(log ?? "")

interface SummaryInstance {
  id: string
  passed: boolean
  verdict: "ok" | "degraded"
  turns: number
  patchPath?: string
}

export interface RunSummary {
  runId: string
  /** Resolved among NON-degraded instances (RFC §3/§12). */
  resolved: number
  /** Non-degraded instance count (the eval denominator). */
  total: number
  /** Instances whose observation failed in strict mode. */
  degraded: number
  instances: SummaryInstance[]
}

/** Persisted metrics envelope; `pricingVersion` stamped for re-derivation. */
export interface MetricsArtifact {
  runId: string
  pricingVersion: typeof PRICING_VERSION
  snapshot: ReturnType<Metrics["snapshot"]>
}

const verdictOf = (r: InstanceResult): "ok" | "degraded" => r.verdict ?? "ok"

/**
 * C8 — THE single operator-visible denominator (ADR-0010 strict→degraded).
 * `verdict:"degraded"` instances are EXCLUDED from both numerator and
 * denominator. `index.ts printSummary` and `report.ts` MUST consume this so
 * the headline `resolved/total` can never contradict `summary.json`. Do not
 * add a third source of truth.
 */
export const resolvedTotals = (
  results: readonly InstanceResult[],
): { resolved: number; total: number; degraded: number } => {
  const ok = results.filter((r) => verdictOf(r) === "ok")
  return {
    resolved: ok.filter((r) => r.passed).length,
    total: ok.length,
    degraded: results.length - ok.length,
  }
}

const summarize = (runId: string, results: readonly InstanceResult[]): RunSummary => {
  const instances: SummaryInstance[] = results.map((r) => ({
    id: r.id,
    passed: r.passed,
    verdict: verdictOf(r),
    turns: r.turns,
    ...(r.patchPath !== undefined ? { patchPath: r.patchPath } : {}),
  }))
  const t = resolvedTotals(results)
  return {
    runId,
    resolved: t.resolved,
    total: t.total,
    degraded: t.degraded,
    instances,
  }
}

/**
 * Build a {@link Metrics} snapshot from per-instance results. Records turns /
 * passed / durationMs / token usage and `costUsd` (stamped with
 * {@link PRICING_VERSION}). Pure derivation — the trajectory is the source of
 * truth (RFC §3 원칙1).
 */
const buildMetrics = (results: readonly InstanceResult[]): Metrics => {
  const m = new Metrics()
  const ok = results.filter((r) => verdictOf(r) === "ok")
  m.counter("instances").inc(ok.length)
  m.counter("degraded").inc(results.length - ok.length)
  for (const r of ok) {
    if (r.passed) m.counter("passed").inc()
    m.timer("turns").record(r.turns)
    if (r.durationMs !== undefined) m.timer("durationMs").record(r.durationMs)
    if (r.usage) {
      m.counter("inputTokens").inc(r.usage.inputTokens)
      m.counter("outputTokens").inc(r.usage.outputTokens)
      const c = costUsd(r.usage.model, r.usage.inputTokens, r.usage.outputTokens)
      if (c !== null) m.gauge("costUsdMilli").set(Math.round(c * 1000))
    }
  }
  return m
}

/** Persist a JSON artifact. S2: the payload is run through the single-source
 *  @/shared redactor first — a secret that reached a path/id/log field (e.g. a
 *  token in a patchPath or verify logTail) must not land raw in
 *  metrics.json/summary.json. Shape is preserved; only secret values mask. */
const writeJson = (file: string, value: unknown): void => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(redactValue(value), null, 2)}\n`)
}

/**
 * Run end (RFC §8): write `<observeDir>/<runId>/metrics.json` and
 * `summary.json`. Derived artifacts probe consumes; never throws. Returns the
 * summary so callers/tests can assert resolved/total/degraded.
 */
export const finalizeRun = async (
  obs: RunObservation,
  results: readonly InstanceResult[],
): Promise<RunSummary> => {
  const summary = summarize(obs.runId, results)
  const runDir = join(obs.dir, obs.runId)
  const metrics: MetricsArtifact = {
    runId: obs.runId,
    pricingVersion: PRICING_VERSION,
    snapshot: buildMetrics(results).snapshot(),
  }
  writeJson(join(runDir, "metrics.json"), metrics)
  writeJson(join(runDir, "summary.json"), summary)
  return summary
}
