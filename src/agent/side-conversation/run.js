/**
 * Side-conversation executor (ADR-0049).
 *
 * The seam itself: a lightweight read-only sub-thread that runs alongside the
 * main agent loop without disrupting it. Patterned after Codex Desktop's
 * `codex.thread.side` surface (build 2867, round-4 capture
 * [[codex-desktop-build-2867-round-4]] §G).
 *
 * Split out of `side-conversation.ts` (#10): this module holds the EXECUTOR
 * (`runSideConversation`), the tool allowlist + filter, the options/result
 * types, the four error classes, the effort guard, and token estimation. The
 * byte-identical prompt constants live in `./prompt.ts`; the external dispatch
 * indirection lives in `./dispatch.ts`.
 *
 * ## What this is, and what it is NOT
 *
 * It IS:
 *   - A separate model invocation against a restricted tool subset
 *     ({@link SIDE_CONVERSATION_TOOL_NAMES}, all read-only).
 *   - A child OTel span tagged with `quanta.thread.side = true` and
 *     `quanta.thread.kind = "side"`, parented to the caller's thread span via
 *     `quanta.thread.parent_id`.
 *   - A one-shot exchange: one user question → one assistant answer. No
 *     tool-loop, no multi-turn, no memory persistence.
 *
 * It is NOT:
 *   - A subagent (ADR-0041). Subagents own their own working tree, get a
 *     nickname from the pool (ADR-0042), have a full 6-tool surface
 *     (spawn/wait/close + exec/write_stdin/send_input), and run an `runAgent`
 *     fork. Side-conversations get NO nickname, NO worktree, NO mutating
 *     tools, NO recursion.
 *   - Plan-mode (ADR-0036). Plan-mode is a sticky posture of the MAIN thread.
 *     Side-conv is a separate thread with its own (much stricter) gating.
 *   - A way to inject prompts that the main thread will obey. The
 *     side-conversation answer is returned to the CALLER, never spliced into
 *     the main message history. The caller (UI, CLI, parent agent) decides
 *     what to do with it.
 *
 * The `quanta.thread.side` attribute is INTENTIONALLY namespaced (not
 * `codex.thread.side`) — we are mirroring the seam, not the wire format.
 */
import { assembleFromEvents } from "@/llm";
import { GEN_AI_ATTRS, QUANTA_ATTRS } from "@/observability";
import { QuantaError } from "@/shared";
import { SIDE_CONVERSATION_PROMPT } from "./prompt";
// ===========================================================================
// Tool allowlist — read-only by construction
// ===========================================================================
/**
 * Tools a side-conversation is permitted to call.
 *
 * Two invariants enforced by tests:
 *   1. Every name here MUST appear in `planModeMutatingTable()` as
 *      classification `null` (read-only).
 *   2. EVERY read-only name in `planModeMutatingTable()` MUST appear here
 *      (otherwise the allowlist has silently desynced — a new read-only tool
 *      that should also be available to side-conv has been added but
 *      forgotten). Toggling that invariant requires updating BOTH lists
 *      consciously.
 *
 * No mutating tool may be added here. Any attempt is caught by
 * `tests/unit/side-conversation.test.ts::"allowlist is exactly the read-only complement"`.
 */
export const SIDE_CONVERSATION_TOOL_NAMES = Object.freeze([
    "read",
    "grep",
    "glob",
    "localize",
    "diagnostics",
    "test_runner",
    "lsp_definition",
    "lsp_references",
    "lsp_hover",
    "lsp_type_definition",
    "lsp_implementation",
    "lsp_document_symbol",
    "lsp_workspace_symbol",
    "lsp_rename_preview",
    "git_status",
    "git_log",
    "git_diff",
    "git_blame",
    "git_blame_heatmap",
    "git_churn",
    "git_upstream_check",
    "file_tree_summary",
    "parse_test_failure",
]);
/** Default token budget. Mirrors the Codex side-conv ceiling. */
export const DEFAULT_SIDE_CONVERSATION_INPUT_TOKEN_BUDGET = 8192;
export const DEFAULT_SIDE_CONVERSATION_OUTPUT_TOKEN_BUDGET = 4096;
/** Coarse token estimate — same heuristic the loop uses for compaction.
 *  4 chars/token is intentionally pessimistic and avoids importing the
 *  larger compaction module. */
