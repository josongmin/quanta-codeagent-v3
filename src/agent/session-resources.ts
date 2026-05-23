import { attrs, QUANTA_ATTRS } from "@/observability"
import type { RedactionHit, RedactionOrigin } from "@/security"
import type { RunContext } from "@/shared"
import { type Tool, ToolRegistry } from "@/tool"
import { type CloseoutGuardState, createCloseoutGuardState } from "./closeout-guard"
import { createLocalizePhaseState, type LocalizePhaseState } from "./localize-phase-guard"
import type { PersistDeps } from "./memory"
import type { AgentRecorder } from "./metrics"
import type { AgentConfig, RedactionRollup } from "./types"
import { createVerifyGuardState, type VerifyGuardState } from "./verify-guard"
import { TurnWorkMetricsCollector } from "./work-metrics-collector"

/** Verify-guard history element (Tier 0 safety hardening). A real SWE-bench run proved the
 *  guard fired 0 times because the agent runs a noise `bash` (`git status`/`ls`)
 *  after editing and the old policy counted ANY bash as "verified", defeating
 *  the guard. R1's tightened `decideVerifyGuard` only counts a `bash` as a
 *  verification when its command string matches a test/repro regex — so the
 *  loop MUST carry the bash command string here (it previously pushed only the
 *  name, leaving `arg` always undefined). `arg` is conditionally set for `bash`
 *  ONLY (exactOptionalPropertyTypes: omitted, never `arg: undefined`).
 *
 *  ── mustPass (outcome-gate) extension ──────────────────────────────────────
 *  Presence-only verify-guard (`mustPass:false`) only checks "did a verify-like
 *  call run after the edit?". When the bench `mustPass:true` knob is on, the
 *  guard ALSO consults `ok` and `output` to confirm the verify actually
 *  PASSED — otherwise the model can run `pytest` → see `ok:false` → declare
 *  "done" and the guard would let it. `id` is the dispatch call id used to
 *  back-patch the outcome after async dispatch (the push-on-start path leaves
 *  ok/output absent and the dispatch-resolved path fills them in by id).
 *  ALL of (`id` / `ok` / `output`) are exactOptional: omitted when unknown
 *  (legacy push-only-on-start path), NEVER set to `undefined`. */
export type ToolHistoryEntry = {
  name: string
  arg?: string
  /** Tool call id for backward-patching outcome after async dispatch. */
  id?: string
  /** Outcome (after dispatch resolves). Absent ⇒ still running or legacy path. */
  ok?: boolean
  /** Stdout/stderr preview (already redaction-applied). verify-guard mustPass
   *  scans this for explicit failure markers per ecosystem. Empty/absent ⇒
   *  conservative pass (no override). */
  output?: string
}

/** Pure construction of the persistence dependency bag from config. Mirrors
 *  the conditional-spread semantics required by `exactOptionalPropertyTypes`
 *  (omit keys entirely, never assign `undefined`). Caller guards `config.store`
 *  presence before invoking `persistSession`. */
export const buildPersistDeps = (
  config: AgentConfig,
  recorder: AgentRecorder | undefined,
  redactionEnabled: boolean,
  onRedaction: (origin: RedactionOrigin, hits: readonly RedactionHit[]) => void,
): PersistDeps => ({
  // biome-ignore lint/style/noNonNullAssertion: call site guards `config.store`
  store: config.store!,
  llm: config.llm,
  ...(config.embedder ? { embedder: config.embedder } : {}),
  ...(config.memory?.distill !== undefined ? { distill: config.memory.distill } : {}),
  ...(config.memory?.consolidate !== undefined ? { consolidate: config.memory.consolidate } : {}),
  ...(config.memory?.evictionCaps ? { evictionCaps: config.memory.evictionCaps } : {}),
  ...(recorder ? { onStats: (s) => recorder.memoryPersist(s) } : {}),
  // ADR-0078 point #3 — redact the serialized transcript before the distill LLM
  // call. Disabled ⇒ `redactionDisabled:true` so distillSession skips redaction
  // (acknowledged-risk posture); enabled ⇒ hits fold into the run rollup under
  // the `memory_distill` origin.
  ...(config.redaction?.whitelist ? { redactionWhitelist: config.redaction.whitelist } : {}),
  ...(redactionEnabled ? {} : { redactionDisabled: true }),
  onRedactionHits: (hits) => onRedaction("memory_distill", hits),
  signal: config.signal,
})

