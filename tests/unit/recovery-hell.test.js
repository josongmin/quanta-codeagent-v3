import { describe, expect, test } from "bun:test";
import { decideOnAssembled, freshRecovery } from "@/agent/loop";
const assistant = (...content) => ({ role: "assistant", content });
const textMsg = (text) => assistant({ type: "text", text });
const toolMsg = (id) => assistant({ type: "tool_use", id, name: "read", input: { path: "/x" } });
const thinkingMsg = (think) => assistant({ type: "thinking", thinking: think });
const empty = () => assistant();
describe("ADR-0076 NI-1 \u2014 refusal terminal across every assistant content shape", () => {
  test("refusal + plain text content \u21D2 typed refusal carrying the text (the canonical case)", () => {
    const rec = freshRecovery();
    const a = decideOnAssembled("refusal", textMsg("I can't help with that."), rec);
    expect(a.do).toBe("refusal");
    if (a.do === "refusal")
      expect(a.rationale).toBe("I can't help with that.");
  });
  test("refusal + tool_use block \u21D2 refusal (tool MUST NOT execute; rationale='' since no text block)", () => {
    const rec = freshRecovery();
    const a = decideOnAssembled("refusal", toolMsg("t1"), rec);
    expect(a.do).toBe("refusal");
    if (a.do === "refusal")
      expect(a.rationale).toBe("");
  });
  test("refusal + ThinkingBlock content \u21D2 refusal with rationale='' (thinking is NOT a public SAY)", () => {
    const rec = freshRecovery();
    const a = decideOnAssembled("refusal", thinkingMsg("I shouldn't continue."), rec);
    expect(a.do).toBe("refusal");
    if (a.do === "refusal")
      expect(a.rationale).toBe("");
  });
  test("refusal + empty message content \u21D2 refusal with rationale='' (beats the empty-turn branch)", () => {
    const rec = freshRecovery();
    const a = decideOnAssembled("refusal", empty(), rec);
    expect(a.do).toBe("refusal");
    if (a.do === "refusal")
      expect(a.rationale).toBe("");
  });
  test("refusal + multi-block (text + tool_use + thinking) \u21D2 refusal carrying ONLY the text block", () => {
    const rec = freshRecovery();
    const msg = assistant({ type: "thinking", thinking: "deliberation" }, { type: "text", text: "I cannot." }, { type: "tool_use", id: "t1", name: "read", input: {} });
    const a = decideOnAssembled("refusal", msg, rec);
    expect(a.do).toBe("refusal");
    if (a.do === "refusal")
      expect(a.rationale).toBe("I cannot.");
  });
});
describe("ADR-0076 \u2014 refusal does not consume same-turn recovery budget", () => {
  test("rec.outputContinues unchanged (refusal is not a `max_tokens` style nudge)", () => {
    const rec = freshRecovery();
    decideOnAssembled("refusal", textMsg("no"), rec);
    expect(rec.outputContinues).toBe(0);
  });
  test("rec.malformedRetries unchanged (refusal is not a malformed-tool retry)", () => {
    const rec = freshRecovery();
    decideOnAssembled("refusal", toolMsg("t1"), rec);
    expect(rec.malformedRetries).toBe(0);
  });
  test("rec.consecutiveEmpties unchanged (refusal is not an empty-turn nudge)", () => {
    const rec = freshRecovery();
    decideOnAssembled("refusal", empty(), rec);
    expect(rec.consecutiveEmpties).toBe(0);
  });
  test("after 10 consecutive refusals, recovery state is byte-identical to fresh", () => {
    const rec = freshRecovery();
    for (let i = 0;i < 10; i++)
      decideOnAssembled("refusal", textMsg("no"), rec);
    expect(rec).toEqual(freshRecovery());
  });
  test("refusal is idempotent: same input \u21D2 same output (no hidden state in policy)", () => {
    const rec = freshRecovery();
    const a1 = decideOnAssembled("refusal", textMsg("no"), rec);
    const a2 = decideOnAssembled("refusal", textMsg("no"), rec);
    expect(a1).toEqual(a2);
  });
});
describe("ADR-0076 SOTA++ \u2014 refusal rationale (surface contract)", () => {
  test("rationale carries the assistant's visible text verbatim (parse-able by host UIs)", () => {
    const rec = freshRecovery();
    const a = decideOnAssembled("refusal", textMsg("I will not help with that."), rec);
    if (a.do !== "refusal")
      throw new Error("expected refusal");
    expect(a.rationale).toBe("I will not help with that.");
  });
  test("rationale is empty string when the refusing message had no visible text", () => {
    const rec = freshRecovery();
    const a = decideOnAssembled("refusal", empty(), rec);
    if (a.do !== "refusal")
      throw new Error("expected refusal");
    expect(a.rationale).toBe("");
    expect(typeof a.rationale).toBe("string");
  });
});
describe("ADR-0076 \u2014 exact-match: false-positive variants stay un-branched", () => {
  test("`Refusal` (capitalized) \u21D2 proceed (no case folding)", () => {
    const rec = freshRecovery();
    const a = decideOnAssembled("Refusal", textMsg("hi"), rec);
    expect(a.do).toBe("proceed");
  });
  test("`REFUSAL` (upper) \u21D2 proceed", () => {
    const rec = freshRecovery();
    const a = decideOnAssembled("REFUSAL", textMsg("hi"), rec);
    expect(a.do).toBe("proceed");
  });
  test("`refused` (past tense, sibling) \u21D2 proceed (not the canonical literal)", () => {
    const rec = freshRecovery();
    const a = decideOnAssembled("refused", textMsg("hi"), rec);
    expect(a.do).toBe("proceed");
  });
  test("`blocked` (a different stop word) \u21D2 proceed", () => {
    const rec = freshRecovery();
    const a = decideOnAssembled("blocked", textMsg("hi"), rec);
    expect(a.do).toBe("proceed");
  });
  test("leading/trailing whitespace `' refusal '` \u21D2 proceed (no trim)", () => {
    const rec = freshRecovery();
    const a = decideOnAssembled(" refusal ", textMsg("hi"), rec);
    expect(a.do).toBe("proceed");
  });
  test("empty string stop_reason \u21D2 proceed (defensive fall-through)", () => {
    const rec = freshRecovery();
    const a = decideOnAssembled("", textMsg("hi"), rec);
    expect(a.do).toBe("proceed");
  });
  test("`refusal` substring inside a longer reason \u21D2 proceed (no substring match)", () => {
    const rec = freshRecovery();
    const a = decideOnAssembled("user-refusal-override", textMsg("hi"), rec);
    expect(a.do).toBe("proceed");
  });
});
describe("ADR-0076 NI-2 \u2014 `pause_turn` / `content_filtered` / `guardrail_intervened` stay un-branched", () => {
  test("`pause_turn` \u21D2 proceed (server-tool resume; we ship no server tools)", () => {
    const rec = freshRecovery();
    const a = decideOnAssembled("pause_turn", textMsg("ack"), rec);
    expect(a.do).toBe("proceed");
  });
  test("`content_filtered` \u21D2 proceed (no Bedrock guardrail integration)", () => {
    const rec = freshRecovery();
    const a = decideOnAssembled("content_filtered", textMsg("ack"), rec);
    expect(a.do).toBe("proceed");
  });
  test("`guardrail_intervened` \u21D2 proceed (NI-2 \u2014 adding a branch is cargo)", () => {
    const rec = freshRecovery();
    const a = decideOnAssembled("guardrail_intervened", textMsg("ack"), rec);
    expect(a.do).toBe("proceed");
  });
  test("ADDING any of these to a branch later would break this test \u2014 that's the point", () => {
    const rec = freshRecovery();
    expect(decideOnAssembled("pause_turn", textMsg("x"), rec).do).toBe("proceed");
    expect(decideOnAssembled("content_filtered", textMsg("x"), rec).do).toBe("proceed");
    expect(decideOnAssembled("guardrail_intervened", textMsg("x"), rec).do).toBe("proceed");
  });
});
describe("ADR-0076 \u2014 refusal precedence over other branches", () => {
  test("refusal precedence is structural, not budget-driven", () => {
    const rec = freshRecovery();
    rec.consecutiveEmpties = 99;
    const a = decideOnAssembled("refusal", empty(), rec);
    expect(a.do).toBe("refusal");
  });
  test("refusal precedence holds even after a prior `max_tokens` nudge consumed budget", () => {
    const rec = freshRecovery();
    rec.outputContinues = 2;
    const a = decideOnAssembled("refusal", textMsg("no"), rec);
    expect(a.do).toBe("refusal");
  });
  test("refusal precedence holds even after a prior malformed-tool nudge consumed budget", () => {
    const rec = freshRecovery();
    rec.malformedRetries = 1;
    const a = decideOnAssembled("refusal", toolMsg("t1"), rec);
    expect(a.do).toBe("refusal");
  });
});
describe("ADR-0076 \u2014 baseline non-refusal stops continue to route correctly", () => {
  test("`end_turn` + text content \u21D2 proceed (normal completion path)", () => {
    const rec = freshRecovery();
    expect(decideOnAssembled("end_turn", textMsg("done"), rec).do).toBe("proceed");
  });
  test("`tool_use` + tool blocks \u21D2 proceed (normal dispatch path)", () => {
    const rec = freshRecovery();
    expect(decideOnAssembled("tool_use", toolMsg("t1"), rec).do).toBe("proceed");
  });
  test("`stop` (OpenAI literal) + text content \u21D2 proceed (fall-through is the contract)", () => {
    const rec = freshRecovery();
    expect(decideOnAssembled("stop", textMsg("ok"), rec).do).toBe("proceed");
  });
  test("arbitrary novel stop_reason + text content \u21D2 proceed (open-set tolerance)", () => {
    const rec = freshRecovery();
    expect(decideOnAssembled("future_unknown_stop_2030", textMsg("ok"), rec).do).toBe("proceed");
  });
});
