import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createSubagentRunner } from "../../src/agent/subagent-runner";
import { ToolRegistry } from "../../src/tool";
/** Index into a captured array, throwing if the slot is absent. Same
 *  fail-on-missing contract the previous `arr[i]!` non-null assertions had,
 *  but with an explicit runtime guard instead of a compile-only assertion. */
const at = (arr, i) => {
    const v = arr[i];
    if (v === undefined)
        throw new Error(`expected element at index ${i}`);
    return v;
};
/** A trivial named tool so registry filtering can be asserted by name. */
const fakeTool = (name) => ({
    name,
    description: name,
    inputSchema: z.object({}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute() {
        yield { type: "result", result: { ok: true, output: "" } };
    },
});
const baseRegistry = () => new ToolRegistry([fakeTool("read"), fakeTool("write"), fakeTool("bash")]);
/** A structurally valid parent AgentConfig. The real loop is never invoked
 *  (every test injects a fake `run`), so ports can be inert stubs. */
const parentConfig = (over = {}) => ({
    // biome-ignore lint/suspicious/noExplicitAny: inert port stub
    llm: { stream: async function* () { } },
    registry: baseRegistry(),
    stream: { emit: () => { } },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "PARENT" }] }],
    system: "PARENT SYSTEM",
    cwd: "/repo",
    maxTurns: 17,
    signal: new AbortController().signal,
    ...over,
});
const outcome = (over = {}) => ({
    reason: "completed",
    turns: 2,
    messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "the answer" }] },
    ],
    ...over,
});
const req = (over = {}) => ({
    prompt: "do the thing",
    depth: 1,
    ...over,
});
/** Capture the child config the runner hands to `runAgent`. */
const capturing = (result = outcome()) => {
    const seen = [];
    const run = (async (c) => {
        seen.push(c);
        return result;
    });
    return { run, seen };
};
describe("createSubagentRunner — depth guard", () => {
    test("denies (never throws) when req.depth exceeds maxDepth", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run, maxDepth: 3 });
        const r = await runner(req({ depth: 4 }));
        expect(r).toEqual({ ok: false, finalText: "max subagent depth exceeded", turns: 0 });
        expect(seen.length).toBe(0); // loop never forked
    });
    test("default maxDepth is 3", async () => {
        const { run } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run });
        expect((await runner(req({ depth: 4 }))).ok).toBe(false);
        expect((await runner(req({ depth: 3 }))).ok).toBe(true);
    });
    test("depth exactly at the limit is allowed", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run, maxDepth: 3 });
        expect((await runner(req({ depth: 3 }))).ok).toBe(true);
        expect(seen.length).toBe(1);
    });
});
describe("createSubagentRunner — child config overrides", () => {
    test("seeds the child with exactly the request prompt", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run });
        await runner(req({ prompt: "investigate X" }));
        const msgs = at(seen, 0).messages;
        expect(msgs).toEqual([{ role: "user", content: [{ type: "text", text: "investigate X" }] }]);
    });
    test("toolFilter produces a filtered registry; absent ⇒ inherits parent", async () => {
        const { run, seen } = capturing();
        const parent = parentConfig();
        const runner = createSubagentRunner(parent, { run });
        await runner(req({ toolFilter: ["read", "missing"] }));
        expect(at(seen, 0)
            .registry.specs()
            .map((s) => s.name)
            .sort()).toEqual(["read"]);
        await runner(req());
        // No filter ⇒ the parent's own registry instance is inherited as-is.
        expect(at(seen, 1).registry).toBe(parent.registry);
        expect(at(seen, 1)
            .registry.specs()
            .map((s) => s.name)
            .sort()).toEqual(["bash", "read", "write"]);
    });
    test("empty toolFilter ⇒ empty child registry (no throw)", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run });
        await runner(req({ toolFilter: [] }));
        expect(at(seen, 0).registry.specs()).toEqual([]);
    });
    test("maxTurns = budget.maxTurns ?? parent.maxTurns", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig({ maxTurns: 17 }), { run });
        await runner(req({ budget: { maxTurns: 5 } }));
        expect(at(seen, 0).maxTurns).toBe(5);
        await runner(req());
        expect(at(seen, 1).maxTurns).toBe(17);
    });
    test("store / hooks / metrics / run / sessionId / memory are dropped; subagent is PROPAGATED", async () => {
        const { run, seen } = capturing();
        // biome-ignore lint/suspicious/noExplicitAny: opaque runner stub, identity is what matters
        const subagentBlock = { runner: (async () => ({})), maxDepth: 2 };
        const parent = parentConfig({
            // biome-ignore lint/suspicious/noExplicitAny: opaque stubs, presence is what matters
            store: { v: 1 },
            // biome-ignore lint/suspicious/noExplicitAny: opaque stub
            hooks: { emit: async () => undefined },
            // biome-ignore lint/suspicious/noExplicitAny: opaque stub
            metrics: {},
            // biome-ignore lint/suspicious/noExplicitAny: opaque stub
            run: { traceId: "t" },
            sessionId: "parent-session",
            memory: { recallLimit: 9 },
            // biome-ignore lint/suspicious/noExplicitAny: structural subagent block
            subagent: subagentBlock,
            // biome-ignore lint/suspicious/noExplicitAny: skills must NOT propagate
            skills: { dir: "/skills" },
        });
        const runner = createSubagentRunner(parent, { run });
        await runner(req());
        const child = at(seen, 0);
        expect(child.store).toBeUndefined();
        expect(child.hooks).toBeUndefined();
        expect(child.metrics).toBeUndefined();
        expect(child.run).toBeUndefined();
        expect(child.sessionId).toBeUndefined();
        expect(child.memory).toBeUndefined();
        // ADR-0011: `subagent` is now PROPAGATED into the child (same
        // object/value as the parent) so a forked child can itself spawn
        // sub-subagents; recursion stays bounded by the depth marker + maxDepth
        // deny guard. `skills` is still NOT propagated (clean tool surface).
        expect(child.subagent).toBe(parent.subagent);
        expect(child.subagent).toEqual(subagentBlock);
        expect(child.skills).toBeUndefined();
        // Kept ports survive.
        expect(child.llm).toBe(parent.llm);
        expect(child.stream).toBe(parent.stream);
        expect(child.permission).toBe(parent.permission);
        expect(child.system).toBe(parent.system);
    });
    test("subagent is omitted (not undefined) when the parent has none", async () => {
        const { run, seen } = capturing();
        const parent = parentConfig();
        expect(parent.subagent).toBeUndefined();
        const runner = createSubagentRunner(parent, { run });
        await runner(req());
        const child = at(seen, 0);
        expect(child.subagent).toBeUndefined();
        expect("subagent" in child).toBe(false); // omitted, never assigned undefined
    });
    test("surfaces req.depth on the child config (the dispatch depth seam)", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run });
        await runner(req({ depth: 2 }));
        expect(seen[0].depth).toBe(2);
    });
    // Round 2 fix: Codex-absorption safety contracts MUST propagate to forked
    // children. A review/audit-mode parent that spawns a child WITHOUT mode
    // inheritance would silently allow the child to invoke mutating tools at
    // dispatch, breaking the read-only posture. Same for verify-/closeout-guard
    // and HITL 4-tier.
    test("propagates mode/verifyGuard/closeoutGuard/hitl to the child (Codex-absorption inheritance)", async () => {
        const { run, seen } = capturing();
        const parent = parentConfig({
            mode: "review",
            verifyGuard: { maxTrips: 2 },
            closeoutGuard: { enabled: true, fourRule: true },
            hitl: { enabled: true },
        });
        const runner = createSubagentRunner(parent, { run });
        await runner(req());
        const child = at(seen, 0);
        expect(child.mode).toBe("review");
        expect(child.verifyGuard).toEqual({ maxTrips: 2 });
        expect(child.closeoutGuard).toEqual({ enabled: true, fourRule: true });
        expect(child.hitl).toEqual({ enabled: true });
    });
    test("does NOT propagate repoRules or workingState (cwd-bound / session-scoped)", async () => {
        const { run, seen } = capturing();
        const parent = parentConfig({
            repoRules: {
                sourcePath: "/r/AGENTS.md",
                entrypoint: "AGENTS.md",
                body: "parent rules",
                loadedAt: 1,
            },
            workingState: { enabled: true },
        });
        const runner = createSubagentRunner(parent, { run });
        await runner(req());
        const child = at(seen, 0);
        // repoRules: the child may run in a different cwd (worktree fork) where
        // the parent's repo-local authority is stale — intentional drop.
        expect(child.repoRules).toBeUndefined();
        // workingState: Codex L3 session-scoped — each agent gets a fresh
        // scratchpad. Intentional drop.
        expect(child.workingState).toBeUndefined();
    });
    test("omits absorption fields entirely when the parent has none (no `undefined` assigns)", async () => {
        const { run, seen } = capturing();
        const parent = parentConfig();
        expect(parent.mode).toBeUndefined();
        expect(parent.hitl).toBeUndefined();
        const runner = createSubagentRunner(parent, { run });
        await runner(req());
        const child = at(seen, 0);
        expect("mode" in child).toBe(false);
        expect("verifyGuard" in child).toBe(false);
        expect("closeoutGuard" in child).toBe(false);
        expect("hitl" in child).toBe(false);
    });
});
describe("createSubagentRunner — abort propagation", () => {
    test("aborting the parent aborts the child signal", async () => {
        const ac = new AbortController();
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig({ signal: ac.signal }), { run });
        await runner(req());
        const childSignal = at(seen, 0).signal;
        expect(childSignal.aborted).toBe(false);
        ac.abort();
        expect(childSignal.aborted).toBe(true);
    });
    test("already-aborted parent ⇒ child starts aborted", async () => {
        const ac = new AbortController();
        ac.abort();
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig({ signal: ac.signal }), { run });
        await runner(req());
        expect(at(seen, 0).signal.aborted).toBe(true);
    });
    test("child finishing does NOT abort the parent", async () => {
        const ac = new AbortController();
        const { run } = capturing();
        const runner = createSubagentRunner(parentConfig({ signal: ac.signal }), { run });
        await runner(req());
        expect(ac.signal.aborted).toBe(false);
    });
});
describe("createSubagentRunner — outcome mapping", () => {
    test("completed ⇒ ok:true, last assistant text joined, turns + messages", async () => {
        const { run } = capturing(outcome({
            reason: "completed",
            turns: 4,
            messages: [
                { role: "assistant", content: [{ type: "text", text: "stale" }] },
                { role: "user", content: [{ type: "text", text: "q" }] },
                {
                    role: "assistant",
                    content: [
                        { type: "text", text: "part 1 " },
                        { type: "text", text: "part 2" },
                    ],
                },
            ],
        }));
        const r = await createSubagentRunner(parentConfig(), { run })(req());
        expect(r.ok).toBe(true);
        expect(r.finalText).toBe("part 1 part 2");
        expect(r.turns).toBe(4);
        expect(r.messages).toBeDefined();
    });
    test("non-completed reasons ⇒ ok:false", async () => {
        for (const reason of ["max_turns", "aborted", "error"]) {
            const { run } = capturing(outcome({ reason }));
            const r = await createSubagentRunner(parentConfig(), { run })(req());
            expect(r.ok).toBe(false);
        }
    });
    test("no assistant text ⇒ empty finalText (no throw)", async () => {
        const { run } = capturing(outcome({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }));
        const r = await createSubagentRunner(parentConfig(), { run })(req());
        expect(r.finalText).toBe("");
    });
});
describe("createSubagentRunner — worktree isolation", () => {
    test("git repo + isolation:worktree ⇒ child cwd is the worktree path", async () => {
        const { run, seen } = capturing();
        const isGitRepoFake = async () => true;
        const withWorktreeFake = async (_id, repoRoot, fn) => {
            expect(repoRoot).toBe("/repo");
            const value = await fn("/repo/.claude/worktrees/agent-x");
            return {
                value,
                info: { worktreePath: "/repo/.claude/worktrees/agent-x", branch: "b", removed: true },
            };
        };
        const runner = createSubagentRunner(parentConfig(), {
            run,
            isGitRepo: isGitRepoFake,
            withWorktree: withWorktreeFake,
        });
        const r = await runner(req({ isolation: "worktree" }));
        expect(r.ok).toBe(true);
        expect(at(seen, 0).cwd).toBe("/repo/.claude/worktrees/agent-x");
    });
    test("not a git repo ⇒ falls back to no isolation (no throw, parent cwd)", async () => {
        const { run, seen } = capturing();
        let wtCalled = false;
        const runner = createSubagentRunner(parentConfig({ cwd: "/plain" }), {
            run,
            isGitRepo: (async () => false),
            withWorktree: (async () => {
                wtCalled = true;
                throw new Error("should not be called");
            }),
        });
        const r = await runner(req({ isolation: "worktree" }));
        expect(r.ok).toBe(true);
        expect(wtCalled).toBe(false);
        expect(at(seen, 0).cwd).toBe("/plain");
    });
    test("isolation:none ⇒ child cwd is the parent cwd (req.cwd field removed)", async () => {
        // Round 2: `SubagentRequest.cwd` was removed; the child ALWAYS inherits
        // `parent.cwd` on the no-isolation path. This regression keeps the
        // parent-cwd flow pinned so a future re-introduction of a per-request cwd
        // override has to retire this assertion explicitly.
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig({ cwd: "/repo" }), { run });
        await runner(req({ isolation: "none" }));
        expect(at(seen, 0).cwd).toBe("/repo");
        // Missing isolation ⇒ same path (no isolation), parent.cwd inherited.
        await runner(req());
        expect(at(seen, 1).cwd).toBe("/repo");
    });
});
