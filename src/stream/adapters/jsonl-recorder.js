import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { assertNever, errMessage, logger, makeEvent, toError } from "@/shared";
const DEFAULT_MAX_LINES = 100_000;
const FLUSH_BATCH = 16;
const EMPTY_CTX = { runId: "unknown" };
/**
 * Span-correlation scheme (deterministic — golden-testable, no randomness):
 *
 *  - `turn_start` opens a new turn span `t<turn>` (falls back to `t#<seq>` if
 *    the AgentEvent carries no turn). Every later event in that turn carries
 *    `parentSpanId = turnSpanId`.
 *  - `tool_call` / `tool_progress` / `tool_result` sharing a tool-use `id`
 *    all get `spanId = "tool:" + id` with `parentSpanId = turnSpanId`.
 *  - `llm_request` AND `usage` (llm) BOTH get `spanId = "llm:" + turnSpanId`,
 *    `parentSpanId = turnSpanId` — one request→one usage per turn, so the
 *    `llm_request↔llm_usage` span pair (RFC-0002 §5.2/§9/§11) is exact and
 *    deterministic (`request.spanId === usage.spanId`).
 *  - `turn_start` itself is the span root: `spanId = turnSpanId`, no parent.
 *
 * Given an identical event sequence the scheme reproduces byte-identical
 * spans across runs.
 *
 * `costUsd` is always `null` here: the recorder lives in `@/stream` and slice
 * isolation (RFC §6, biome.json) forbids importing `@/observability/pricing`.
 * Cost is derived later by probe/bench, which may import the versioned price
 * table — keeping the trajectory recomputable when prices drift (RFC §5.3).
 */
