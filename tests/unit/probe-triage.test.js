import { describe, expect, test } from "bun:test";
import { makeEvent } from "@/shared";
import { triage } from "../../src/apps/probe/triage";
const CTX = { runId: "r1", instanceId: "i1", attempt: 0 };
let seq = 0;
const ev = (kind, data = {}) => makeEvent(seq++, kind, CTX, data, { ts: 1_700_000_000_000 });
const HEDGED = /likely|suggest|appears|may|hypothes/i;
const assertNonAuthoritative = (r) => {
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(0.9);
    expect(r.triage_hint).toMatch(HEDGED);
    expect(r.evidence.length).toBeGreaterThan(0);
    // No field may imply certainty.
    const keys = Object.keys(r).join(",").toLowerCase();
    expect(keys).not.toMatch(/verdict|definitive|certain|proven|guarantee/);
};
describe("triage — non-authoritative failure hypotheses", () => {
    test("no patch_generated → no_patch", () => {
        const r = triage([
            ev("session_start"),
            ev("turn_start", { turn: 1 }),
            ev("session_end", { reason: "stop", turns: 1 }),
        ]);
        expect(r.likely_failure_class).toBe("no_patch");
        assertNonAuthoritative(r);
    });
    test("patch_rejected event → patch_rejected", () => {
        const r = triage([
            ev("patch_generated", { diffPath: "/d", filesChanged: 1, hunks: 1, applyStatus: "ok" }),
            ev("patch_rejected", { diffPath: "/d", filesChanged: 1, hunks: 1, applyStatus: "rejected" }),
            ev("session_end", { reason: "stop", turns: 2 }),
        ]);
        expect(r.likely_failure_class).toBe("patch_rejected");
        assertNonAuthoritative(r);
    });
    test("verify passed:false → verify_failed", () => {
        const r = triage([
            ev("patch_generated", { diffPath: "/d", filesChanged: 2, hunks: 3, applyStatus: "ok" }),
            ev("verify", {
                command: "pytest",
                exitCode: 1,
                passed: false,
                failedTests: ["test_x"],
                logTail: "AssertionError",
                reportPath: "/r.json",
            }),
            ev("session_end", { reason: "stop", turns: 3 }),
        ]);
        expect(r.likely_failure_class).toBe("verify_failed");
        expect(r.evidence.join(" ")).toMatch(/test_x|AssertionError|\/r\.json/);
        assertNonAuthoritative(r);
    });
    test("session_end reason max_turns → max_turns", () => {
        const r = triage([
            ev("patch_generated", { diffPath: "/d", filesChanged: 1, hunks: 1, applyStatus: "ok" }),
            ev("session_end", { reason: "max_turns", turns: 40 }),
        ]);
        expect(r.likely_failure_class).toBe("max_turns");
        assertNonAuthoritative(r);
    });
    test("repeated tool_result ok:false → tool_error_loop", () => {
        const events = [ev("session_start")];
        for (let i = 0; i < 5; i++) {
            events.push(ev("tool_result", { name: "bash", ok: false, stdoutTail: "boom", durationMs: 5 }));
        }
        events.push(ev("session_end", { reason: "stop", turns: 5 }));
        const r = triage(events);
        expect(r.likely_failure_class).toBe("tool_error_loop");
        assertNonAuthoritative(r);
    });
    test("error kind → llm_error", () => {
        const r = triage([
            ev("session_start"),
            ev("error", { message: "LLM stream collapsed mid-completion" }),
            ev("session_end", { reason: "error", turns: 1 }),
        ]);
        expect(r.likely_failure_class).toBe("llm_error");
        expect(r.evidence.join(" ")).toMatch(/collapsed/);
        assertNonAuthoritative(r);
    });
    test("session_end reason aborted → aborted", () => {
        const r = triage([ev("session_start"), ev("session_end", { reason: "aborted", turns: 2 })]);
        expect(r.likely_failure_class).toBe("aborted");
        assertNonAuthoritative(r);
    });
    test("empty / inscrutable trajectory → unknown with low confidence", () => {
        const r = triage([]);
        expect(r.likely_failure_class).toBe("unknown");
        expect(r.confidence).toBeGreaterThan(0);
        expect(r.confidence).toBeLessThanOrEqual(0.3);
        expect(r.triage_hint).toMatch(HEDGED);
        expect(r.evidence.length).toBeGreaterThan(0);
    });
    test("a passing-looking run (patch + verify passed) is still only a hypothesis", () => {
        const r = triage([
            ev("patch_generated", { diffPath: "/d", filesChanged: 1, hunks: 1, applyStatus: "ok" }),
            ev("verify", {
                command: "pytest",
                exitCode: 0,
                passed: true,
                failedTests: [],
                logTail: "ok",
                reportPath: "/r.json",
            }),
            ev("session_end", { reason: "stop", turns: 2 }),
        ]);
        expect(r.confidence).toBeLessThanOrEqual(0.9);
        expect(r.triage_hint).toMatch(HEDGED);
    });
});
