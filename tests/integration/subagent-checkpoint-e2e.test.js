import { describe, expect, test } from "bun:test";
import { runAgent } from "@/agent";
import { defaultTools, ToolRegistry } from "@/tool";
import { cfg, RecordingStream, withTimeout } from "./_harness";
/**
 * Round 3 — E2E: `checkpoint:true` injects a `**Checkpoint**:` guidance block
 * pointing at `<cwd>/.subagent-state/<task_id>.md` into the child's seed.
 *
 * We verify the GUIDANCE (the seed-text injection) reaches the child loop. We
 * do NOT verify the child actually writes to the checkpoint file — that's
 * child-LLM behavior we can't deterministically test, and the runner only
 * INJECTS the path; it does NOT mkdir or otherwise touch the parent cwd.
 *
 * Pattern follows subagent-seed-augmentation-e2e.test.ts.
 */
const text = (t) => [
    { type: "text_delta", delta: t },
    { type: "message_stop", stop_reason: "end_turn" },
];
const toolCall = (id, name, input) => [
    { type: "tool_use_start", id, name },
    { type: "tool_use_end", id, input },
    { type: "message_stop", stop_reason: "tool_use" },
];
const conversationText = (input) => input.messages
    .flatMap((m) => m.content.map((b) => b.type === "text" ? b.text : b.type === "tool_result" ? b.content : ""))
    .join(" ");
/** Latest task_id seen in any tool_result body of `input.messages`. Used by
 *  the background test to substitute the registry-minted id into a parent
 *  tool_call that referenced `__PLACEHOLDER__`. */
