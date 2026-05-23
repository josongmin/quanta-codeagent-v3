import { describe, expect, test } from "bun:test";
import { createVerifyGuardState, decideVerifyGuard, VERIFY_FORCE_MESSAGE, } from "@/agent/verify-guard";
const h = (...items) => items.map((it) => (typeof it === "string" ? { name: it } : it));
describe("decideVerifyGuard", () => {
    test("(1) cfg undefined ⇒ never blocks (guard OFF)", () => {
        const state = createVerifyGuardState();
        expect(decideVerifyGuard({ history: h("edit"), cfg: undefined, state })).toEqual({
            block: false,
        });
        expect(state.trips).toBe(0);
    });
    test("(2) no edit in history ⇒ no block", () => {
        const state = createVerifyGuardState();
        expect(decideVerifyGuard({ history: h("read", "bash"), cfg: {}, state })).toEqual({
            block: false,
        });
        expect(state.trips).toBe(0);
    });
    test("(3) edit then nothing ⇒ block once, exact text, trips=1", () => {
        const state = createVerifyGuardState();
        const r = decideVerifyGuard({ history: h("read", "edit"), cfg: {}, state });
        expect(r).toEqual({ block: true, text: VERIFY_FORCE_MESSAGE });
        expect(r.text).toBe(VERIFY_FORCE_MESSAGE);
        expect(state.trips).toBe(1);
    });
    test("(4) edit then test_runner ⇒ no block", () => {
        const state = createVerifyGuardState();
        expect(decideVerifyGuard({ history: h("edit", "test_runner"), cfg: {}, state })).toEqual({
            block: false,
        });
        expect(state.trips).toBe(0);
    });
    test("(4b) edit then test_runner with arg ⇒ no block (arg irrelevant)", () => {
        const state = createVerifyGuardState();
        expect(decideVerifyGuard({
            history: h("edit", { name: "test_runner", arg: "anything" }),
            cfg: {},
            state,
        })).toEqual({ block: false });
        expect(state.trips).toBe(0);
    });
    test("(5) REGRESSION: edit then noise bash (git status) ⇒ block (noise ≠ verify)", () => {
        const state = createVerifyGuardState();
        const r = decideVerifyGuard({
            history: h("edit", { name: "bash", arg: "git status" }),
            cfg: {},
            state,
        });
        expect(r).toEqual({ block: true, text: VERIFY_FORCE_MESSAGE });
        expect(state.trips).toBe(1);
    });
    test("(5b) edit then `echo done` ⇒ block (shell noise)", () => {
        const state = createVerifyGuardState();
        expect(decideVerifyGuard({
            history: h("edit", { name: "bash", arg: "echo done" }),
            cfg: {},
            state,
        }).block).toBe(true);
        expect(state.trips).toBe(1);
    });
    test("(5c) edit then bash with NO arg ⇒ block (undefined arg ≠ verify)", () => {
        const state = createVerifyGuardState();
        expect(decideVerifyGuard({ history: h("edit", "bash"), cfg: {}, state })).toEqual({
            block: true,
            text: VERIFY_FORCE_MESSAGE,
        });
        expect(state.trips).toBe(1);
    });
    test("(5d) edit then real pytest bash ⇒ no block", () => {
        const state = createVerifyGuardState();
        expect(decideVerifyGuard({
            history: h("edit", { name: "bash", arg: "python -m pytest tests/test_x.py" }),
            cfg: {},
            state,
        })).toEqual({ block: false });
        expect(state.trips).toBe(0);
    });
    test("(5e) edit then reproduce script ⇒ no block", () => {
        const state = createVerifyGuardState();
        expect(decideVerifyGuard({
            history: h("edit", { name: "bash", arg: "python reproduce_bug.py" }),
            cfg: {},
            state,
        })).toEqual({ block: false });
        expect(state.trips).toBe(0);
    });
    test("(6) edit, real-verify, edit again, nothing ⇒ blocks again", () => {
        const state = createVerifyGuardState();
        const r = decideVerifyGuard({
            history: h("edit", { name: "bash", arg: "pytest" }, "edit"),
            cfg: {},
            state,
        });
        expect(r).toEqual({ block: true, text: VERIFY_FORCE_MESSAGE });
        expect(state.trips).toBe(1);
    });
    test("(7) maxTrips cap: {maxTrips:1} second qualifying call ⇒ no block, trips stays 1", () => {
        const state = createVerifyGuardState();
        const first = decideVerifyGuard({
            history: h("edit"),
            cfg: { maxTrips: 1 },
            state,
        });
        expect(first).toEqual({ block: true, text: VERIFY_FORCE_MESSAGE });
        expect(state.trips).toBe(1);
        const second = decideVerifyGuard({
            history: h("edit"),
            cfg: { maxTrips: 1 },
            state,
        });
        expect(second).toEqual({ block: false });
        expect(state.trips).toBe(1);
    });
    test("(7b) maxTrips:0 ⇒ never blocks", () => {
        const state = createVerifyGuardState();
        expect(decideVerifyGuard({ history: h("edit"), cfg: { maxTrips: 0 }, state })).toEqual({
            block: false,
        });
        expect(state.trips).toBe(0);
    });
    test("(8) default maxTrips is 1 when cfg {}", () => {
        const state = createVerifyGuardState();
        expect(decideVerifyGuard({ history: h("edit"), cfg: {}, state }).block).toBe(true);
        expect(state.trips).toBe(1);
        // second qualifying call: cap (1) reached ⇒ no block
        expect(decideVerifyGuard({ history: h("edit"), cfg: {}, state }).block).toBe(false);
        expect(state.trips).toBe(1);
    });
    test("write counts as a mutating tool", () => {
        const state = createVerifyGuardState();
        expect(decideVerifyGuard({ history: h("write"), cfg: {}, state }).block).toBe(true);
    });
    test("verification BEFORE the latest edit does not count", () => {
        const state = createVerifyGuardState();
        const r = decideVerifyGuard({
            history: h("test_runner", "edit"),
            cfg: {},
            state,
        });
        expect(r.block).toBe(true);
    });
});
