/** Hard cap so probe can never present a hypothesis as a certainty. */
const MAX_CONFIDENCE = 0.9;
const dataStr = (e, key) => {
    const v = e.data[key];
    return typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
};
const lastOf = (events, kind) => {
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e !== undefined && e.kind === kind)
            return e;
    }
    return undefined;
};
const sessionEndReason = (events) => dataStr(lastOf(events, "session_end") ?? { data: {} }, "reason");
const failedToolCount = (events) => events.filter((e) => e.kind === "tool_result" && e.data.ok === false).length;
const truncate = (s, n = 240) => (s.length <= n ? s : `${s.slice(0, n)}…`);
const verifyEvidence = (events) => {
    const v = lastOf(events, "verify");
    if (v === undefined)
        return ["no verify event found"];
    const failed = dataStr(v, "failedTests");
    return [
        `verify.passed=false (exit ${dataStr(v, "exitCode") || "?"})`,
        failed ? `failedTests=${truncate(failed)}` : "failedTests=[]",
        `logTail=${truncate(dataStr(v, "logTail"))}`,
        `reportPath=${dataStr(v, "reportPath") || "(none)"}`,
    ];
};
const errorEvidence = (events) => {
    const err = lastOf(events, "error");
    return [`last error: ${truncate(dataStr(err ?? { data: {} }, "message"))}`];
};
const toolLoopEvidence = (events) => {
    const n = failedToolCount(events);
    const last = [...events].reverse().find((e) => e.kind === "tool_result" && e.data.ok === false);
    return [
        `${n} failed tool_result(s)`,
        `last failing tool=${dataStr(last ?? { data: {} }, "name") || "?"}`,
        `tail=${truncate(dataStr(last ?? { data: {} }, "stdoutTail"))}`,
    ];
};
/**
 * Rule table, highest priority first. Verify/patch signals are the most
 * specific, then loop/error/limit/abort; "no patch at all" is the catch-all
 * failure before we fall back to "unknown".
 */
const RULES = [
    {
        cls: "verify_failed",
        confidence: 0.85,
        match: (e) => e.some((x) => x.kind === "verify" && x.data.passed === false),
        hint: () => "verify reported failing tests, which likely means the patch did not fix the bug",
        evidence: verifyEvidence,
    },
    {
        cls: "patch_rejected",
        confidence: 0.8,
        match: (e) => e.some((x) => x.kind === "patch_rejected"),
        hint: () => "a patch_rejected event suggests the generated diff failed to apply cleanly",
        evidence: (e) => {
            const p = lastOf(e, "patch_rejected");
            return [
                `applyStatus=${dataStr(p ?? { data: {} }, "applyStatus") || "?"}`,
                `filesChanged=${dataStr(p ?? { data: {} }, "filesChanged") || "0"}`,
            ];
        },
    },
    {
        cls: "aborted",
        confidence: 0.7,
        match: (e) => /abort|cancel|signal/i.test(sessionEndReason(e)),
        hint: () => "the session_end reason suggests the run was aborted before completing",
        evidence: (e) => [`session_end reason=${sessionEndReason(e) || "(none)"}`],
    },
    {
        cls: "max_turns",
        confidence: 0.75,
        match: (e) => /max.?turns|turn.?limit/i.test(sessionEndReason(e)),
        hint: () => "the run appears to have hit the max-turns limit before producing a fix",
        evidence: (e) => [
            `session_end reason=${sessionEndReason(e)}`,
            `turns=${dataStr(lastOf(e, "session_end") ?? { data: {} }, "turns")}`,
        ],
    },
    {
        cls: "tool_error_loop",
        confidence: 0.6,
        match: (e) => failedToolCount(e) >= 3,
        hint: () => "repeated failing tool calls suggest the agent may have been stuck in an error loop",
        evidence: toolLoopEvidence,
    },
    {
        cls: "llm_error",
        confidence: 0.65,
        match: (e) => e.some((x) => x.kind === "error") || /error/i.test(sessionEndReason(e)),
        hint: () => "an error event suggests the run likely failed due to an LLM or runtime error",
        evidence: errorEvidence,
    },
    {
        cls: "no_patch",
        confidence: 0.55,
        match: (e) => e.length > 0 && !e.some((x) => x.kind === "patch_generated"),
        hint: () => "no patch_generated event was found, which suggests the agent may not have produced a fix",
        evidence: (e) => [
            `events=${e.length}`,
            `session_end reason=${sessionEndReason(e) || "(none)"}`,
            "no patch_generated event present",
        ],
    },
];
const UNKNOWN = {
    likely_failure_class: "unknown",
    confidence: 0.15,
    triage_hint: "the trajectory does not match a known failure signature; this is only a low-confidence hypothesis and a human should review the evidence",
    evidence: ["no decisive failure signal (no verify/patch_rejected/error/limit)"],
};
/**
 * Classify a trajectory into a hedged hypothesis. Pure and deterministic.
 * First matching rule wins (RULES is priority-ordered). Confidence is always
 * clamped to (0, {@link MAX_CONFIDENCE}] — probe never certifies a cause.
 */
export const triage = (events) => {
    if (events.length === 0)
        return { ...UNKNOWN, evidence: ["empty trajectory (no events)"] };
    for (const rule of RULES) {
        if (!rule.match(events))
            continue;
        return {
            likely_failure_class: rule.cls,
            confidence: Math.min(MAX_CONFIDENCE, rule.confidence),
            triage_hint: rule.hint(events),
            evidence: rule.evidence(events),
        };
    }
    return UNKNOWN;
};
