/** Last ThinkingBlock in assembly order, or undefined. Used to attach a
 *  streamed `signature_delta` to the thinking block it closes. */
const findLastThinking = (content) => {
    for (let i = content.length - 1; i >= 0; i--) {
        const b = content[i];
        if (b?.type === "thinking")
            return b;
    }
    return undefined;
};
/** Append a `text_delta`'s text: extends the trailing TextBlock or opens a
 *  new one. Other block kinds at the tail are NOT extended — text never
 *  merges into thinking / tool_use. */
const appendTextDelta = (content, delta) => {
    const last = content.at(-1);
    if (last?.type === "text")
        last.text += delta;
    else
        content.push({ type: "text", text: delta });
};
/** ADR-0076 Gap-2: accumulate extended-thinking / reasoning content. A run
 *  of consecutive thinking_delta events folds into one ThinkingBlock; the
 *  first delta after any NON-thinking block (text / tool_use) opens a fresh
 *  block, so provider-ordered multi-block thinking is preserved. The
 *  `redacted` flag is sticky to the block it opens — an opaque ciphertext
 *  block never merges with a plaintext one. */
const appendThinkingDelta = (content, text, redacted) => {
    const last = content.at(-1);
    if (last?.type === "thinking" && !!last.redacted === redacted) {
        last.thinking += text;
        return;
    }
    content.push({
        type: "thinking",
        thinking: text,
        ...(redacted ? { redacted: true } : {}),
    });
};
/** ADR-0076 Gap-2: Anthropic streams the signature for the just-emitted
 *  thinking block. Attach it to the most-recent ThinkingBlock (the one this
 *  signature closes); chunked signatures accumulate. A signature with no
 *  preceding thinking block is structurally impossible from the provider;
 *  if it ever occurs we drop it rather than fabricate a content block. */
const appendSignatureDelta = (content, signature) => {
    const thinking = findLastThinking(content);
    if (thinking)
        thinking.signature = (thinking.signature ?? "") + signature;
};
/** ADR-0077 phase marker — STRUCTURAL post-pass.
 *
 *  Tag every {@link TextBlock} in `content` with its conversational phase by
 *  ONE backward scan:
 *    - while the scan has not yet seen a `tool_use`, encountered text is
 *      `"final_answer"` (model's trailing closeout);
 *    - once a `tool_use` has been seen, every text block to the LEFT is
 *      `"commentary"` (model talked, then acted).
 *
 *  This is a pure function with no heuristics — the rule is "a text block at
 *  index `i` is commentary IFF `∃ j > i : content[j].type === "tool_use"`".
 *  Non-text blocks pass through untouched. Mutates the array in place so a
 *  byte-identical caller (one that ignores `phase`) sees zero observable
 *  change in shape.
 *
 *  Deterministic. Idempotent (running it twice yields the same tags). */
export const determinePhases = (content) => {
    let sawToolUse = false;
    for (let i = content.length - 1; i >= 0; i--) {
        const b = content[i];
        if (b === undefined)
            continue;
        if (b.type === "tool_use") {
            sawToolUse = true;
            continue;
        }
        if (b.type !== "text")
            continue;
        b.phase = sawToolUse ? "commentary" : "final_answer";
    }
};
/** Reconstruct the assistant message from a stream of {@link StreamEvent}.
 *  Anthropic streams content blocks sequentially (one completes before the
 *  next starts), so we can append by position without interleave tracking. */
export const assembleFromEvents = (events) => {
    let content = [];
    let stopReason = "end_turn";
    for (const ev of events) {
        switch (ev.type) {
            case "stream_reset":
                // Tombstone: the events seen so far are a dead partial. Drop all
                // accumulated content/blocks and stop-reason so the assembled message
                // reflects ONLY the replacement stream that follows.
                content = [];
                stopReason = "end_turn";
                break;
            case "text_delta":
                appendTextDelta(content, ev.delta);
                break;
            case "thinking_delta":
                appendThinkingDelta(content, ev.text, ev.redacted === true);
                break;
            case "signature_delta":
                appendSignatureDelta(content, ev.signature);
                break;
            case "tool_use_start":
                content.push({ type: "tool_use", id: ev.id, name: ev.name, input: {} });
                break;
            case "tool_use_end": {
                const block = content.find((b) => b.type === "tool_use" && b.id === ev.id);
                if (block?.type === "tool_use")
                    block.input = ev.input;
                break;
            }
            case "tool_use_delta":
                break;
            case "response_in_progress":
                // Heartbeat / "thinking…" indicator (ADR-0048). NOT content; assemblers
                // explicitly skip it so the reconstructed message is byte-identical to
                // a stream that never emitted any heartbeat.
                break;
            case "usage":
                // Token accounting, not content. Assemblers ignore it so the
                // reconstructed message is identical whether or not a usage event was
                // emitted. Listed explicitly to satisfy the `default: never` pin below.
                break;
            case "message_stop":
                stopReason = ev.stop_reason;
                break;
            default: {
                // Exhaustiveness pin: a new StreamEvent variant fails compilation here
                // and must consciously decide whether it contributes to the assembled
                // message — no silent drop.
                const _exhaustive = ev;
                void _exhaustive;
                break;
            }
        }
    }
    // ADR-0077 post-pass: tag each TextBlock with its structural phase. Single
    // backward scan in `determinePhases` — see its doc comment for the rule.
    determinePhases(content);
    return { message: { role: "assistant", content }, stopReason };
};
/** True when the assembled turn contains at least one tool call. */
export const hasToolUse = (m) => m.content.some((b) => b.type === "tool_use");
