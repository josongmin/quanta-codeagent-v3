class ScriptedLLM {
  inputs = [];
  calls = 0;
  steps;
  constructor(steps) {
    this.steps = steps;
  }
  async* stream(input) {
    this.inputs.push(input);
    this.calls += 1;
    const step = this.steps.shift() ?? this.steps[this.steps.length - 1];
    if (!step)
      throw new Error("script exhausted");
    for (const ev of step.events)
      yield ev;
  }
}

class RecordingStream {
  events = [];
  emit(event) {
    this.events.push(event);
  }
}
import { describe, expect, test } from "bun:test";
import { runAgent } from "@/agent";
import { defaultTools, ToolRegistry } from "@/tool";
const text = (t, stop) => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: stop }
];
const toolUseThenRefuse = (id, command) => [
  { type: "tool_use_start", id, name: "bash" },
  { type: "tool_use_end", id, input: { command } },
  { type: "text_delta", delta: "On reflection, I refuse." },
  { type: "message_stop", stop_reason: "refusal" }
];
const ev = (events) => ({ kind: "events", events });
const cfg = (over) => ({
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream,
  permission: { mode: "acceptEdits" },
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 3,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over
});
const withTimeout = async (p, ms, label) => {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HANG: ${label} did not terminate in ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer)
      clearTimeout(timer);
  }
};
describe("ADR-0076 \u2014 refusal multi-turn carry-over", () => {
  test("M-1: pure-text refusal DOES append the refusing assistant message to outcome.messages", async () => {
    const llm = new ScriptedLLM([ev(text("I refuse.", "refusal"))]);
    const out = await withTimeout(runAgent(cfg({ llm })), 1e4, "M-1");
    expect(out.reason).toBe("refusal");
    const assistantMessages = out.messages.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBe(1);
    expect(assistantMessages[0]?.content.some((b) => b.type === "text" && b.text === "I refuse.")).toBe(true);
  });
  test("M-2: tool_use mid-stream + refusal \u2014 Gap-5 short-circuit produces zero tool_result blocks", async () => {
    const llm = new ScriptedLLM([ev(toolUseThenRefuse("call1", "echo malicious"))]);
    const out = await withTimeout(runAgent(cfg({ llm })), 1e4, "M-2");
    expect(out.reason).toBe("refusal");
    const toolResults = out.messages.flatMap((m) => m.role === "user" ? m.content.filter((b) => b.type === "tool_result") : []);
    expect(toolResults).toEqual([]);
  });
  test("M-3: byte-identical \u2014 a normal end_turn STILL appends the assistant message", async () => {
    const llm = new ScriptedLLM([ev(text("Done.", "end_turn"))]);
    const out = await withTimeout(runAgent(cfg({ llm })), 1e4, "M-3");
    expect(out.reason).toBe("completed");
    const finalAssistant = out.messages.findLast((m) => m.role === "assistant");
    expect(finalAssistant?.content.some((b) => b.type === "text" && b.text === "Done.")).toBe(true);
  });
  test("M-4: refusal carries typed `refusal.rationale` so host UI can branch without string-parsing", async () => {
    const llm = new ScriptedLLM([ev(text("Sorry, I won't.", "refusal"))]);
    const stream = new RecordingStream;
    const out = await withTimeout(runAgent(cfg({ llm, stream })), 1e4, "M-4");
    expect(out.reason).toBe("refusal");
    expect(out.refusal).toBeDefined();
    expect(out.refusal?.rationale).toBe("Sorry, I won't.");
    const done = stream.events.find((e) => e.type === "done");
    expect(done?.type === "done" && done.reason).toBe("refusal");
  });
  test("M-5: refusal turn DOES count as a turn (turns >= 1) \u2014 terminal but accounted", async () => {
    const llm = new ScriptedLLM([ev(text("Refused.", "refusal"))]);
    const out = await withTimeout(runAgent(cfg({ llm })), 1e4, "M-5");
    expect(out.reason).toBe("refusal");
    expect(out.turns).toBe(1);
  });
});
