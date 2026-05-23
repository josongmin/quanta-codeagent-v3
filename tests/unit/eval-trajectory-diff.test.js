/**
 * Structural event diff — pins the projection contract.
 *
 *   1. Identical streams ⇒ matched, diverged=0.
 *   2. Inserted tool call ⇒ diverged=1, matched=false.
 *   3. Different tool name ⇒ diverged=2 (delete + insert).
 *   4. Provider-noisy fields (assistant_text deltas, llm usage tokens,
 *      timestamps, span ids) ⇒ ignored — projection drops them.
 *   5. Different stop reason ⇒ counted (session_end is compared).
 */
import { describe, expect, test } from "bun:test";
import { diffStreams, projectStream } from "@/../src/apps/eval/trajectory/diff";
let seq = 0;
const ev = (kind, data = {}) => ({
    schema: "trajectory.v1",
    v: 1,
    seq: seq++,
    ts: 0,
    ctx: { runId: "t" },
    producer: { name: "test", version: "1" },
    redaction: { policy: "test", applied: false },
    kind,
    data,
});
describe("trajectory structural diff", () => {
    test("identical streams ⇒ matched", () => {
        seq = 0;
        const a = [
            ev("turn_start"),
            ev("tool_call", { name: "Read", input: { path: "/tmp/x" } }),
            ev("tool_result", { name: "Read", ok: true }),
            ev("session_end", { reason: "completed" }),
        ];
        seq = 0;
        const b = [
            ev("turn_start"),
            ev("tool_call", { name: "Read", input: { path: "/tmp/y" } }), // value differs, shape same
            ev("tool_result", { name: "Read", ok: true }),
            ev("session_end", { reason: "completed" }),
        ];
        const d = diffStreams(a, b);
        expect(d.matched).toBe(true);
        expect(d.divergedEvents).toBe(0);
    });
    test("inserted tool call ⇒ diverged=1", () => {
        seq = 0;
        const a = [
            ev("turn_start"),
            ev("tool_call", { name: "Read", input: { path: "/x" } }),
            ev("tool_result", { name: "Read", ok: true }),
        ];
        seq = 0;
        const b = [
            ev("turn_start"),
            ev("tool_call", { name: "Read", input: { path: "/x" } }),
            ev("tool_result", { name: "Read", ok: true }),
            ev("tool_call", { name: "Grep", input: { pattern: "y" } }),
            ev("tool_result", { name: "Grep", ok: true }),
        ];
        const d = diffStreams(a, b);
        expect(d.matched).toBe(false);
        expect(d.divergedEvents).toBe(2);
    });
    test("different tool name ⇒ diverged > 0", () => {
        seq = 0;
        const a = [ev("tool_call", { name: "Read", input: { path: "/x" } })];
        seq = 0;
        const b = [ev("tool_call", { name: "Write", input: { path: "/x" } })];
        const d = diffStreams(a, b);
        expect(d.matched).toBe(false);
        expect(d.divergedEvents).toBeGreaterThanOrEqual(2);
    });
    test("noisy kinds (assistant_text, llm_usage) are ignored by projection", () => {
        seq = 0;
        const a = [
            ev("turn_start"),
            ev("assistant_text", { delta: "hello" }),
            ev("llm_usage", { inputTokens: 100 }),
            ev("tool_call", { name: "Read", input: { path: "/x" } }),
        ];
        const aProjection = projectStream(a);
        expect(aProjection).toEqual(["turn_start", "tool_call:Read[path]"]);
    });
    test("different stop reason is counted", () => {
        seq = 0;
        const a = [ev("session_end", { reason: "completed" })];
        seq = 0;
        const b = [ev("session_end", { reason: "max_turns" })];
        const d = diffStreams(a, b);
        expect(d.matched).toBe(false);
        expect(d.divergedEvents).toBeGreaterThanOrEqual(2);
    });
    test("firstDivergences reports up to 5", () => {
        seq = 0;
        const a = [
            ev("turn_start"),
            ev("turn_start"),
            ev("turn_start"),
            ev("turn_start"),
            ev("turn_start"),
            ev("turn_start"),
        ];
        seq = 0;
        const b = [ev("error"), ev("error"), ev("error"), ev("error"), ev("error"), ev("error")];
        const d = diffStreams(a, b);
        expect(d.firstDivergences.length).toBeLessThanOrEqual(5);
    });
});
