/**
 * Submission `set_mode` op hellgate (P3, 2026-05-23).
 *
 * Pins the contract for the new `set_mode` SubmissionOp variant + its
 * matching `isSetModeOp` type guard. Mirrors the existing
 * control-op-handler-hellgate test for `isInterruptOp` /
 * `isCancelSubagentOp`.
 *
 * Coverage:
 *   - SubmissionOp union accepts mode="default" and mode="plan".
 *   - `isSetModeOp` positive (both modes, both with and without reason).
 *   - `isSetModeOp` negative for every OTHER op kind in the union.
 *   - JSON round-trip preserves all fields including optional `reason`
 *     (absent → no key in output; empty/whitespace allowed by closed-shape).
 *   - `ALL_SUBMISSION_OP_KINDS` includes `set_mode` and pairs 1-to-1 with
 *     every union discriminant (exhaustive coverage drift gate).
 *
 * NO heuristic detection — taxonomy is closed; the tests do not sniff
 * strings.
 */
import { describe, expect, test } from "bun:test";
import { isSetModeOp } from "@/agent/control-op-handler";
import { ALL_SUBMISSION_OP_KINDS } from "@/agent/submission";
// ── SubmissionOp union accepts both modes ───────────────────────────────
describe("SubmissionOp union admits `set_mode` for both modes", () => {
    test("kind=set_mode + mode=default compiles", () => {
        const op = { kind: "set_mode", mode: "default" };
        expect(op.kind).toBe("set_mode");
        if (op.kind !== "set_mode")
            throw new Error("unreachable");
        expect(op.mode).toBe("default");
    });
    test("kind=set_mode + mode=plan compiles", () => {
        const op = { kind: "set_mode", mode: "plan" };
        expect(op.kind).toBe("set_mode");
        if (op.kind !== "set_mode")
            throw new Error("unreachable");
        expect(op.mode).toBe("plan");
    });
    test("kind=set_mode with reason compiles + carries reason", () => {
        const op = { kind: "set_mode", mode: "plan", reason: "developer override" };
        if (op.kind !== "set_mode")
            throw new Error("unreachable");
        expect(op.reason).toBe("developer override");
    });
    test("kind=set_mode with empty string reason is allowed (closed-shape)", () => {
        const op = { kind: "set_mode", mode: "default", reason: "" };
        if (op.kind !== "set_mode")
            throw new Error("unreachable");
        expect(op.reason).toBe("");
    });
    test("kind=set_mode with whitespace-only reason is allowed (closed-shape)", () => {
        const op = { kind: "set_mode", mode: "plan", reason: "   \t  " };
        if (op.kind !== "set_mode")
            throw new Error("unreachable");
        expect(op.reason).toBe("   \t  ");
    });
});
// ── isSetModeOp positive / negative arms ────────────────────────────────
describe("isSetModeOp positive arms", () => {
    test("set_mode + default ⇒ true", () => {
        const s = { id: "s1", op: { kind: "set_mode", mode: "default" } };
        expect(isSetModeOp(s)).toBe(true);
    });
    test("set_mode + plan ⇒ true", () => {
        const s = { id: "s2", op: { kind: "set_mode", mode: "plan" } };
        expect(isSetModeOp(s)).toBe(true);
    });
    test("set_mode with reason ⇒ true (guard ignores optional fields)", () => {
        const s = {
            id: "s3",
            op: { kind: "set_mode", mode: "plan", reason: "dev msg" },
        };
        expect(isSetModeOp(s)).toBe(true);
    });
    test("guard narrows correctly (compile-time + runtime)", () => {
        const s = {
            id: "s4",
            op: { kind: "set_mode", mode: "plan", reason: "abc" },
        };
        if (isSetModeOp(s)) {
            // narrowed: op.kind === "set_mode" + required mode + optional reason
            expect(s.op.kind).toBe("set_mode");
            expect(s.op.mode).toBe("plan");
            expect(s.op.reason).toBe("abc");
        }
    });
});
describe("isSetModeOp negative arms (every OTHER op kind)", () => {
    test("user_input ⇒ false", () => {
        const s = {
            id: "a",
            op: { kind: "user_input", items: [{ type: "text", text: "hi" }] },
        };
        expect(isSetModeOp(s)).toBe(false);
    });
    test("user_input_with_turn_context ⇒ false", () => {
        const s = {
            id: "b",
            op: {
                kind: "user_input_with_turn_context",
                items: [{ type: "text", text: "hi" }],
                turnContext: {
                    baseMessages: [],
                    cwd: "/tmp",
                    planMode: false,
                    system: "sys",
                },
            },
        };
        expect(isSetModeOp(s)).toBe(false);
    });
    test("interrupt (bare) ⇒ false", () => {
        const s = { id: "c", op: { kind: "interrupt" } };
        expect(isSetModeOp(s)).toBe(false);
    });
    test("interrupt + turnId ⇒ false", () => {
        const s = { id: "d", op: { kind: "interrupt", turnId: "t-1" } };
        expect(isSetModeOp(s)).toBe(false);
    });
    test("cancel_subagent ⇒ false", () => {
        const s = {
            id: "e",
            op: { kind: "cancel_subagent", subagentId: "sub-1" },
        };
        expect(isSetModeOp(s)).toBe(false);
    });
    test("shutdown ⇒ false", () => {
        const s = { id: "f", op: { kind: "shutdown" } };
        expect(isSetModeOp(s)).toBe(false);
    });
    test("reload_user_config ⇒ false", () => {
        const s = { id: "g", op: { kind: "reload_user_config" } };
        expect(isSetModeOp(s)).toBe(false);
    });
});
// ── JSON round-trip ─────────────────────────────────────────────────────
describe("JSON round-trip preserves set_mode op fields", () => {
    test("with reason: round-trips identically", () => {
        const original = {
            id: "sr1",
            op: { kind: "set_mode", mode: "plan", reason: "developer override" },
        };
        const json = JSON.stringify(original);
        const parsed = JSON.parse(json);
        expect(parsed).toEqual(original);
    });
    test("without reason: round-trips without injecting a reason key", () => {
        const original = {
            id: "sr2",
            op: { kind: "set_mode", mode: "default" },
        };
        const json = JSON.stringify(original);
        expect(json.includes("reason")).toBe(false);
        const parsed = JSON.parse(json);
        expect(parsed).toEqual(original);
        if (parsed.op.kind === "set_mode") {
            expect("reason" in parsed.op).toBe(false);
        }
    });
    test("with empty-string reason: serialized verbatim", () => {
        const original = {
            id: "sr3",
            op: { kind: "set_mode", mode: "plan", reason: "" },
        };
        const json = JSON.stringify(original);
        expect(json.includes('"reason":""')).toBe(true);
        const parsed = JSON.parse(json);
        expect(parsed).toEqual(original);
    });
});
// ── ALL_SUBMISSION_OP_KINDS exhaustive coverage ─────────────────────────
describe("ALL_SUBMISSION_OP_KINDS taxonomy includes set_mode + every union arm", () => {
    test("includes set_mode", () => {
        expect(ALL_SUBMISSION_OP_KINDS.includes("set_mode")).toBe(true);
    });
    test("equals the documented 7-arm closed enum, in order", () => {
        expect([...ALL_SUBMISSION_OP_KINDS]).toEqual([
            "user_input",
            "user_input_with_turn_context",
            "interrupt",
            "cancel_subagent",
            "shutdown",
            "reload_user_config",
            "set_mode",
        ]);
    });
    test("no duplicates", () => {
        const set = new Set(ALL_SUBMISSION_OP_KINDS);
        expect(set.size).toBe(ALL_SUBMISSION_OP_KINDS.length);
    });
    test("frozen at runtime (immutable contract)", () => {
        expect(Object.isFrozen(ALL_SUBMISSION_OP_KINDS)).toBe(true);
    });
    test("exhaustive SubmissionOp switch — every kind has a value (compile + runtime)", () => {
        // Compile-time hellgate: adding a new union arm without listing it here
        // is a tsc error in the `never` default. Runtime: every listed kind
        // returns a non-empty discriminator string.
        const witness = (op) => {
            switch (op.kind) {
                case "user_input":
                    return "user_input";
                case "user_input_with_turn_context":
                    return "user_input_with_turn_context";
                case "interrupt":
                    return "interrupt";
                case "cancel_subagent":
                    return "cancel_subagent";
                case "shutdown":
                    return "shutdown";
                case "reload_user_config":
                    return "reload_user_config";
                case "set_mode":
                    return "set_mode";
                default: {
                    const _exhaustive = op;
                    return _exhaustive;
                }
            }
        };
        // Construct one op per listed kind and confirm the witness covers it.
        const samples = [
            { kind: "user_input", items: [] },
            {
                kind: "user_input_with_turn_context",
                items: [],
                turnContext: { baseMessages: [], cwd: "/", planMode: false, system: "" },
            },
            { kind: "interrupt" },
            { kind: "cancel_subagent", subagentId: "x" },
            { kind: "shutdown" },
            { kind: "reload_user_config" },
            { kind: "set_mode", mode: "plan" },
        ];
        expect(samples.map((s) => s.kind)).toEqual([...ALL_SUBMISSION_OP_KINDS]);
        for (const s of samples)
            expect(witness(s).length).toBeGreaterThan(0);
    });
});