export const estimateSideConversationTokens = (text) => Math.ceil(text.length / 4);
// ===========================================================================
// Errors
// ===========================================================================
/** Effort outside the {@link SideConversationEffort} domain (caught at
 *  runtime so `as any` / `JSON.parse` cannot smuggle `"high"` / `"xhigh"`). */
export class SideConversationEffortError extends QuantaError {
    attempted;
    constructor(attempted) {
        super("side_conversation_effort", `Side-conversation rejects effort=${JSON.stringify(attempted)}. ` +
            `Allowed: "low" | "medium" (side-conv is read-only-lightweight by contract).`);
        this.attempted = attempted;
    }
}
/** Tool not in the allowlist (mutating or unknown). */
export class SideConversationToolError extends QuantaError {
    toolName;
    constructor(toolName) {
        super("side_conversation_tool", `Tool "${toolName}" is not in SIDE_CONVERSATION_TOOL_NAMES. ` +
            `Side-conversations are read-only by construction.`);
        this.toolName = toolName;
    }
}
/** Token budget exceeded. */
export class SideConversationBudgetError extends QuantaError {
    direction;
    observed;
    limit;
    constructor(direction, observed, limit) {
        super("side_conversation_budget", `Side-conversation ${direction} token budget exceeded: ` +
            `observed=${observed} > limit=${limit}. ` +
            `Raise the budget explicitly or trim the question.`);
        this.direction = direction;
        this.observed = observed;
        this.limit = limit;
    }
}
/** Parent signal aborted before the side-conv produced a result. */
export class SideConversationAbortedError extends QuantaError {
    constructor() {
        super("side_conversation_aborted", "Side-conversation aborted (parent turn signalled abort).");
    }
}
// ===========================================================================
// Effort guard
// ===========================================================================
const ALLOWED_EFFORTS = new Set(["low", "medium"]);
/**
 * Runtime guard against `as any` / JSON-deserialization bypass. The type
 * already rejects `"high"` / `"xhigh"` at compile time, but values arriving
 * from JSON, RPC, or untyped boundaries can smuggle invalid strings; this
 * throws on anything outside the allowed set, including `undefined` only when
 * the caller explicitly set the field (we treat unset = `"low"`).
 */
export const assertSideConversationEffort = (value) => {
    if (typeof value !== "string" || !ALLOWED_EFFORTS.has(value)) {
        throw new SideConversationEffortError(String(value));
    }
};
// ===========================================================================
// Tool allowlist guard
// ===========================================================================
const SIDE_CONVERSATION_TOOL_SET = new Set(SIDE_CONVERSATION_TOOL_NAMES);
/** Filter a tool-schema list down to exactly the side-conv-allowed names.
 *  Throws on any name not in the allowlist (no silent drops — a mistake at
 *  the caller is a bug). */
export const filterSideConversationTools = (tools) => {
    for (const t of tools) {
        if (!SIDE_CONVERSATION_TOOL_SET.has(t.name)) {
            throw new SideConversationToolError(t.name);
        }
    }
    return [...tools];
};
// ===========================================================================
// runSideConversation — the seam
// ===========================================================================
/**
 * Run one side-conversation invocation against {@link SideConversationOptions.llm}.
 *
 * Contract:
 *   - Single LLM call; no tool-loop.
 *   - Returns the assembled assistant text answer (plus token accounting).
 *   - Throws {@link SideConversationEffortError} on out-of-range effort
 *     (including `as any` bypass).
 *   - Throws {@link SideConversationToolError} on a tool not in
 *     {@link SIDE_CONVERSATION_TOOL_NAMES}.
 *   - Throws {@link SideConversationBudgetError} when input estimate or
 *     observed output exceeds the budget.
 *   - Throws {@link SideConversationAbortedError} when the abort signal
 *     fires before completion.
 *
 * The parent agent loop is NEVER touched. The caller — UI composer, CLI
 * slash-command, or another agent — handles routing the answer back to
 * whatever surface asked for it.
 *
 * TODO(absorb #3 cont.): wire plan-exit-flow into side-conversation at
 * `runSideConversation` AFTER the assembled answer is produced and BEFORE
 * the return, IFF the assembled `stopReason`/answer carries a "plan
 * complete" signal AND the caller injected a `planExitPort`. The current
 * shape — one-shot read-only LLM call with no tool-loop and no in-band
 * "plan complete" marker — does not give us a structurally clean observation
 * point: the side-conv is model→model, not user-decision, and its result
 * is already returned to the CALLER, who is the natural site to consult the
 * port. The pure orchestrator (`./plan-exit-flow.ts`) ships standalone and
 * importable; the missing piece is a side-conv-emitted plan-complete signal
 * (e.g. a structured tag in the assistant text, or a sentinel stop reason)
 * that the runner can pattern-match on without changing the prompt's
 * byte-identical invariant. Until that signal exists, callers (loop /
 * CLI / IDE) import `runPlanExitFlow` directly.
 */
