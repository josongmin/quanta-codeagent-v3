import { attrs, QUANTA_ATTRS } from "@/observability";
import { ToolRegistry } from "@/tool";
import { createCloseoutGuardState } from "./closeout-guard";
import { createVerifyGuardState } from "./verify-guard";
import { TurnWorkMetricsCollector } from "./work-metrics-collector";
/** Pure construction of the persistence dependency bag from config. Mirrors
 *  the conditional-spread semantics required by `exactOptionalPropertyTypes`
 *  (omit keys entirely, never assign `undefined`). Caller guards `config.store`
 *  presence before invoking `persistSession`. */
export const buildPersistDeps = (config, recorder, redactionEnabled, onRedaction) => ({
    // biome-ignore lint/style/noNonNullAssertion: call site guards `config.store`
    store: config.store,
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
});
/** Reconstruct the `Tool[]` backing a registry (it is construct-only — no
 *  enumerator) so extra tools can be merged into a fresh registry. */
const registryTools = (r) => r
    .specs()
    .map((s) => r.get(s.name))
    .filter((t) => t !== undefined);
/** Fold extra tools (subagent/skill) into a fresh registry. With none
 *  (`extraTools` empty) returns the SAME config by identity, so the loop stays
 *  byte-for-byte identical to the pre-absorption path. */
export const buildEffectiveConfig = (config, extraTools) => extraTools.length > 0
    ? {
        ...config,
        registry: new ToolRegistry([...registryTools(config.registry), ...extraTools]),
    }
    : config;
/** Verify-guard per-run resources (Tier 0 safety hardening). Built when EITHER
 *  `config.verifyGuard` OR `config.closeoutGuard?.enabled === true` is set:
 *  closeout-guard now duck-reads the same tool-history array to route a
 *  code-modification session to the Phase 4 four-truth-surface reminder
 *  (ADR-0019). With NEITHER set ⇒ both `undefined` (no allocation, the
 *  history push + guard decisions are never reached → loop byte-identical).
 *  The `state` (verifyGuardState) stays gated on `verifyGuard` alone. */
export const buildVerifyGuard = (config) => {
    const needHistory = config.verifyGuard !== undefined || config.closeoutGuard?.enabled === true;
    const out = {};
    if (config.verifyGuard)
        out.state = createVerifyGuardState();
    if (needHistory)
        out.history = [];
    return out;
};
/** Closeout reminder per-run resource. Built ONLY when
 *  `config.closeoutGuard?.enabled === true`: a single-shot trip counter.
 *  Absent (or `enabled !== true`) ⇒ `undefined` (no allocation, the guard
 *  decision is never reached → loop byte-identical). Extracted so `runAgent`
 *  gains no extra cognitive-complexity branch — mirrors `buildVerifyGuard`. */
export const buildCloseoutGuard = (config) => config.closeoutGuard?.enabled === true ? createCloseoutGuardState() : undefined;
/** Per-turn work-metrics resources (absorb #6, ADR-0064). Built ONLY when
 *  `cfg.workMetricsSink` is wired. With the sink absent ⇒ both fields stay
 *  `undefined`, no object is allocated, all `collector?.` no-op and the
 *  finalize/emit helper short-circuits → loop byte-for-byte identical.
 *
 *  `turnId` reuses the ADR-0030 `activeTurnRef.currentTurn.turnId` when set
 *  (so a surface that tracks both sees one UUID space); otherwise we mint a
 *  fresh per-turn UUID so the sink ALWAYS gets a stable correlation id.
 *  Extracted so `runAgent` gains no new branch — mirrors `buildVerifyGuard`. */
export const buildWorkMetricsResources = (cfg) => {
    if (cfg.workMetricsSink === undefined)
        return {};
    return {
        collector: new TurnWorkMetricsCollector(),
        turnId: cfg.activeTurnRef?.current.currentTurn?.turnId ?? crypto.randomUUID(),
    };
};
/** Finalize the collector and hand the snapshot to the sink. Skipped when no
 *  sink is wired (default-OFF byte-identical) or when the turn aborted before
 *  any work landed (snapshot is all-zeros → no signal). Extracted so `runAgent`
 *  gains no new branch — mirrors `buildVerifyGuard`/`buildCloseoutGuard`.
 *
 *  TODO(absorb #6 cont.): collect numstat per-turn from git_diff results (or
 *  spawn `git diff --numstat HEAD` here, gated on a git-repo check) so
 *  `diffMap` reflects actual file changes; today it accumulates only when a
 *  future tool routes numstat through `collector.recordDiff(...)`. */
export const emitWorkMetrics = (cfg, collector, turnId, resultKind) => {
    if (cfg.workMetricsSink === undefined ||
        collector === undefined ||
        turnId === undefined ||
        resultKind === "aborted") {
        return;
    }
    const metrics = collector.finalize(cfg.llm.model);
    cfg.workMetricsSink.emit(metrics, { turnId });
};
/** Run-scoped secret-redaction rollup (ADR-0078). Folds every hit
 *  (origin × kind) into a count; the loop surfaces it on `AgentOutcome.redactions`
 *  ONLY when non-empty. Returns the live aggregator plus the `record` sink the
 *  loop threads into dispatch / persist / envelope scan. */
export const createRedactionRollup = () => {
    const agg = new Map();
    const record = (origin, hits) => {
        for (const h of hits) {
            const key = `${origin} ${h.kind}`;
            const cur = agg.get(key);
            agg.set(key, cur ? { ...cur, count: cur.count + 1 } : { origin, kind: h.kind, count: 1 });
        }
    };
    return { agg, record };
};
/** Per-turn correlation context (RFC-0002 §5.1/§5.4). A fresh shallow copy of
 *  the caller's `config.run` with `turn` restamped — so `config.run` is NEVER
 *  mutated. Returns `undefined` when unconfigured (zero overhead, loop
 *  byte-identical). Pure: used only for correlation, never control flow. */
export const stampTurn = (run, turn) => run ? { ...run, turn } : undefined;
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
export const sessionSpanAttrs = (sessionId) => attrs({
    [QUANTA_ATTRS.conversation.id]: sessionId,
    [QUANTA_ATTRS.thread.id]: sessionId,
    [QUANTA_ATTRS.thread.kind]: "main",
});
/** Codex 10-step span tree — turn ring (`session_task.turn`). Opens once per
 *  logical turn (a SAME-TURN retry does NOT open a new span — it stays under
 *  the same turn id, matching Codex's convention). On close, `quanta.turn.
 *  duration_ms` is supplied by `endSpan` itself (computed from monotonic
 *  start), so the close-attrs need only echo the id. */
export const turnSpanAttrs = (turnId) => attrs({
    [QUANTA_ATTRS.turn.id]: turnId,
    [QUANTA_ATTRS.turn.kind]: "main",
});
