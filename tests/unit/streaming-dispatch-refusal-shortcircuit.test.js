import { describe, expect, test } from "bun:test";
import { streamingTurn } from "@/agent/streaming-dispatch";
async function* gen(events) {
  for (const ev of events) {
    yield ev;
    await Promise.resolve();
  }
}
const toolUse = (id, name, input) => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input }
];
const okBlock = (id, content) => ({
  block: { type: "tool_result", tool_use_id: id, content },
  ok: true,
  preview: content
});
const makeHarness = (safeNames) => {
  const dispatchCalls = [];
  return {
    dispatchCalls,
    isConcurrencySafe: (name) => safeNames.includes(name),
    dispatch: async (call) => {
      dispatchCalls.push(call.id);
      await new Promise((r) => setTimeout(r, 5));
      return okBlock(call.id, `out-${call.id}`);
    }
  };
};
describe("ADR-0076 Gap-5 \u2014 refusal short-circuits Phase 3 deferred dispatch", () => {
  test("NI-1: bash (unsafe) tool_use_end + refusal \u21D2 dispatch NEVER called", async () => {
    const { dispatchCalls, isConcurrencySafe, dispatch } = makeHarness([]);
    const events = [
      ...toolUse("t1", "bash", { command: "echo malicious" }),
      { type: "text_delta", delta: "On reflection, I refuse." },
      { type: "message_stop", stop_reason: "refusal" }
    ];
    const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch });
    expect(res.kind).toBe("assembled");
    if (res.kind !== "assembled")
      return;
    expect(res.stopReason).toBe("refusal");
    expect(dispatchCalls).toEqual([]);
  });
  test("NI-2: resultBlocks is EMPTY when all calls were deferred on refusal", async () => {
    const { isConcurrencySafe, dispatch } = makeHarness([]);
    const events = [
      ...toolUse("t1", "bash", { command: "x" }),
      ...toolUse("t2", "bash", { command: "y" }),
      { type: "message_stop", stop_reason: "refusal" }
    ];
    const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch });
    expect(res.kind).toBe("assembled");
    if (res.kind !== "assembled")
      return;
    expect(res.resultBlocks).toEqual([]);
  });
  test("NI-3: byte-identical for tool_use stop \u2014 Phase 3 STILL runs (regression guard)", async () => {
    const { dispatchCalls, isConcurrencySafe, dispatch } = makeHarness([]);
    const events = [
      ...toolUse("t1", "bash", { command: "ls" }),
      { type: "message_stop", stop_reason: "tool_use" }
    ];
    const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch });
    expect(res.kind).toBe("assembled");
    if (res.kind !== "assembled")
      return;
    expect(res.stopReason).toBe("tool_use");
    expect(dispatchCalls).toEqual(["t1"]);
    expect(res.resultBlocks).toHaveLength(1);
  });
  test("NI-4: overlap-safe call already in flight RESOLVES even on refusal", async () => {
    const { dispatchCalls, isConcurrencySafe, dispatch } = makeHarness(["read"]);
    const events = [
      ...toolUse("safe1", "read", { path: "/a" }),
      { type: "text_delta", delta: "Decided to refuse" },
      { type: "message_stop", stop_reason: "refusal" }
    ];
    const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch });
    expect(res.kind).toBe("assembled");
    if (res.kind !== "assembled")
      return;
    expect(res.stopReason).toBe("refusal");
    expect(dispatchCalls).toEqual(["safe1"]);
    expect(res.resultBlocks).toHaveLength(1);
    expect(res.resultBlocks[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "safe1"
    });
  });
  test("NI-4b: mixed in-flight safe + deferred unsafe \u2014 only the safe survivor produces a block", async () => {
    const { dispatchCalls, isConcurrencySafe, dispatch } = makeHarness(["read"]);
    const events = [
      ...toolUse("safe1", "read", { path: "/a" }),
      ...toolUse("unsafe2", "bash", { command: "rm -rf" }),
      { type: "message_stop", stop_reason: "refusal" }
    ];
    const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch });
    expect(res.kind).toBe("assembled");
    if (res.kind !== "assembled")
      return;
    expect(dispatchCalls).toEqual(["safe1"]);
    expect(res.resultBlocks).toHaveLength(1);
    expect(res.resultBlocks[0]).toMatchObject({ tool_use_id: "safe1" });
  });
  test("NI-5: assembled message STILL carries the orphan tool_use blocks (assembler unchanged)", async () => {
    const { isConcurrencySafe, dispatch } = makeHarness([]);
    const events = [
      ...toolUse("t1", "bash", { command: "echo x" }),
      { type: "message_stop", stop_reason: "refusal" }
    ];
    const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch });
    expect(res.kind).toBe("assembled");
    if (res.kind !== "assembled")
      return;
    const toolBlocks = res.message.content.filter((b) => b.type === "tool_use");
    expect(toolBlocks).toHaveLength(1);
  });
  test("NI-1b: refusal with zero tool calls \u2014 empty result, no dispatch (sanity)", async () => {
    const { dispatchCalls, isConcurrencySafe, dispatch } = makeHarness([]);
    const events = [
      { type: "text_delta", delta: "I refuse." },
      { type: "message_stop", stop_reason: "refusal" }
    ];
    const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch });
    expect(res.kind).toBe("assembled");
    if (res.kind !== "assembled")
      return;
    expect(dispatchCalls).toEqual([]);
    expect(res.resultBlocks).toEqual([]);
  });
  test("NI-3b: byte-identical for end_turn stop \u2014 Phase 3 STILL runs", async () => {
    const { dispatchCalls, isConcurrencySafe, dispatch } = makeHarness([]);
    const events = [
      ...toolUse("t1", "bash", { command: "ls" }),
      { type: "message_stop", stop_reason: "end_turn" }
    ];
    const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch });
    if (res.kind !== "assembled")
      throw new Error("expected assembled");
    expect(dispatchCalls).toEqual(["t1"]);
  });
});