const findLastTaskId = (input) => {
    for (let i = input.messages.length - 1; i >= 0; i--) {
        const m = input.messages[i];
        if (!m)
            continue;
        for (const b of m.content) {
            if (b.type !== "tool_result")
                continue;
            const mt = b.content.match(/task_id: (\S+)/);
            if (mt?.[1])
                return mt[1];
        }
    }
    return undefined;
};
/** Pure rewrite: substitute `__PLACEHOLDER__` task_ids on tool_use_end events. */
const rewriteTaskId = (e, liveTaskId) => {
    if (!liveTaskId)
        return e;
    if (e.type !== "tool_use_end")
        return e;
    const inp = e.input;
    if (!inp || typeof inp !== "object")
        return e;
    const rec = inp;
    if (rec.task_id !== "__PLACEHOLDER__")
        return e;
    return { ...e, input: { ...rec, task_id: liveTaskId } };
};
class RoutingLLM {
    model = "routing-test-model";
    log = [];
    observations = [];
    /** Optional regex rules — first matching string-rule wins; if none match we
     *  scan regex rules. Lets the background test match on a path containing the
     *  registry-minted task_id (unknown at scripting time). */
    rules;
    regexRules;
    constructor(rules, regexRules = []) {
        this.rules = rules.map((r) => ({ ...r }));
        this.regexRules = regexRules.map((r) => ({ ...r }));
    }
    async *stream(input) {
        const txt = conversationText(input);
        this.observations.push(txt);
        // Regex rules are checked FIRST so a more-specific regex (e.g. matching a
        // pattern only present when the seed-augmentation block landed) beats a
        // less-specific string GUARD rule that would otherwise mask the success.
        const rRule = this.regexRules.find((r) => r.re.test(txt) && !(r.once && r.spent));
        if (rRule) {
            if (rRule.once)
                rRule.spent = true;
            this.log.push(rRule.label);
            for (const e of rRule.events)
                yield e;
            return;
        }
        const sRule = this.rules.find((r) => txt.includes(r.match) && !(r.once && r.spent));
        if (sRule) {
            if (sRule.once)
                sRule.spent = true;
            this.log.push(sRule.match);
            for (const e of sRule.events)
                yield e;
            return;
        }
        this.log.push(`UNMATCHED:${txt.slice(0, 80)}`);
        yield* text("unmatched fallback");
    }
}
describe("subagent checkpoint — e2e guidance block reaches child seed", () => {
    test("foreground checkpoint:true ⇒ child sees `**Checkpoint**:` block pointing under `.subagent-state/`", async () => {
        const llm = new RoutingLLM([
            // Parent: spawn foreground child with checkpoint:true.
            {
                match: "PARENT-GO",
                events: toolCall("a1", "agent", {
                    prompt: "CHILD-SEED do the work",
                    checkpoint: true,
                }),
                once: true,
            },
            // After child summary returns, parent finishes.
            { match: "Subagent completed", events: text("PARENT-DONE") },
            // Child first turn — routes on the injected `**Checkpoint**:` marker.
            // Firing this rule PROVES `buildSeedPrompt` injected the checkpoint block.
            {
                match: "**Checkpoint**:",
                events: text("CHILD-OBSERVED-CHECKPOINT-BLOCK"),
                once: true,
            },
            // GUARD: if the child saw a bare prompt (no checkpoint), this would fire
            // and surface the regression.
            { match: "CHILD-SEED", events: text("CHILD-DID-NOT-SEE-CHECKPOINT") },
        ]);
        const out = await withTimeout(runAgent(cfg({
            llm,
            stream: new RecordingStream(),
            registry: new ToolRegistry(defaultTools),
            messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
            subagent: { maxDepth: 3 },
            maxTurns: 5,
        })), 15_000, "subagent-checkpoint-foreground");
        expect(out.reason).toBe("completed");
        // Load-bearing assertion: checkpoint rule fired, bare-prompt fallback did not.
        expect(llm.log).toContain("**Checkpoint**:");
        expect(llm.log).not.toContain("CHILD-SEED");
        expect(llm.log).not.toContain("CHILD-DID-NOT-SEE-CHECKPOINT");
        expect(llm.log.some((l) => l.startsWith("UNMATCHED"))).toBe(false);
        // The child's first-turn observation contains both the original prompt AND
        // the checkpoint guidance pointing under `.subagent-state/`. Parent cwd in
        // cfg() defaults to "/tmp", so the path lives under "/tmp/.subagent-state/".
        const childSeedTurn = llm.observations.find((t) => t.includes("CHILD-SEED do the work") &&
            t.includes("**Checkpoint**:") &&
            t.includes("/tmp/.subagent-state/"));
        expect(childSeedTurn).toBeDefined();
        expect(childSeedTurn).toContain(".md");
        const finalAssistant = out.messages.findLast((m) => m.role === "assistant");
        const finalText = (finalAssistant?.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("");
        expect(finalText).toContain("PARENT-DONE");
    });
    test("background + checkpoint:true ⇒ child seed checkpoint path contains the live task_id", async () => {
        const llm = new RoutingLLM([
            // Parent turn 1: spawn background child with checkpoint:true.
            {
                match: "PARENT-GO",
                events: toolCall("a1", "agent", {
                    prompt: "BG-CHILD-SEED do work",
                    background: true,
                    checkpoint: true,
                }),
                once: true,
            },
            // Parent turn 2: block on task_output until the background child settles.
            {
                match: "Subagent launched in background. task_id:",
                events: toolCall("o1", "task_output", { task_id: "__PLACEHOLDER__", block: true }),
                once: true,
            },
            // Parent turn 3: settle (the child's text) returns ⇒ finish.
            { match: "CHILD-FINISHED-BG", events: text("PARENT-DONE-BG") },
            // GUARD: child saw the seed prompt but NOT the checkpoint marker.
            { match: "BG-CHILD-SEED", events: text("BG-CHILD-DID-NOT-SEE-CHECKPOINT") },
        ], [
            // Child first turn — routes on a regex matching the registry-minted
            // task_id (`task_<uuid>`) embedded in the checkpoint path. Firing this
            // rule PROVES the agent-tool resolved the task_id BEFORE invoking the
            // runner AND threaded it into req.checkpointPath, AND the runner
            // injected that path into the child's seed.
            {
                re: /\*\*Checkpoint\*\*:[^\n]*\/tmp\/\.subagent-state\/task_[0-9a-f-]+\.md/,
                events: text("CHILD-FINISHED-BG saw task-id checkpoint path"),
                once: true,
                label: "CHECKPOINT-TASK-ID-REGEX",
            },
        ]);
        // Rewrite __PLACEHOLDER__ in task_output input to the actual task_id from
        // the most recent tool_result. (Helpers are module-level for low complexity.)
        const origStream = llm.stream.bind(llm);
        llm.stream = async function* (input) {
            const lastTaskId = findLastTaskId(input);
            for await (const e of origStream(input)) {
                yield rewriteTaskId(e, lastTaskId);
            }
        };
        const out = await withTimeout(runAgent(cfg({
            llm,
            stream: new RecordingStream(),
            registry: new ToolRegistry(defaultTools),
            messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
            subagent: { maxDepth: 3 },
            maxTurns: 8,
        })), 15_000, "subagent-checkpoint-background");
        expect(out.reason).toBe("completed");
        // The checkpoint-path regex (with embedded task_id) fired — direct proof
        // the live task_id reached the child's seed via the runner.
        expect(llm.log).toContain("CHECKPOINT-TASK-ID-REGEX");
        expect(llm.log).not.toContain("BG-CHILD-DID-NOT-SEE-CHECKPOINT");
        expect(llm.log).not.toContain("BG-CHILD-SEED");
        expect(llm.log.some((l) => l.startsWith("UNMATCHED"))).toBe(false);
        const finalAssistant = out.messages.findLast((m) => m.role === "assistant");
        const finalText = (finalAssistant?.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("");
        expect(finalText).toContain("PARENT-DONE-BG");
    });
    test("checkpoint:true + isolation:worktree ⇒ recoverable deny; runner never invoked", async () => {
        const llm = new RoutingLLM([
            // Parent turn 1: incompatible combination. Tool denies before invoking runner.
            {
                match: "PARENT-GO",
                events: toolCall("a1", "agent", {
                    prompt: "would-checkpoint-in-worktree",
                    checkpoint: true,
                    isolation: "worktree",
                }),
                once: true,
            },
            // Parent turn 2: recover from deny ("incompatible") and finish.
            { match: "incompatible", events: text("PARENT-RECOVERED-FROM-DENY") },
            // GUARD: if the runner DID run the child despite the deny, this fires.
            { match: "would-checkpoint-in-worktree", events: text("CHILD-RAN-DESPITE-DENY") },
        ]);
        const out = await withTimeout(runAgent(cfg({
            llm,
            stream: new RecordingStream(),
            registry: new ToolRegistry(defaultTools),
            messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
            subagent: { maxDepth: 3 },
            maxTurns: 5,
        })), 15_000, "subagent-checkpoint-worktree-incompat");
        expect(out.reason).toBe("completed");
        expect(llm.log).toContain("PARENT-GO");
        expect(llm.log).toContain("incompatible");
        expect(llm.log).not.toContain("CHILD-RAN-DESPITE-DENY");
        expect(llm.log).not.toContain("would-checkpoint-in-worktree");
        const finalAssistant = out.messages.findLast((m) => m.role === "assistant");
        const finalText = (finalAssistant?.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("");
        expect(finalText).toContain("PARENT-RECOVERED-FROM-DENY");
        // The deny tool_result carries `ok:false` + an "incompatible" body.
        const denyTR = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result" && b.content.toLowerCase().includes("incompatible")));
        expect(denyTR.length).toBeGreaterThan(0);
    });
    test("checkpoint absent ⇒ NO `**Checkpoint**:` block in child seed (regression)", async () => {
        const llm = new RoutingLLM([
            // Parent: spawn child WITHOUT checkpoint.
            {
                match: "PARENT-GO",
                events: toolCall("a1", "agent", { prompt: "BARE-CHILD-SEED no checkpoint" }),
                once: true,
            },
            { match: "Subagent completed", events: text("PARENT-DONE") },
            // GUARD: if the runner injected a checkpoint block uninvited, this would fire.
            {
                match: "**Checkpoint**:",
                events: text("CHILD-SAW-CHECKPOINT-UNINVITED"),
                once: true,
            },
            // Child's actual first turn — bare-prompt rule.
            {
                match: "BARE-CHILD-SEED",
                events: text("CHILD-DONE-BARE"),
                once: true,
            },
        ]);
        const out = await withTimeout(runAgent(cfg({
            llm,
            stream: new RecordingStream(),
            registry: new ToolRegistry(defaultTools),
            messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
            subagent: { maxDepth: 3 },
            maxTurns: 5,
        })), 15_000, "subagent-checkpoint-absent");
        expect(out.reason).toBe("completed");
        // The bare-prompt rule fired; the checkpoint-block rule did NOT.
        expect(llm.log).toContain("BARE-CHILD-SEED");
        expect(llm.log).not.toContain("**Checkpoint**:");
        expect(llm.log).not.toContain("CHILD-SAW-CHECKPOINT-UNINVITED");
        expect(llm.log.some((l) => l.startsWith("UNMATCHED"))).toBe(false);
        // Direct check: the child's first-turn observation contains the prompt but
        // NOT the `**Checkpoint**:` marker — byte-identical to the legacy non-opt-in
        // call path for the checkpoint dimension.
        const childSeedTurn = llm.observations.find((t) => t.includes("BARE-CHILD-SEED no checkpoint"));
        expect(childSeedTurn).toBeDefined();
        expect(childSeedTurn).not.toContain("**Checkpoint**:");
        expect(childSeedTurn).not.toContain(".subagent-state/");
        const finalAssistant = out.messages.findLast((m) => m.role === "assistant");
        const finalText = (finalAssistant?.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("");
        expect(finalText).toContain("PARENT-DONE");
    });
});
