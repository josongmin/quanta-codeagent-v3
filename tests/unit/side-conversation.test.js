class FakeLlm {
  script;
  inputs = [];
  model = "fake-side-conv";
  constructor(script) {
    this.script = script;
  }
  async* stream(input) {
    this.inputs.push(input);
    for (const e of this.script)
      yield e;
  }
}
import { describe, expect, it } from "bun:test";
import {
  assertSideConversationEffort,
  DEFAULT_SIDE_CONVERSATION_INPUT_TOKEN_BUDGET,
  filterSideConversationTools,
  runSideConversation,
  SIDE_CONVERSATION_PROMPT,
  SIDE_CONVERSATION_PROMPT_BASE,
  SIDE_CONVERSATION_PROMPT_DELIMITER,
  SIDE_CONVERSATION_QUANTA_ADDENDUM,
  SIDE_CONVERSATION_TOOL_NAMES,
  SideConversationAbortedError,
  SideConversationBudgetError,
  SideConversationEffortError,
  SideConversationToolError
} from "@/agent";
import { planModeMutatingTable } from "@/agent/mode";
const textAnswer = (text, opts) => {
  const ev = [
    { type: "text_delta", delta: text },
    { type: "message_stop", stop_reason: "end_turn" }
  ];
  if (opts) {
    ev.splice(1, 0, {
      type: "usage",
      inputTokens: opts.inputTokens ?? 0,
      outputTokens: opts.outputTokens ?? 0,
      model: "fake-side-conv"
    });
  }
  return ev;
};
describe("side-conversation prompt invariants", () => {
  it("1. byte-identical Codex base prompt \u2014 exact literal pin", () => {
    expect(SIDE_CONVERSATION_PROMPT_BASE).toBe("You are a side-conversation assistant, separate from the main thread. Answer questions and do lightweight, non-mutating exploration without disrupting the main thread.");
  });
  it("2. delimiter present and stable between base and addendum", () => {
    expect(SIDE_CONVERSATION_PROMPT_DELIMITER).toBe(`

--- quanta side-conv addendum ---

`);
    const occurrences = SIDE_CONVERSATION_PROMPT.split(SIDE_CONVERSATION_PROMPT_DELIMITER).length - 1;
    expect(occurrences).toBe(1);
  });
  it("3. SIDE_CONVERSATION_PROMPT == base + delimiter + addendum (no extra content)", () => {
    expect(SIDE_CONVERSATION_PROMPT).toBe(SIDE_CONVERSATION_PROMPT_BASE + SIDE_CONVERSATION_PROMPT_DELIMITER + SIDE_CONVERSATION_QUANTA_ADDENDUM);
  });
});
describe("side-conversation tool allowlist invariants", () => {
  it("4. every allowlisted tool is read-only in planModeMutatingTable", () => {
    const table = planModeMutatingTable();
    for (const name of SIDE_CONVERSATION_TOOL_NAMES) {
      expect(name in table).toBe(true);
      expect(table[name]).toBe(null);
    }
  });
  it("5. allowlist EQUALS planModeMutatingTable read-only set \u2014 fails loudly on drift", () => {
    const table = planModeMutatingTable();
    const readOnly = Object.keys(table).filter((k) => table[k] === null).sort();
    const allowed = [...SIDE_CONVERSATION_TOOL_NAMES].sort();
    expect(allowed).toEqual(readOnly);
  });
});
describe("side-conversation effort runtime guard", () => {
  it('6. rejects "high" via `as any` bypass', () => {
    expect(() => assertSideConversationEffort("high")).toThrow(SideConversationEffortError);
  });
  it('7. rejects "xhigh" from JSON.parse', () => {
    const parsed = JSON.parse('{"effort":"xhigh"}');
    expect(() => assertSideConversationEffort(parsed.effort)).toThrow(SideConversationEffortError);
  });
  it("8. rejects null / undefined / object", () => {
    expect(() => assertSideConversationEffort(null)).toThrow(SideConversationEffortError);
    expect(() => assertSideConversationEffort(undefined)).toThrow(SideConversationEffortError);
    expect(() => assertSideConversationEffort({ effort: "low" })).toThrow(SideConversationEffortError);
    expect(() => assertSideConversationEffort("low")).not.toThrow();
    expect(() => assertSideConversationEffort("medium")).not.toThrow();
  });
});
describe("filterSideConversationTools", () => {
  it("9. rejects a mutating tool (write)", () => {
    const tools = [{ name: "write", description: "x", input_schema: {} }];
    expect(() => filterSideConversationTools(tools)).toThrow(SideConversationToolError);
  });
  it("10. rejects an unknown tool", () => {
    const tools = [{ name: "totally_made_up", description: "x", input_schema: {} }];
    expect(() => filterSideConversationTools(tools)).toThrow(SideConversationToolError);
  });
});
describe("runSideConversation behavior", () => {
  it("11. returns answer + tokens + duration", async () => {
    const llm = new FakeLlm(textAnswer("hello world", { inputTokens: 12, outputTokens: 34 }));
    const result = await runSideConversation({
      parentSessionId: "parent-1",
      question: "What is 2+2?",
      llm
    });
    expect(result.answer).toBe("hello world");
    expect(result.tokens).toEqual({ input: 12, output: 34 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.stopReason).toBe("end_turn");
    expect(llm.inputs[0]?.system).toBe(SIDE_CONVERSATION_PROMPT);
  });
  it("12. emits OTel span with thread.side / kind / parent_id", async () => {
    const llm = new FakeLlm(textAnswer("ok", { inputTokens: 5, outputTokens: 6 }));
    let captured;
    await runSideConversation({
      parentSessionId: "parent-2",
      question: "ping?",
      llm,
      observe: (s) => {
        captured = s;
      }
    });
    expect(captured).toBeDefined();
    expect(captured?.["quanta.thread.side"]).toBe(true);
    expect(captured?.["quanta.thread.kind"]).toBe("side");
    expect(captured?.["quanta.thread.parent_id"]).toBe("parent-2");
    expect(captured?.["gen_ai.usage.input_tokens"]).toBe(5);
    expect(captured?.["gen_ai.usage.output_tokens"]).toBe(6);
  });
  it("13. aborts when parent signal fires before streaming", async () => {
    const llm = new FakeLlm(textAnswer("never-seen"));
    const ac = new AbortController;
    ac.abort();
    await expect(runSideConversation({
      parentSessionId: "p",
      question: "q",
      llm,
      signal: ac.signal
    })).rejects.toBeInstanceOf(SideConversationAbortedError);
    expect(llm.inputs.length).toBe(0);
  });
  it("14. rejects over-budget input (pre-stream)", async () => {
    const llm = new FakeLlm(textAnswer("ok"));
    const long = "x".repeat(DEFAULT_SIDE_CONVERSATION_INPUT_TOKEN_BUDGET * 4 + 100);
    await expect(runSideConversation({
      parentSessionId: "p",
      question: long,
      llm
    })).rejects.toBeInstanceOf(SideConversationBudgetError);
    expect(llm.inputs.length).toBe(0);
  });
  it("15. rejects over-budget output (post-stream)", async () => {
    const llm = new FakeLlm(textAnswer("ok", { inputTokens: 1, outputTokens: 9999 }));
    await expect(runSideConversation({
      parentSessionId: "p",
      question: "small",
      llm,
      outputTokenBudget: 100
    })).rejects.toBeInstanceOf(SideConversationBudgetError);
  });
});
