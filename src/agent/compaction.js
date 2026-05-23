import { assembleFromEvents } from "@/llm";
import { runtimeConfig } from "@/shared";
/**
 * Single-tier conversation compaction (RFC §8 Phase 2 / §1.2: one tier, no
 * over-engineering). When the running transcript exceeds a token budget we
 * summarize everything older than the last `keepRecentTurns` turns into ONE
 * synthetic user message and keep the recent suffix verbatim.
 *
 * Token estimate: chars/4 heuristic, implemented locally (the memory slice has
 * the same idea but importing @/memory just for arithmetic is not worth the
 * coupling — RFC §3.1).
 *
 * Turn / boundary algorithm (see {@link findBoundary}): we keep the message
 * suffix that covers the last `keepRecentTurns` assistant messages plus their
 * trailing tool_result user messages and any leading user text. The retained
 * suffix MUST be self-consistent: a tool_result block in the suffix whose
 * matching tool_use was summarized away would be orphaned (Anthropic rejects
 * unpaired tool_result). We therefore expand the boundary *backwards* until no
 * retained tool_result references a tool_use that lives in the summarized
 * prefix.
 */
const DEFAULT_THRESHOLD = 120_000;
const DEFAULT_KEEP_TURNS = 6;
/** chars/4 token heuristic over a message list. */
export const estimateTokens = (messages) => {
    let chars = 0;
    for (const m of messages) {
        for (const b of m.content) {
            chars += blockChars(b);
        }
    }
    return Math.ceil(chars / 4);
};
/** Rough context-token footprint of an image, in chars (ADR-0083). The base64
 *  length is NOT a faithful proxy (a 1 MB image is ~1.3 M base64 chars but only
 *  ~1.5 k tokens to the model), so we use a fixed estimate ≈ 1.5 k tokens
 *  (`estimateTokens` divides by 4) — enough to nudge the compaction threshold
 *  without letting a large attachment explode it. */
const IMAGE_CHAR_ESTIMATE = 6000;
const blockChars = (b) => {
    switch (b.type) {
        case "text":
            return b.text.length;
        case "thinking":
            return b.thinking.length;
        case "tool_use":
            return b.name.length + JSON.stringify(b.input ?? {}).length;
        case "tool_result":
            return b.content.length;
        case "image":
            return IMAGE_CHAR_ESTIMATE;
        default: {
            // ContentBlock is a closed union — `_exhaustive` pins it at build time so
            // a new variant fails tsc here instead of silently returning `undefined`
            // (which would corrupt the token estimate). At runtime (e.g. a block from
            // a forward-compat payload) fall back to its serialized length rather than
            // NaN-poisoning the running sum.
            const _exhaustive = b;
            return JSON.stringify(_exhaustive ?? {}).length;
        }
    }
};
const resolveThreshold = (explicit) => {
    if (explicit !== undefined)
        return explicit;
    // S5: env is read in ONE place (runtimeConfig) — validated + frozen at
    // startup. A garbage value there is rejected with a stderr warn rather
    // than silently flipping the threshold here.
    const env = runtimeConfig().compactTokens;
    return env !== undefined ? env : DEFAULT_THRESHOLD;
};
/** tool_use ids referenced by tool_result blocks in `m` (if any). */
const toolResultRefs = (m) => m.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
/** tool_use ids produced by `m` (if any). */
const toolUseIds = (m) => m.content.filter((b) => b.type === "tool_use").map((b) => b.id);
/**
 * Choose the index where the retained suffix begins. Start from the cut that
 * keeps `keepTurns` assistant messages, then walk the boundary earlier while
 * the suffix's first message is a tool_result whose tool_use is NOT in the
 * suffix (would orphan). Never returns < 0; clamps to keep ≥ recent suffix.
 */