export class JsonlRecorder {
    target;
    ctx;
    strict;
    now;
    monotonic;
    maxLines;
    producer;
    buf = [];
    seq = 0;
    written = 0;
    turnSpanId = "t#init";
    closed = false;
    capDone = false;
    dropped = 0;
    constructor(target, opts = {}) {
        this.target = target;
        this.ctx = opts.ctx ?? EMPTY_CTX;
        this.strict = opts.strict ?? false;
        this.now = opts.now ?? (() => Date.now());
        this.monotonic = opts.monotonic;
        this.maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
        this.producer = opts.producer;
        mkdirSync(dirname(target), { recursive: true });
    }
    emit(event) {
        if (event.type === "turn_start")
            this.turnSpanId = `t${event.turn}`;
        if (this.written >= this.maxLines) {
            this.handleCap();
            return;
        }
        this.record(kindOf(event), dataOf(event), spanOf(event, this.turnSpanId));
    }
    record(kind, data, span) {
        try {
            const line = JSON.stringify(this.frame(kind, data, span));
            this.writeLine(line);
            this.flushMaybe();
        }
        catch (e) {
            this.degrade(toError(e), this.strict);
        }
    }
    frame(kind, data, span) {
        return makeEvent(this.seq++, kind, this.ctx, data, {
            ts: this.now(),
            ...(this.monotonic ? { monotonicNs: this.monotonic() } : {}),
            ...(span.spanId !== undefined ? { spanId: span.spanId } : {}),
            ...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {}),
            ...(this.producer ? { producer: this.producer } : {}),
        });
    }
    handleCap() {
        if (this.capDone)
            return;
        this.capDone = true;
        this.dropped += 1;
        try {
            const line = JSON.stringify(this.frame("observability_degraded", { component: "JsonlRecorder", reason: "line_cap", droppedEvents: this.dropped }, { spanId: this.turnSpanId }));
            this.writeLine(line);
            this.flush();
        }
        catch {
            // best-effort: the cap line itself is allowed to fail silently
        }
    }
    degrade(err, rethrow) {
        this.dropped += 1;
        if (rethrow)
            throw err;
        this.tryDegradedLine(err.message);
    }
    tryDegradedLine(reason) {
        try {
            const line = JSON.stringify(this.frame("observability_degraded", { component: "JsonlRecorder", reason, droppedEvents: this.dropped }, { spanId: this.turnSpanId }));
            // Best-effort: bypass the (possibly broken) buffered path with a direct
            // append so the trace records that something was dropped.
            appendFileSync(this.target, `${line}\n`);
        }
        catch (e) {
            // R-Phase2 P1-3: never throw to the agent in non-strict mode, but ALSO
            // never silently lose the signal that observability itself is broken.
            // A failed degraded-line append usually means the target file is
            // unwritable (permissions / volume gone / filesystem full); emit a
            // single stderr line so an operator can see "trajectory is now blind".
            logger.warn("jsonl-recorder: degraded-line append failed", {
                reason,
                target: this.target,
                droppedEvents: this.dropped,
                error: errMessage(e),
            });
        }
    }
    /** Buffered append. Monkeypatch target in tests to force write failure. */
    writeLine(line) {
        this.buf.push(`${line}\n`);
        this.written += 1;
    }
    flushMaybe() {
        if (this.buf.length >= FLUSH_BATCH)
            this.flush();
    }
    flush() {
        if (this.buf.length === 0)
            return;
        const chunk = this.buf.join("");
        // Append FIRST, clear only on success. If `appendFileSync` throws (disk
        // full / volume gone / EPERM) the buffered lines stay in `this.buf` so a
        // later `flush()` / `close()` can retry — a write error must never
        // silently drop already-buffered events. The caller's try/catch
        // (`record`) turns the throw into a `degrade()` degraded-line + count.
        appendFileSync(this.target, chunk);
        this.buf.length = 0;
    }
    /** Flush + close. Idempotent. Never throws to the caller: a failed final
     *  flush is downgraded to a best-effort degraded line so close() at the end
     *  of a run can't crash the agent (mirrors the non-strict emit contract). */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            this.flush();
        }
        catch (e) {
            // strict mode still surfaces the failure; non-strict records a degraded
            // line and swallows so a torn-down volume can't fault the shutdown path.
            this.degrade(toError(e), this.strict);
        }
    }
    /** Snapshot of degraded state for the caller. */
    degraded() {
        if (this.dropped === 0)
            return [];
        return [{ component: "JsonlRecorder", reason: "write_failure", count: this.dropped }];
    }
}
const KIND_MAP = {
    session_start: "session_start",
    turn_start: "turn_start",
    llm_request: "llm_request",
    assistant_text: "assistant_text",
    tool_call: "tool_call",
    tool_progress: "tool_progress",
    tool_result: "tool_result",
    recovery: "recovery",
    // ADR-0075: the dedicated `context_compacted` AgentEvent maps onto the
    // existing trajectory `recovery` kind (same family — a same-turn no-progress
    // recovery point) so we DON'T need a new TrajectoryKind (which would
    // ripple through the redaction policy + every probe consumer). The
    // archive-payload fields (fromTurnId/toTurnId/summary/ts/tokens) ride in
    // `data` via `dataOf` and stay 1st-class JSON. The legacy
    // `recovery:{reason:"compact",detail:"proactive"}` line is emitted FIRST
    // at the same loop seam, so a consumer that only watches the legacy
    // channel still sees compactions byte-identically.
    context_compacted: "recovery",
    // ADR-0048: the transient `in_progress` heartbeat maps onto the existing
    // trajectory `recovery` kind (same rationale as `context_compacted` — a
    // same-turn observation point that does NOT warrant a new TrajectoryKind
    // rippling through the redaction policy + every probe consumer). The
    // heartbeat payload (timestamp + optional message/progress) rides in `data`
    // via `dataOf`, tagged `reason:"in_progress"` so it stays greppable.
    in_progress: "recovery",
    // ADR control-op cluster (L3→L4 promotion 2026-05-23): back-pressure +
    // typed-interrupt + subagent-cancel ride the existing `recovery` family
    // — they are same-turn observation points, not new top-level trajectory
    // kinds. Greppable via `reason` discriminant in `data`.
    response_queued: "recovery",
    interrupted: "recovery",
    subagent_cancel: "recovery",
    // Plan-mode cluster (P3, 2026-05-23): plan-lifecycle + user-input
    // checkpoint + mode-transition events all ride the existing `recovery`
    // family — same rationale as `response_queued` / `interrupted` /
    // `subagent_cancel` (same-turn observation point, no new TrajectoryKind
    // rippling through redaction/probe code paths). Greppable via the
    // discriminating `reason` field added in `dataOf`.
    plan_created: "recovery",
    plan_updated: "recovery",
    plan_snapshot: "recovery",
    plan_user_input_requested: "recovery",
    plan_user_input_resolved: "recovery",
    mode_changed: "recovery",
    // ADR-0102 turn-diff cluster: rides the existing `recovery` family for
    // the same reason as the plan/control-op events (same-turn observation
    // point, no new TrajectoryKind rippling through redaction). The diff
    // payload + per-file stats ride in `data` via `dataOf`.
    turn_diff_updated: "recovery",
    error: "error",
    usage: "llm_usage",
    done: "session_end",
};
/** AgentEvent.type → TrajectoryEvent.kind (RFC §5.2 mapping). */
const kindOf = (e) => KIND_MAP[e.type];
/** Project an AgentEvent onto its kind-specific `data` payload. */
const dataOf = (e) => {
    switch (e.type) {
        case "session_start":
            // RFC-0002 §5.2 head marker — minimal payload (no fields mandated).
            return {};
        case "turn_start":
            return { turn: e.turn };
        case "llm_request":
            // RFC-0002 §5.2 llm_request contract: just the model id (scrubbed via
            // the single makeEvent/redactValue source like every other payload).
            return { model: e.model };
        case "assistant_text":
            return { delta: e.delta };
        case "tool_call":
            return { id: e.id, name: e.name, input: e.input };
        case "tool_progress":
            return { id: e.id, name: e.name, message: e.message };
        case "tool_result":
            // RFC-0002 §5.2 ToolResultData: keep name/ok/stdoutTail, add the
            // optional evidence only when the AgentEvent carried it (conditional-set
            // so redaction still flows through the single makeEvent source).
            return {
                name: e.name,
                ok: e.ok,
                stdoutTail: e.preview,
                ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
                ...(e.stderrTail !== undefined ? { stderrTail: e.stderrTail } : {}),
                ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
                ...(e.fullLogPath !== undefined ? { fullLogPath: e.fullLogPath } : {}),
            };
        case "recovery":
            // RFC-0002 §5.2 recovery contract: reason required, detail optional.
            return { reason: e.reason, ...(e.detail !== undefined ? { detail: e.detail } : {}) };
        case "context_compacted":
            // ADR-0075: archive entry payload — fromTurnId..toTurnId + summary +
            // ts + tokens. `reason:"context_compacted"` is added so this
            // recovery-kind line is greppable apart from the legacy
            // `reason:"compact"` line that fires immediately before it.
            return {
                reason: "context_compacted",
                fromTurnId: e.fromTurnId,
                toTurnId: e.toTurnId,
                summary: e.summary,
                ts: e.ts,
                tokens: e.tokens,
            };
        case "in_progress":
            // ADR-0048: heartbeat payload. The two optional-field branches live in
            // `inProgressData` so this case stays a single statement (keeps `dataOf`
            // under the cognitive-complexity budget).
            return inProgressData(e);
        case "error":
            return { message: e.message };
        case "usage":
            return {
                model: e.model,
                inputTokens: e.inputTokens,
                outputTokens: e.outputTokens,
                ...(e.cacheReadTokens !== undefined ? { cacheReadTokens: e.cacheReadTokens } : {}),
                costUsd: null,
            };
        case "response_queued":
            return controlOpQueuedData(e);
        case "interrupted":
            return controlOpInterruptedData(e);
        case "subagent_cancel":
            return controlOpSubagentData(e);
        case "plan_created":
            return planCreatedData(e);
        case "plan_updated":
            return planUpdatedData(e);
        case "plan_snapshot":
            return planSnapshotData(e);
        case "plan_user_input_requested":
            return planUserInputRequestedData(e);
        case "plan_user_input_resolved":
            return planUserInputResolvedData(e);
        case "mode_changed":
            return modeChangedData(e);
        case "turn_diff_updated":
            // ADR-0102 turn-diff payload: stats + diff body. `reason:"turn_diff"`
            // keeps the recovery-kind line greppable apart from real recovery
            // points (mirrors `in_progress` / `response_queued` etc.).
            return {
                reason: "turn_diff",
                turn: e.turn,
                fromSha: e.fromSha,
                toSha: e.toSha,
                filesChanged: e.filesChanged,
                insertions: e.insertions,
                deletions: e.deletions,
                unifiedDiff: e.unifiedDiff,
            };
        case "done":
            return { reason: e.reason, turns: e.turns };
        default:
            // Exhaustiveness pin: a new AgentEvent variant must come back here and
            // declare its trajectory `data` payload — without this the return type
            // would silently widen to include `undefined` (a dropped payload).
            return assertNever(e, "AgentEvent");
    }
};
/** ADR-0048: heartbeat payload — receive-side timestamp + the optional
 *  provider-supplied status/percentage. `reason:"in_progress"` keeps this
 *  recovery-kind line greppable apart from real recovery points. Extracted from
 *  `dataOf` so its switch case stays a single statement. */
