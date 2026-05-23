/**
 * PlanStore.clear() hellgate (ADR-0095 P6).
 *
 * Pins the lifecycle reset semantics of `createInMemoryPlanStore().clear()`:
 *   - Resets `current()` to `null`.
 *   - Emits NO delta (clear is a lifecycle event, not a mutation).
 *   - Idempotent — repeated calls are safe no-ops.
 *   - After clear, `create()` succeeds with a fresh v0 plan.
 *   - After clear, mutations (addTodos / updateTodos / removeTodos / etc.)
 *     return `version_conflict` because there is no plan to mutate.
 *   - Snapshots already taken are by-value: clear() does not perturb them.
 */
import { describe, expect, test } from "bun:test";
import { createInMemoryPlanStore } from "../../../src/agent/plan/state";
// ── helpers ─────────────────────────────────────────────────────────────
const NOW = 1_700_000_000_000;
const makeStore = (opts) => {
    let n = 0;
    return createInMemoryPlanStore({
        now: () => NOW,
        idGen: () => {
            n += 1;
            return `t-${n}`;
        },
        ...(opts?.onDelta !== undefined ? { onDelta: opts.onDelta } : {}),
    });
};
const seed = (store) => {
    const r = store.create({
        name: "p",
        overview: "o",
        todos: [{ content: "A" }, { content: "B" }],
    });
    if (!r.ok)
        throw new Error(`seed failed: ${JSON.stringify(r.error)}`);
};
// ── clear() basics ──────────────────────────────────────────────────────
describe("PlanStore.clear() — basic reset", () => {
    test("clear() on empty store is a no-op (current() stays null)", () => {
        const store = makeStore();
        expect(store.current()).toBeNull();
        store.clear();
        expect(store.current()).toBeNull();
    });
    test("clear() resets a populated plan to null", () => {
        const store = makeStore();
        seed(store);
        expect(store.current()).not.toBeNull();
        store.clear();
        expect(store.current()).toBeNull();
    });
    test("clear() on a plan with multiple todos drops them all", () => {
        const store = makeStore();
        seed(store);
        expect(Object.keys(store.current()?.todos ?? {}).length).toBe(2);
        store.clear();
        expect(store.current()).toBeNull();
    });
});
// ── delta emission ──────────────────────────────────────────────────────
describe("PlanStore.clear() — emits no delta", () => {
    test("clear() does not call onDelta when store is empty", () => {
        let count = 0;
        const store = makeStore({ onDelta: () => (count += 1) });
        expect(count).toBe(0);
        store.clear();
        expect(count).toBe(0);
    });
    test("clear() does not call onDelta when a plan is present", () => {
        let count = 0;
        const deltas = [];
        const store = makeStore({
            onDelta: (d) => {
                count += 1;
                deltas.push(d);
            },
        });
        seed(store);
        // create emitted exactly one delta (plan_created).
        expect(count).toBe(1);
        expect(deltas[0]?.kind).toBe("created");
        store.clear();
        // clear() emits NOTHING.
        expect(count).toBe(1);
        expect(deltas.length).toBe(1);
    });
    test("clear() does not emit even if onDelta would throw (no call happens)", () => {
        let count = 0;
        const store = makeStore({
            onDelta: () => {
                count += 1;
                throw new Error("observer should not be called by clear");
            },
        });
        // No throw because no emit happens.
        store.clear();
        expect(count).toBe(0);
    });
});
// ── idempotence ─────────────────────────────────────────────────────────
describe("PlanStore.clear() — idempotent", () => {
    test("clear() twice in a row → current() === null both times", () => {
        const store = makeStore();
        seed(store);
        store.clear();
        expect(store.current()).toBeNull();
        store.clear();
        expect(store.current()).toBeNull();
    });
    test("clear() many times → still null, no emissions", () => {
        let count = 0;
        const store = makeStore({ onDelta: () => (count += 1) });
        seed(store);
        expect(count).toBe(1); // create
        for (let i = 0; i < 10; i++)
            store.clear();
        expect(store.current()).toBeNull();
        expect(count).toBe(1); // unchanged: clear emits nothing
    });
});
// ── clear() + create() round-trip ───────────────────────────────────────
describe("PlanStore.clear() then create() — fresh plan", () => {
    test("clear() + create() works without version_conflict (v0)", () => {
        const store = makeStore();
        seed(store);
        store.clear();
        const r = store.create({
            name: "fresh",
            overview: "after clear",
            todos: [{ content: "new-A" }],
        });
        expect(r.ok).toBe(true);
        expect(store.current()).not.toBeNull();
        expect(store.current()?.version).toBe(0);
        expect(store.current()?.name).toBe("fresh");
    });
    test("clear() + create() emits a fresh 'created' delta", () => {
        const deltas = [];
        const store = makeStore({ onDelta: (d) => deltas.push(d) });
        seed(store);
        expect(deltas.map((d) => d.kind)).toEqual(["created"]);
        store.clear();
        // No additional delta from clear.
        expect(deltas.map((d) => d.kind)).toEqual(["created"]);
        const r = store.create({
            name: "fresh",
            overview: "ow",
            todos: [{ content: "x" }],
        });
        expect(r.ok).toBe(true);
        // create() after clear emits another 'created' delta.
        expect(deltas.map((d) => d.kind)).toEqual(["created", "created"]);
    });
    test("clear() + create() with same name → no version_conflict (clean slate)", () => {
        const store = makeStore();
        seed(store);
        store.clear();
        const r = store.create({ name: "p", overview: "o", todos: [{ content: "B" }] });
        expect(r.ok).toBe(true);
        expect(store.current()?.name).toBe("p");
    });
});
// ── clear() + mutations (no plan) → version_conflict ────────────────────
describe("PlanStore.clear() then mutate → version_conflict", () => {
    test("clear() + addTodos() → version_conflict (no plan to mutate)", () => {
        const store = makeStore();
        seed(store);
        store.clear();
        const r = store.addTodos([{ content: "X" }], 0);
        expect(r.ok).toBe(false);
        if (r.ok)
            throw new Error("expected error");
        expect(r.error.kind).toBe("version_conflict");
    });
    test("clear() + updateTodos() → version_conflict", () => {
        const store = makeStore();
        seed(store);
        store.clear();
        const r = store.updateTodos([{ id: "t-1", status: "completed" }], true, 0);
        expect(r.ok).toBe(false);
        if (r.ok)
            throw new Error("expected error");
        expect(r.error.kind).toBe("version_conflict");
    });
    test("clear() + removeTodos() → version_conflict", () => {
        const store = makeStore();
        seed(store);
        store.clear();
        const r = store.removeTodos(["t-1"], 0);
        expect(r.ok).toBe(false);
        if (r.ok)
            throw new Error("expected error");
        expect(r.error.kind).toBe("version_conflict");
    });
    test("clear() + reorderPhases() → version_conflict", () => {
        const store = makeStore();
        seed(store);
        store.clear();
        const r = store.reorderPhases([], 0);
        expect(r.ok).toBe(false);
        if (r.ok)
            throw new Error("expected error");
        expect(r.error.kind).toBe("version_conflict");
    });
    test("clear() + updateMeta() → version_conflict", () => {
        const store = makeStore();
        seed(store);
        store.clear();
        const r = store.updateMeta({ name: "new" }, 0);
        expect(r.ok).toBe(false);
        if (r.ok)
            throw new Error("expected error");
        expect(r.error.kind).toBe("version_conflict");
    });
});
// ── Snapshot by-value (not affected by clear) ───────────────────────────
describe("PlanStore.clear() — snapshot taken BEFORE clear unaffected", () => {
    test("snapshot held before clear retains plan data", () => {
        const store = makeStore();
        seed(store);
        const snap = store.snapshot();
        expect(snap).not.toBeNull();
        expect(Object.keys(snap?.plan.todos ?? {}).length).toBe(2);
        expect(snap?.plan.name).toBe("p");
        store.clear();
        // Snapshot is by-value: clear does not mutate it.
        expect(snap).not.toBeNull();
        expect(Object.keys(snap?.plan.todos ?? {}).length).toBe(2);
        expect(snap?.plan.name).toBe("p");
        // Store itself is empty.
        expect(store.current()).toBeNull();
    });
    test("snapshot is frozen — clear cannot mutate it even via reference", () => {
        const store = makeStore();
        seed(store);
        const snap = store.snapshot();
        expect(snap).not.toBeNull();
        if (snap === null)
            throw new Error("snap should not be null");
        // The snapshot object itself is frozen.
        expect(Object.isFrozen(snap)).toBe(true);
        expect(Object.isFrozen(snap.plan)).toBe(true);
        store.clear();
        // Still frozen + intact.
        expect(Object.isFrozen(snap)).toBe(true);
        expect(snap.plan.name).toBe("p");
    });
    test("clear() then snapshot() returns null (no plan to snapshot)", () => {
        const store = makeStore();
        seed(store);
        store.clear();
        expect(store.snapshot()).toBeNull();
    });
    test("snapshot → clear → restore round-trip works", () => {
        const store = makeStore();
        seed(store);
        const snap = store.snapshot();
        if (snap === null)
            throw new Error("snap should not be null");
        store.clear();
        expect(store.current()).toBeNull();
        const r = store.restore(snap);
        expect(r.ok).toBe(true);
        expect(store.current()).not.toBeNull();
        expect(store.current()?.name).toBe("p");
        expect(Object.keys(store.current()?.todos ?? {}).length).toBe(2);
    });
});