export const findBoundary = (messages, keepTurns) => {
    let assistantSeen = 0;
    let idx = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === "assistant") {
            assistantSeen++;
            if (assistantSeen > keepTurns)
                break;
        }
        idx = i;
    }
    // Expand backwards until no retained tool_result is orphaned. The head guard
    // (`idx < messages.length`) matters when the initial scan leaves an EMPTY
    // suffix (`idx === messages.length`, e.g. keepTurns=0 with an assistant tail):
    // there is no retained message to orphan, so `messages[idx]` must NOT be
    // dereferenced (it is `undefined` → TypeError). An empty suffix is already
    // self-consistent, so the walk is a no-op there.
    // Seed the suffix's tool_use ids ONCE for the initial suffix [idx, end), then
    // accumulate incrementally as the boundary walks earlier — each message's
    // ids are added at most once, making the whole walk O(n) instead of the
    // O(n²) of rebuilding the set on every backward step.
    const suffixIds = new Set();
    for (let i = idx; i < messages.length; i++) {
        for (const id of toolUseIds(messages[i]))
            suffixIds.add(id);
    }
    while (idx > 0 && idx < messages.length) {
        const head = messages[idx];
        const orphaned = toolResultRefs(head).some((ref) => !suffixIds.has(ref));
        if (!orphaned)
            break;
        idx--;
        // The message now at `idx` just joined the suffix — fold in its tool_use ids.
        for (const id of toolUseIds(messages[idx]))
            suffixIds.add(id);
    }
    return idx;
};
const SUMMARY_SYSTEM = "You are a transcript compactor. Summarize the conversation so far into a " +
    "terse, information-dense brief: the task, key decisions, files touched, " +
    "tool outcomes (note what was confirmed by running/reading vs. assumed), " +
    "and any open threads. Plain prose, no preamble. Be concise.";
const renderBlock = (b) => {
    switch (b.type) {
        case "text":
            return b.text;
        case "thinking":
            return `(thinking) ${b.thinking}`;
        case "tool_use":
            return `(tool_use ${b.name}) ${JSON.stringify(b.input ?? {})}`;
        case "tool_result":
            return `(tool_result) ${b.content}`;
        case "image":
            return `(image ${b.mediaType})`;
    }
};
const renderForSummary = (messages) => messages.map((m) => `[${m.role}] ${m.content.map(renderBlock).join("\n")}`).join("\n\n");
/** Stream one summary turn with an explicit system prompt and return its
 *  joined text. Shared by proactive ({@link summarize}) and reactive paths. */
const summarizeWith = async (llm, system, prefix) => {
    const events = [];
    for await (const ev of llm.stream({
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: renderForSummary(prefix) }],
            },
        ],
        system,
        tools: [],
    })) {
        events.push(ev);
    }
    const { message } = assembleFromEvents(events);
    return message.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
};
const summarize = (llm, prefix) => summarizeWith(llm, SUMMARY_SYSTEM, prefix);
/**
 * Reactive compaction: a *harder* squeeze than {@link compactIfNeeded}, run
 * only when the loop has already hit a "prompt is too long" API error. The
 * proactive path keeps `DEFAULT_KEEP_TURNS` (6) recent turns; here we keep a
 * much smaller tail (default 2) and use a continuation-summary prompt so the
 * model can *resume the task* from a fresh context rather than just recall
 * history. Reuses {@link findBoundary} (orphan-aware: never splits a
 * tool_use / tool_result pair).
 */
const REACTIVE_KEEP_TURNS = 2;
/**
 * Minimum estimated input tokens before the post-build "did it actually
 * shrink?" guard engages. Below this the prompt is already tiny and a PTL
 * here is spurious; the synthetic continuation header can legitimately be
 * *larger* than a trivial summarized prefix, so applying the drop check would
 * mis-fire. (CC only ever reaches reactive compaction at real context
 * pressure — this floor encodes that precondition explicitly.)
 */
const REACTIVE_MIN_INPUT_TOKENS = 4_000;
/**
 * Required shrink ratio for a reactive compaction to be worth keeping. If the
 * built `[synthetic, ...suffix]` is not at least this fraction smaller than
 * the input, the limiting payload is in the retained suffix (an
 * un-summarizable giant tool_result/file) — fail fast instead of handing the
 * loop a prompt that is still over the window. Mirrors the breaker's
 * `minProgressRatio` (see {@link CompactionBreaker}).
 */
const REACTIVE_MIN_DROP_RATIO = 0.15;
const CONTINUATION_SYSTEM = "You have been working on a coding task but have not completed it. Write a " +
    "structured, concise, actionable continuation summary so you can resume in " +
    "a fresh context: (1) the task/goal, (2) what you've done and learned " +
    "(mark which claims you verified vs. assumed), (3) key files/paths and " +
    "their state, (4) the exact next command/edit to run, not a vague " +
    "direction. Wrap it in <summary></summary>.";
/**
 * Aggressively compact `messages` for PTL recovery. Returns the new array on
 * success. `{ ok:false, reason }` when nothing can be safely summarized away
 * (one indivisible giant turn): the caller must surface a clear failure rather
 * than spin retrying an un-shrinkable prompt.
 */