/** Validate effort + budgets up-front. Throws on violation. Pure. */
const checkPreflight = (opts) => {
    const effortValue = opts.effort ?? "low";
    assertSideConversationEffort(effortValue);
    const inputBudget = opts.inputTokenBudget ?? DEFAULT_SIDE_CONVERSATION_INPUT_TOKEN_BUDGET;
    const outputBudget = opts.outputTokenBudget ?? DEFAULT_SIDE_CONVERSATION_OUTPUT_TOKEN_BUDGET;
    const promptEstimate = estimateSideConversationTokens(SIDE_CONVERSATION_PROMPT) +
        estimateSideConversationTokens(opts.question);
    if (promptEstimate > inputBudget) {
        throw new SideConversationBudgetError("input", promptEstimate, inputBudget);
    }
    if (opts.signal?.aborted)
        throw new SideConversationAbortedError();
    return { inputBudget, outputBudget };
};
/** Drain the LLM stream with per-event abort checks. Returns the assembled
 *  event list plus the last-observed usage. Throws
 *  {@link SideConversationAbortedError} on abort; other errors propagate. */
const drainStream = async (opts, tools) => {
    const messages = [{ role: "user", content: [{ type: "text", text: opts.question }] }];
    const events = [];
    let inputTokens = 0;
    let outputTokens = 0;
    try {
        for await (const ev of opts.llm.stream({
            messages,
            system: SIDE_CONVERSATION_PROMPT,
            tools,
        })) {
            if (opts.signal?.aborted)
                throw new SideConversationAbortedError();
            events.push(ev);
            if (ev.type === "usage") {
                inputTokens = ev.inputTokens;
                outputTokens = ev.outputTokens;
            }
        }
    }
    catch (e) {
        if (opts.signal?.aborted && !(e instanceof SideConversationAbortedError)) {
            throw new SideConversationAbortedError();
        }
        throw e;
    }
    return { events, inputTokens, outputTokens };
};
/** Build the OTel span attribute set for one side-conv invocation. */
const buildSpan = (parentSessionId, durationMs, inputTokens, outputTokens) => {
    const attrs = {
        [QUANTA_ATTRS.thread.side]: true,
        [QUANTA_ATTRS.thread.kind]: "side",
        [QUANTA_ATTRS.thread.parentId]: parentSessionId,
        [QUANTA_ATTRS.turn.durationMs]: durationMs,
    };
    if (inputTokens)
        attrs[GEN_AI_ATTRS.usage.inputTokens] = inputTokens;
    if (outputTokens)
        attrs[GEN_AI_ATTRS.usage.outputTokens] = outputTokens;
    return attrs;
};
export const runSideConversation = async (opts) => {
    const { outputBudget } = checkPreflight(opts);
    const tools = opts.tools ? filterSideConversationTools(opts.tools) : [];
    const started = Date.now();
    const { events, inputTokens, outputTokens } = await drainStream(opts, tools);
    if (outputTokens > outputBudget) {
        throw new SideConversationBudgetError("output", outputTokens, outputBudget);
    }
    const assembled = assembleFromEvents(events);
    const answer = assembled.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    const durationMs = Date.now() - started;
    opts.observe?.(buildSpan(opts.parentSessionId, durationMs, inputTokens, outputTokens));
    return {
        answer,
        tokens: { input: inputTokens, output: outputTokens },
        durationMs,
        stopReason: assembled.stopReason,
    };
};