/** Reconstruct the `Tool[]` backing a registry (it is construct-only — no
 *  enumerator) so extra tools can be merged into a fresh registry. */
const registryTools = (r: AgentConfig["registry"]): Tool[] =>
  r
    .specs()
    .map((s) => r.get(s.name))
    .filter((t): t is Tool => t !== undefined)

/** Fold extra tools (subagent/skill) into a fresh registry. With none
 *  (`extraTools` empty) returns the SAME config by identity, so the loop stays
 *  byte-for-byte identical to the pre-absorption path. */
export const buildEffectiveConfig = (config: AgentConfig, extraTools: Tool[]): AgentConfig =>
  extraTools.length > 0
    ? {
        ...config,
        registry: new ToolRegistry([...registryTools(config.registry), ...extraTools]),
      }
    : config

/** Verify-guard per-run resources (Tier 0 safety hardening). Built when EITHER
 *  `config.verifyGuard` OR `config.closeoutGuard?.enabled === true` is set:
 *  closeout-guard now duck-reads the same tool-history array to route a
 *  code-modification session to the Phase 4 four-truth-surface reminder
 *  (ADR-0019). With NEITHER set ⇒ both `undefined` (no allocation, the
 *  history push + guard decisions are never reached → loop byte-identical).
 *  The `state` (verifyGuardState) stays gated on `verifyGuard` alone. */
export const buildVerifyGuard = (
  config: AgentConfig,
): { state?: VerifyGuardState; history?: ToolHistoryEntry[] } => {
  const needHistory = config.verifyGuard !== undefined || config.closeoutGuard?.enabled === true
  const out: { state?: VerifyGuardState; history?: ToolHistoryEntry[] } = {}
  if (config.verifyGuard) out.state = createVerifyGuardState()
  if (needHistory) out.history = []
  return out
}

/** Localize-phase per-run resource (Agentless absorption — Tier 0). Built
 *  ONLY when `config.localizePhase.phase1Turns` is a positive integer (the
 *  ACTIVE configuration domain — anything else means the guard is OFF, see
 *  `localize-phase-guard.ts#isActivePhase1Turns`). Absent / invalid ⇒
 *  `undefined` (no allocation, the dispatch consult is a single property
 *  check + early return → byte-identical loop). The loop bumps `state.turn`
 *  at the TOP of each turn (0-indexed). Mirrors `buildVerifyGuard`. */
export const buildLocalizePhase = (config: AgentConfig): LocalizePhaseState | undefined => {
  const n = config.localizePhase?.phase1Turns
  if (typeof n !== "number") return undefined
  if (!Number.isFinite(n)) return undefined
  if (!Number.isInteger(n)) return undefined
  if (n < 1) return undefined
  return createLocalizePhaseState()
}

/** Closeout reminder per-run resource. Built ONLY when
 *  `config.closeoutGuard?.enabled === true`: a single-shot trip counter.
 *  Absent (or `enabled !== true`) ⇒ `undefined` (no allocation, the guard
 *  decision is never reached → loop byte-identical). Extracted so `runAgent`
 *  gains no extra cognitive-complexity branch — mirrors `buildVerifyGuard`. */
export const buildCloseoutGuard = (config: AgentConfig): CloseoutGuardState | undefined =>
  config.closeoutGuard?.enabled === true ? createCloseoutGuardState() : undefined

/** Per-turn work-metrics resources (absorb #6, ADR-0064). Built ONLY when
 *  `cfg.workMetricsSink` is wired. With the sink absent ⇒ both fields stay
 *  `undefined`, no object is allocated, all `collector?.` no-op and the
 *  finalize/emit helper short-circuits → loop byte-for-byte identical.
 *
 *  `turnId` reuses the ADR-0030 `activeTurnRef.currentTurn.turnId` when set
 *  (so a surface that tracks both sees one UUID space); otherwise we mint a
 *  fresh per-turn UUID so the sink ALWAYS gets a stable correlation id.
 *  Extracted so `runAgent` gains no new branch — mirrors `buildVerifyGuard`. */
export const buildWorkMetricsResources = (
  cfg: AgentConfig,
): { collector?: TurnWorkMetricsCollector; turnId?: string } => {
  if (cfg.workMetricsSink === undefined) return {}
  return {
    collector: new TurnWorkMetricsCollector(),
    turnId: cfg.activeTurnRef?.current.currentTurn?.turnId ?? crypto.randomUUID(),
  }
}

