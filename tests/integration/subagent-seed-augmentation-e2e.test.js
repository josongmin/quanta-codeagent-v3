import { describe, expect, test } from "bun:test";
import { runAgent } from "@/agent";
import { defaultTools, ToolRegistry } from "@/tool";
import { cfg, RecordingStream, withTimeout } from "./_harness";
/**
 * Round 2 — E2E: the augmented seed actually reaches the child LLM.
 *
 * The parent's model calls the `agent` tool with `result_shape` + `owned_surfaces`.
 * The runner's `buildSeedPrompt` injects those into the child's seed user
 * message; the routing LLM matches on those markers and proves the child loop
 * received them. Mirrors the RoutingLLM pattern from `subagent-fork-e2e`.
 */
const text = (t) => [
    { type: "text_delta", delta: t },
    { type: "message_stop", stop_reason: "end_turn" },
];
const agentCall = (id, input) => [
    { type: "tool_use_start", id, name: "agent" },
    { type: "tool_use_end", id, input },
    { type: "message_stop", stop_reason: "tool_use" },
];
const conversationText = (input) => input.messages
    .flatMap((m) => m.content.map((b) => b.type === "text" ? b.text : b.type === "tool_result" ? b.content : ""))
    .join(" ");
class RoutingLLM {
    model = "routing-test-model";
    log = [];
    /** Per-turn observations of the FULL conversation text. Lets the test assert
     *  whether the child's first turn saw the augmentation markers. */
    observations = [];
    rules;
    constructor(rules) {
        this.rules = rules.map((r) => ({ ...r }));
    }
    async *stream(input) {
        const txt = conversationText(input);
        this.observations.push(txt);
        const rule = this.rules.find((r) => txt.includes(r.match) && !(r.once && r.spent));
        if (!rule) {
            this.log.push(`UNMATCHED:${txt.slice(0, 60)}`);
            yield* text("unmatched fallback");
            return;
        }
        if (rule.once)
            rule.spent = true;
        this.log.push(rule.match);
        for (const e of rule.events)
            yield e;
    }
}
describe("subagent seed augmentation — e2e child receives result_shape + owned_surfaces", () => {
    test("child's first turn sees `**Final answer format**` and `**Owned surfaces**` in its seed", async () => {
        const llm = new RoutingLLM([
            // Parent: spawn the child with augmentation fields.
            {
                match: "PARENT-GO",
                events: agentCall("a1", {
                    prompt: "CHILD-SEED inspect foo.ts and report",
                    result_shape: "JSON: {ok, summary}",
                    owned_surfaces: ["src/foo.ts"],
                }),
                once: true,
            },
            // After child summary returns to parent, parent finishes.
            { match: "Subagent completed", events: text("PARENT-DONE") },
            // Child first turn — matches on the `Final answer format` marker. If the
            // routing fires on this rule it PROVES the seed augmentation reached the
            // child LLM (otherwise the child's text would lack the marker entirely).
            {
                match: "**Final answer format**",
                events: text("CHILD-OBSERVED-RESULT-SHAPE"),
                once: true,
            },
            // Fallback path if for some reason the child sees the prompt without the
            // augmentation — this would surface a regression as the test asserts the
            // first rule fires.
            { match: "CHILD-SEED", events: text("CHILD-DID-NOT-SEE-AUGMENTATION") },
        ]);
        const out = await withTimeout(runAgent(cfg({
            llm,
            stream: new RecordingStream(),
            registry: new ToolRegistry(defaultTools),
            messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
            subagent: { maxDepth: 3 },
            maxTurns: 5,
        })), 15_000, "subagent-seed-augmentation-e2e");
        expect(out.reason).toBe("completed");
        // The child's first turn fired on the augmentation marker (NOT the prompt-
        // only fallback rule). This is the load-bearing assertion.
        expect(llm.log).toContain("**Final answer format**");
        expect(llm.log).not.toContain("CHILD-SEED");
        expect(llm.log).not.toContain("UNMATCHED");
        // The child's observation of its own first-turn conversation text contains
        // BOTH augmentation blocks — direct proof that `buildSeedPrompt` injected
        // them into the child's seed user-message.
        const childFirstTurnText = llm.observations.find((t) => t.includes("CHILD-SEED") && t.includes("**Final answer format**"));
        expect(childFirstTurnText).toBeDefined();
        expect(childFirstTurnText).toContain("**Owned surfaces**");
        expect(childFirstTurnText).toContain("- src/foo.ts");
        expect(childFirstTurnText).toContain("JSON: {ok, summary}");
        // The child's reply propagates back as the parent's agent tool_result; the
        // parent then finishes with PARENT-DONE.
        const tr = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"));
        expect(tr).toHaveLength(1);
        if (tr[0]?.type !== "tool_result")
            throw new Error("expected tool_result");
        expect(tr[0].content).toContain("CHILD-OBSERVED-RESULT-SHAPE");
        const finalAssistant = out.messages.findLast((m) => m.role === "assistant");
        const finalText = (finalAssistant?.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("");
        expect(finalText).toContain("PARENT-DONE");
    });
});
