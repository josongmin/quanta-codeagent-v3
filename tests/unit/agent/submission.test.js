/**
 * Submission envelope tests (ADR-0062, Spec A3).
 *
 * Covers:
 *   - Discriminated union accepts all six op kinds without type widening.
 *   - {@link submissionFromMessages} happy path, undefined on empty/wrong-role,
 *     synthesizes a stable id with the legacy prefix, threads `trace` only
 *     when supplied.
 *   - {@link extractSeedMessages} round-trip: `extract(from(m)) ≡ m` for the
 *     single-user-message seed; returns `undefined` for control-op variants.
 *   - {@link isUserInputSubmission} guards the two consumable shapes only.
 *
 * Pure module — no clock, no IO. Tests are deterministic except for the
 * `crypto.randomUUID()` id, asserted via prefix + length only.
 */
import { describe, expect, test } from "bun:test";
import { extractSeedMessages, isUserInputSubmission, SUBMISSION_LEGACY_ID_PREFIX, submissionFromMessages, } from "@/agent/submission";
const userMsg = (text) => ({
    role: "user",
    content: [{ type: "text", text }],
});
const assistantMsg = (text) => ({
    role: "assistant",
    content: [{ type: "text", text }],
});
describe("Submission op enum", () => {
    test("discriminated union accepts every kind without narrowing failures", () => {
        const ops = [
            { kind: "user_input", items: [{ type: "text", text: "hi" }] },
            {
                kind: "user_input_with_turn_context",
                items: [{ type: "text", text: "hi" }],
                turnContext: {
                    baseMessages: [],
                    cwd: "/tmp",
                    planMode: false,
                    system: "you are a robot",
                },
            },
            { kind: "interrupt" },
            { kind: "interrupt", turnId: "t-1" },
            { kind: "cancel_subagent", subagentId: "sub-1" },
            { kind: "shutdown" },
            { kind: "reload_user_config" },
        ];
        expect(ops).toHaveLength(7);
        // exhaustive switch compiles only if the union is closed
        for (const op of ops) {
            switch (op.kind) {
                case "user_input":
                case "user_input_with_turn_context":
                case "interrupt":
                case "cancel_subagent":
                case "shutdown":
                case "reload_user_config":
                    break;
            }
        }
    });
});
describe("submissionFromMessages adapter", () => {
    test("lifts a one-user-message seed into a user_input Submission", () => {
        const sub = submissionFromMessages([userMsg("hello")]);
        expect(sub).toBeDefined();
        if (!sub)
            throw new Error("unreachable");
        expect(sub.op.kind).toBe("user_input");
        if (sub.op.kind !== "user_input")
            throw new Error("unreachable");
        expect(sub.op.items).toEqual([{ type: "text", text: "hello" }]);
        expect(sub.id.startsWith(SUBMISSION_LEGACY_ID_PREFIX)).toBe(true);
        expect(sub.trace).toBeUndefined();
    });
    test("preserves the LAST user message's content (resume-history scenario)", () => {
        const sub = submissionFromMessages([userMsg("first"), assistantMsg("ok"), userMsg("second")]);
        expect(sub).toBeDefined();
        if (!sub)
            throw new Error("unreachable");
        if (sub.op.kind !== "user_input")
            throw new Error("expected user_input");
        expect(sub.op.items).toEqual([{ type: "text", text: "second" }]);
    });
    test("returns undefined on an empty message list", () => {
        expect(submissionFromMessages([])).toBeUndefined();
    });
    test("returns undefined when last message is NOT a user turn", () => {
        expect(submissionFromMessages([userMsg("q"), assistantMsg("a")])).toBeUndefined();
    });
    test("threads trace only when provided (exactOptionalPropertyTypes)", () => {
        const withTrace = submissionFromMessages([userMsg("x")], {
            runId: "r-1",
            turn: 3,
        });
        expect(withTrace?.trace).toEqual({ runId: "r-1", turn: 3 });
        const without = submissionFromMessages([userMsg("x")]);
        expect(without && "trace" in without).toBe(false);
    });
});
describe("extractSeedMessages projection", () => {
    test("round-trips a user_input Submission back to a user message", () => {
        const m = [userMsg("ping")];
        const sub = submissionFromMessages(m);
        if (!sub)
            throw new Error("unreachable");
        const seed = extractSeedMessages(sub);
        expect(seed).toEqual(m);
    });
    test("round-trips a user_input_with_turn_context Submission", () => {
        const sub = {
            id: "s-1",
            op: {
                kind: "user_input_with_turn_context",
                items: [{ type: "text", text: "go" }],
                turnContext: {
                    baseMessages: [],
                    cwd: "/tmp",
                    planMode: false,
                    system: "sys",
                },
            },
        };
        expect(extractSeedMessages(sub)).toEqual([userMsg("go")]);
    });
    test("returns undefined for every control-op variant", () => {
        const ops = [
            { kind: "interrupt" },
            { kind: "interrupt", turnId: "t-1" },
            { kind: "cancel_subagent", subagentId: "s" },
            { kind: "shutdown" },
            { kind: "reload_user_config" },
        ];
        for (const op of ops) {
            const sub = { id: "x", op };
            expect(extractSeedMessages(sub)).toBeUndefined();
        }
    });
});
describe("isUserInputSubmission guard", () => {
    test("true for user_input + user_input_with_turn_context only", () => {
        const inputs = [
            { id: "a", op: { kind: "user_input", items: [] } },
            {
                id: "b",
                op: {
                    kind: "user_input_with_turn_context",
                    items: [],
                    turnContext: { baseMessages: [], cwd: "/", planMode: false, system: "" },
                },
            },
        ];
        for (const s of inputs)
            expect(isUserInputSubmission(s)).toBe(true);
    });
    test("false for control-op variants", () => {
        const inputs = [
            { id: "a", op: { kind: "interrupt" } },
            { id: "b", op: { kind: "cancel_subagent", subagentId: "s" } },
            { id: "c", op: { kind: "shutdown" } },
            { id: "d", op: { kind: "reload_user_config" } },
        ];
        for (const s of inputs)
            expect(isUserInputSubmission(s)).toBe(false);
    });
});