const inProgressData = (e) => ({
    reason: "in_progress",
    timestamp: e.timestamp,
    ...(e.message !== undefined ? { message: e.message } : {}),
    ...(e.progress !== undefined ? { progress: e.progress } : {}),
});
/** ADR control-op cluster (L3→L4 promotion 2026-05-23): back-pressure event
 *  payload. `reason` discriminator matches the canonical PausedReason
 *  taxonomy (extended with `control_op_pending`/`safety_review` per
 *  `@/agent/control-op-handler`). Extracted from `dataOf` to keep its switch
 *  case a single statement (cognitive-complexity budget). */
const controlOpQueuedData = (e) => ({
    reason: "response_queued",
    pauseReason: e.reason,
    ...(e.hint !== undefined ? { hint: e.hint } : {}),
});
/** ADR control-op cluster: typed-interrupt observation payload. `reason`
 *  field doubles as discriminator + verbatim cancel reason carrier. */
const controlOpInterruptedData = (e) => ({
    reason: "interrupted",
    source: e.source,
    ...(e.reason !== undefined ? { detail: e.reason } : {}),
});
/** ADR control-op cluster: subagent cancel routing result. Parent turn
 *  KEEPS running — this is observation only, not a finish trigger. */
const controlOpSubagentData = (e) => ({
    reason: "subagent_cancel",
    subagentId: e.subagentId,
    outcome: e.outcome,
    source: e.source,
});
/** Plan-mode cluster (P3): plan_created payload. Inline the plan as a plain
 *  JSON object so consumers can rebuild a `PlanReadonlyMirror` without
 *  re-importing the type. `reason:"plan_created"` matches the recovery-family
 *  discriminator pattern used by response_queued/interrupted/subagent_cancel. */