/** Finalize the collector and hand the snapshot to the sink. Skipped when no
 *  sink is wired (default-OFF byte-identical) or when the turn aborted before
 *  any work landed (snapshot is all-zeros → no signal). Extracted so `runAgent`
 *  gains no new branch — mirrors `buildVerifyGuard`/`buildCloseoutGuard`.
 *
 *  TODO(absorb #6 cont.): collect numstat per-turn from git_diff results (or
 *  spawn `git diff --numstat HEAD` here, gated on a git-repo check) so
 *  `diffMap` reflects actual file changes; today it accumulates only when a
 *  future tool routes numstat through `collector.recordDiff(...)`. */
export const emitWorkMetrics = (
  cfg: AgentConfig,
  collector: TurnWorkMetricsCollector | undefined,
  turnId: string | undefined,
  resultKind: "tools" | "completed" | "aborted" | "error" | "refusal",
): void => {
  if (
    cfg.workMetricsSink === undefined ||
    collector === undefined ||
    turnId === undefined ||
    resultKind === "aborted"
  ) {
    return
  }
  const metrics = collector.finalize(cfg.llm.model)
  cfg.workMetricsSink.emit(metrics, { turnId })
}

/** Run-scoped secret-redaction rollup (ADR-0078). Folds every hit
 *  (origin × kind) into a count; the loop surfaces it on `AgentOutcome.redactions`
 *  ONLY when non-empty. Returns the live aggregator plus the `record` sink the
 *  loop threads into dispatch / persist / envelope scan. */
export const createRedactionRollup = (): {
  agg: Map<string, RedactionRollup>
  record: (origin: RedactionOrigin, hits: readonly RedactionHit[]) => void
} => {
  const agg = new Map<string, RedactionRollup>()
  const record = (origin: RedactionOrigin, hits: readonly RedactionHit[]): void => {
    for (const h of hits) {
      const key = `${origin} ${h.kind}`
      const cur = agg.get(key)
      agg.set(key, cur ? { ...cur, count: cur.count + 1 } : { origin, kind: h.kind, count: 1 })
    }
  }
  return { agg, record }
}

/** Per-turn correlation context (RFC-0002 §5.1/§5.4). A fresh shallow copy of
 *  the caller's `config.run` with `turn` restamped — so `config.run` is NEVER
 *  mutated. Returns `undefined` when unconfigured (zero overhead, loop
 *  byte-identical). Pure: used only for correlation, never control flow. */
export const stampTurn = (run: RunContext | undefined, turn: number): RunContext | undefined =>
  run ? { ...run, turn } : undefined

/** Codex 10-step span tree — outer-most ring (`session_loop`). Default-OFF:
 *  when no {@link SpanSink} is registered, both `startSpan` / `endSpan` return
 *  the shared no-op sentinel — zero allocations, the loop is byte-identical
 *  to the pre-span path. `attrs` use canonical {@link QUANTA_ATTRS} keys
 *  (no raw strings — the vocabulary-orphan scan enforces this).
 *
 *  Session-id semantics: the sessionId IS the conversation/thread anchor for
 *  this run (mirrors how `quanta.thread.id` was already populated by the
 *  side-conversation absorption — see vocabulary.ts comments).
 *  `quanta.thread.kind` is `"main"` here; subagent/side-conv spans set their
 *  own kind. */
export const sessionSpanAttrs = (sessionId: string): ReturnType<typeof attrs> =>
  attrs({
    [QUANTA_ATTRS.conversation.id]: sessionId,
    [QUANTA_ATTRS.thread.id]: sessionId,
    [QUANTA_ATTRS.thread.kind]: "main",
  })

/** Codex 10-step span tree — turn ring (`session_task.turn`). Opens once per
 *  logical turn (a SAME-TURN retry does NOT open a new span — it stays under
 *  the same turn id, matching Codex's convention). On close, `quanta.turn.
 *  duration_ms` is supplied by `endSpan` itself (computed from monotonic
 *  start), so the close-attrs need only echo the id. */
export const turnSpanAttrs = (turnId: string): ReturnType<typeof attrs> =>
  attrs({
    [QUANTA_ATTRS.turn.id]: turnId,
    [QUANTA_ATTRS.turn.kind]: "main",
  })