export const reactiveCompact = async (input) => {
    const keepTurns = input.keepRecentTurns ?? REACTIVE_KEEP_TURNS;
    const boundary = findBoundary(input.messages, keepTurns);
    if (boundary <= 0) {
        return {
            ok: false,
            reason: "prompt still too long after max compaction: no summarizable prefix " +
                "(a single turn exceeds the context window)",
        };
    }
    const prefix = input.messages.slice(0, boundary);
    const suffix = input.messages.slice(boundary);
    const summary = await summarizeWith(input.llm, CONTINUATION_SYSTEM, prefix);
    if (summary.trim() === "") {
        return { ok: false, reason: "continuation summary came back empty" };
    }
    const synthetic = {
        role: "user",
        content: [{ type: "text", text: `<continuation summary>\n${summary}` }],
    };
    const messages = [synthetic, ...suffix];
    // Fail-fast: even with a non-empty summary and a valid boundary the squeeze
    // can be a no-op when the retained suffix itself holds the limiting payload
    // (one giant tool_result/file the orphan-safe boundary cannot drop). Spinning
    // a retry on a prompt that did not shrink just re-hits PTL — surface a clear
    // failure instead. Guarded by REACTIVE_MIN_INPUT_TOKENS so a spurious PTL on
    // an already-tiny transcript (where the synthetic header can exceed a trivial
    // prefix) does not mis-fire. Mirrors CC's rapid_refill_breaker intent.
    const inputTokens = estimateTokens(input.messages);
    const outputTokens = estimateTokens(messages);
    if (inputTokens >= REACTIVE_MIN_INPUT_TOKENS &&
        (inputTokens - outputTokens) / inputTokens < REACTIVE_MIN_DROP_RATIO) {
        return {
            ok: false,
            reason: "prompt still too long after max compaction: reactive compaction " +
                `freed no meaningful context (${inputTokens}→${outputTokens} est. ` +
                "tokens, < 15% drop) — the limiting payload (a giant file read or " +
                "tool output) is in the retained suffix, not the summarized prefix",
        };
    }
    return { ok: true, messages, summaryTokens: estimateTokens([synthetic]) };
};
/**
 * Compact `messages` if over the token threshold. Behavior-preserving when
 * under: returns the same array with `compacted:false`.
 *
 * Cursor-style HITL hook (ADR-0075): when `input.preflight` is provided, the
 * loop checks the threshold + boundary first (cheap pure-arithmetic guards) and
 * ONLY THEN consults the host. A `"defer_one_turn"` reply short-circuits to
 * `{compacted:false}` (the loop's breaker observes the no-op via the same
 * before/after token comparison); `"approve"`/`"force_now"` proceed to the
 * summarizer. Absent preflight ⇒ auto-approve, NO extra await, NO callback
 * allocation — byte-identical to the pre-hook path.
 */
export const compactIfNeeded = async (input) => {
    const threshold = resolveThreshold(input.thresholdTokens);
    const keepTurns = input.keepRecentTurns ?? DEFAULT_KEEP_TURNS;
    const currentTokens = estimateTokens(input.messages);
    if (currentTokens <= threshold) {
        return { compacted: false, messages: input.messages };
    }
    const boundary = findBoundary(input.messages, keepTurns);
    if (boundary <= 0) {
        // Nothing safely summarizable (one giant turn) — leave untouched.
        return { compacted: false, messages: input.messages };
    }
    const prefix = input.messages.slice(0, boundary);
    const suffix = input.messages.slice(boundary);
    // ADR-0075 — preflight HITL. Ordered AFTER the cheap threshold + boundary
    // guards so a degenerate "one giant turn" never wakes the host UI for a
    // decision that can't matter (compaction would no-op anyway). The proposed
    // summary-tokens estimate is the chars/4 heuristic over the prefix (the
    // actual produced summary is typically a fraction of this, but the upper
    // bound is what the UI cares about: "this will summarize up to ~Nk tokens").
    if (input.preflight !== undefined) {
        const decision = await input.preflight({
            currentTokens,
            threshold,
            proposedKeep: keepTurns,
            proposedSummaryTokens: estimateTokens(prefix),
        });
        if (decision === "defer_one_turn") {
            return { compacted: false, messages: input.messages };
        }
        // `approve` and `force_now` both fall through to the summarizer — the
        // loop differentiates them only for emit/log purposes.
    }
    const summary = await summarize(input.llm, prefix);
    const synthetic = {
        role: "user",
        content: [{ type: "text", text: `<conversation summary>\n${summary}` }],
    };
    const messages = [synthetic, ...suffix];
    return { compacted: true, messages, summaryTokens: estimateTokens([synthetic]) };
};