const planCreatedData = (e) => ({
    reason: "plan_created",
    plan: planToJson(e.plan),
});
/** Plan-mode cluster (P3): plan_updated payload. `version` is the monotonic
 *  plan version after the delta has been applied (so a consumer can detect
 *  out-of-order deliveries by comparing against the previous `plan_updated` /
 *  `plan_snapshot`). */
const planUpdatedData = (e) => ({
    reason: "plan_updated",
    version: e.version,
    delta: deltaToJson(e.delta),
});
/** Plan-mode cluster (P3): plan_snapshot payload (late-attach surface). Same
 *  shape as plan_created; the `reason` discriminator is what tells the two
 *  apart. */
const planSnapshotData = (e) => ({
    reason: "plan_snapshot",
    plan: planToJson(e.plan),
});
/** Plan-mode cluster (P3): user-input request. Emit `choices` only when
 *  provided (exactOptionalPropertyTypes-safe). */
const planUserInputRequestedData = (e) => ({
    reason: "plan_user_input_requested",
    promptId: e.promptId,
    prompt: e.prompt,
    ...(e.choices !== undefined ? { choices: [...e.choices] } : {}),
});
/** Plan-mode cluster (P3): user-input resolved. `text` is emitted only when
 *  present (a `"cancelled"` decision carries no text). */
const planUserInputResolvedData = (e) => ({
    reason: "plan_user_input_resolved",
    promptId: e.promptId,
    decision: e.decision,
    ...(e.text !== undefined ? { text: e.text } : {}),
});
/** Plan-mode cluster (P3): collaboration-mode transition. `reason` is emitted
 *  only when present. */
const modeChangedData = (e) => ({
    reason: "mode_changed",
    from: e.from,
    to: e.to,
    ...(e.reason !== undefined ? { transitionReason: e.reason } : {}),
});
/** Project a PlanReadonlyMirror to a plain JSON object. Pure — no clock, no
 *  IO. Used by `plan_created` and `plan_snapshot` payloads. */
const planToJson = (plan) => ({
    id: plan.id,
    name: plan.name,
    version: plan.version,
    todos: plan.todos.map((t) => ({ id: t.id, title: t.title, status: t.status })),
});
/** Project a PlanDeltaReadonlyMirror to a plain JSON object. Conditional-set
 *  on every optional field so absent fields don't leak as `undefined` into
 *  the JSON line. */
const deltaToJson = (delta) => ({
    kind: delta.kind,
    ...(delta.todoId !== undefined ? { todoId: delta.todoId } : {}),
    ...(delta.todoTitle !== undefined ? { todoTitle: delta.todoTitle } : {}),
    ...(delta.fromStatus !== undefined ? { fromStatus: delta.fromStatus } : {}),
    ...(delta.toStatus !== undefined ? { toStatus: delta.toStatus } : {}),
    ...(delta.fromName !== undefined ? { fromName: delta.fromName } : {}),
    ...(delta.toName !== undefined ? { toName: delta.toName } : {}),
});
/** Deterministic span/parent for an event given the active turn span. */
const spanOf = (e, turnSpanId) => {
    switch (e.type) {
        case "turn_start":
            return { spanId: turnSpanId };
        case "tool_call":
        case "tool_progress":
        case "tool_result":
            return { spanId: `tool:${e.id}`, parentSpanId: turnSpanId };
        // RFC-0002 §5.2/§9/§11 span pair: `llm_request` (pre-stream) and `usage`
        // (post-stream `llm_usage`) of the SAME turn share ONE llm span, so
        // request.spanId === usage.spanId === `llm:${turnSpanId}`, parented at the
        // turn span. One request → one usage per turn keeps the pair unambiguous.
        case "llm_request":
        case "usage":
            return { spanId: `llm:${turnSpanId}`, parentSpanId: turnSpanId };
        default:
            return { parentSpanId: turnSpanId };
    }
};
