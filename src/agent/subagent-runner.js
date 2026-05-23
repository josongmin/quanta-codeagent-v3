/**
 * @/agent-side implementation of the subagent slice's injected port.
 *
 * The subagent slice (`src/subagent/**`) deliberately does NOT import
 * `@/agent`; it depends only on the {@link SubagentRunner} signature. This
 * module is the host wire-up: it forks the real agent loop (`runAgent`) into a
 * child run with its own conversation seed, a filtered tool registry, a
 * dropped long-term store (a child must never persist into the parent's
 * memory), and an abort signal chained to the parent's.
 *
 * Recommended `AgentConfig` field (host wires this; OUT of this file's scope):
 *
 *   subagent?: { runner: SubagentRunner; maxDepth?: number }
 *
 * The host builds the runner with `createSubagentRunner(parentConfig, { ... })`
 * and threads it (plus `maxDepth`) onto the parent config so the `agent` tool
 * can spawn children.
 *
 * --- DEPTH SEAM + the recursion bound (accurate as of today) ---
 *
 * Recursion is bounded MULTI-LEVEL by `maxDepth` (the depth guard is real and
 * load-bearing) — read both parts:
 *
 *   1. `AgentConfig` carries an optional `depth?: number`
 *      (`src/agent/types.ts`); this runner sets it on the child to `req.depth`
 *      (see {@link buildChildConfig}), and `src/agent/dispatch.ts` surfaces it
 *      onto the ToolContext:
 *        const ctx: ToolContext =
 *          { cwd: config.cwd, signal: config.signal,
 *            ...(config.depth !== undefined ? { depth: config.depth } : {}) }
 *      Absent ⇒ omitted, slice duck-reads it as 0, root path byte-identical.
 *      The `agent` tool reads it via `ctxDepth` (`src/subagent/agent-tool.ts`).
 *
 *   2. {@link buildChildConfig} propagates `parent.subagent` into the child
 *      (but NOT `skills` — a subagent gets a clean tool surface). So a forked
 *      child's `runAgent` → `buildSessionFeatures` DOES register an `agent`
 *      tool: a child can spawn sub-subagents. Each level's `req.depth` is
 *      `parentDepth + 1` (via (1)), so this runner's `req.depth > maxDepth ⇒
 *      deny` guard (and the tool's mirror guard) terminate the recursion at
 *      `maxDepth` (default 3) with a recoverable deny tool_result — never an
 *      unbounded spawn.
 *
 * Consequence: depth is plumbed (1) AND exercised (2). The `req.depth >
 * maxDepth ⇒ deny, never throw` guard is the REAL, load-bearing recursion
 * bound (not belt-and-braces). Beyond maxDepth the nested `agent` call returns
 * a recoverable "max subagent depth exceeded" tool_result and the parent
 * continues. Verified end-to-end by tests/integration/subagent-fork-e2e.test.ts.
 *
 * --- CANCELLATION SEAM ---
 *
 * The child's `signal` is composed from TWO sources via {@link chainedSignal}:
 *   - Parent loop abort (`parent.signal`) — existing, propagates user/host
 *     cancellation down the fork tree.
 *   - Per-task abort (`req.signal`, driven by `TaskRegistry.stop(id)` from the
 *     `task_stop` tool) — NEW, lets an in-flight forked `runAgent` unwind on a
 *     targeted cancel without aborting the whole parent loop.
 * Either signal aborting aborts the child. Composition happens once in
 * {@link buildChildConfig} so both worktree-isolated and non-isolated paths
 * inherit it.
 *
 * --- CODEX SEED-AUGMENTATION SEAM ---
 *
 * The child's seed prompt is built by {@link buildSeedPrompt} from up to five
 * optional {@link SubagentRequest} fields. Full ordering when all set:
 *   1. `priorAttempt` block (Codex `resume_agent`, PREPENDED above prompt)
 *   2. `req.prompt`
 *   3. `ownedSurfaces` block (Codex ownership boundary)
 *   4. `forbiddenSurfaces` block (Codex ownership boundary)
 *   5. `checkpointPath` block (Codex `checkpoint`, operational guidance)
 *   6. `resultShape` block (Codex `expected_output_shape`)
 * When none are set the seed is byte-identical to `req.prompt`.
 */
import { isGitRepo, withWorktree } from "@/runtime";
import { ToolRegistry } from "@/tool";
import { runAgent } from "./loop";
const DEFAULT_MAX_DEPTH = 3;
/** Join the trailing assistant turn's text blocks into the child's answer.
 *  Mirrors the slice contract ("final assistant text the child produced"). */
const lastAssistantText = (messages) => {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === "assistant") {
            const text = m.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("")
                .trim();
            if (text !== "")
                return text;
        }
    }
    return "";
};
/** Map a finished {@link AgentOutcome} onto the slice's {@link SubagentResult}.
 *  `ok` is true only for a clean `completed`; everything else (max_turns,
 *  aborted, error) is a non-ok result the parent surfaces to the model. */
const toResult = (outcome) => ({
    ok: outcome.reason === "completed",
    finalText: lastAssistantText(outcome.messages),
    turns: outcome.turns,
    messages: outcome.messages,
});
/** Build the filtered child registry. The slice's `toolFilter` is a tool-name
 *  allowlist; we re-enumerate the parent registry via its public `specs()`
 *  names + `get(name)` (no private enumerator exists) and reconstruct a fresh
 *  {@link ToolRegistry} from the intersection. Absent filter ⇒ inherit the
 *  parent registry as-is. An empty/all-miss filter yields an empty registry
 *  (the child simply has no tools — it can still answer from the prompt). */
const filterRegistry = (parent, toolFilter) => {
    if (!toolFilter)
        return parent;
    const allow = new Set(toolFilter);
    const kept = parent
        .specs()
        .map((s) => s.name)
        .filter((name) => allow.has(name))
        .map((name) => parent.get(name))
        .filter((t) => t !== undefined);
    return new ToolRegistry(kept);
};
/** Compose the child's {@link AbortSignal} from up to two sources: the parent
 *  loop's signal and an optional per-request signal (e.g. the `TaskRegistry`
 *  per-task controller driven by `task_stop`). Aborting EITHER source aborts
 *  the child. When `extra` is absent we return `parent` directly — the child
 *  config never aborts its own signal, so sharing the parent's is safe and
 *  keeps the no-extra path allocation-free. With `extra`, `AbortSignal.any`
 *  returns a fresh signal that aborts when ANY input aborts (already-aborted
 *  inputs produce an already-aborted result). */
const chainedSignal = (parent, extra) => extra ? AbortSignal.any([parent, extra]) : parent;
/** Build the child's seed user-prompt text. When the caller sets NONE of the
 *  five opt-in fields (`priorAttempt`, `ownedSurfaces`, `forbiddenSurfaces`,
 *  `checkpointPath`, `resultShape`) the result is byte-identical to
 *  `req.prompt` (preserves the legacy non-opt-in call path — load-bearing
 *  regression invariant). Ordering rationale: prior context first (warm-start
 *  the child), then the task, then boundary constraints, then operational
 *  guidance (checkpoint), then the output spec. */
const buildSeedPrompt = (req) => {
    const parts = [];
    if (req.priorAttempt && req.priorAttempt.length > 0) {
        parts.push(`## Previous attempt's findings\n${req.priorAttempt}\n\n## Current task\n${req.prompt}`);
    }
    else {
        parts.push(req.prompt);
    }
    if (req.ownedSurfaces && req.ownedSurfaces.length > 0) {
        parts.push(`**Owned surfaces** (you may read/modify these): ${req.ownedSurfaces.map((s) => `- ${s}`).join("\n")}`);
    }
    if (req.forbiddenSurfaces && req.forbiddenSurfaces.length > 0) {
        parts.push(`**Forbidden surfaces** (do NOT touch): ${req.forbiddenSurfaces.map((s) => `- ${s}`).join("\n")}`);
    }
    if (req.checkpointPath && req.checkpointPath.length > 0) {
        parts.push(`**Checkpoint**: Write your interim progress to \`${req.checkpointPath}\` every few turns (use the \`write\` or \`edit\` tool). The parent uses this file to monitor and to recover work if you are stopped.`);
    }
    if (req.resultShape && req.resultShape.length > 0) {
        parts.push(`**Final answer format**: ${req.resultShape}`);
    }
    return parts.join("\n\n");
};
/** Construct the CHILD {@link AgentConfig} by shallow-cloning `parent` and
 *  applying the subagent overrides (see the override table in the report).
 *  `store`/`hooks`/`metrics`/`run`/`sessionId`/`memory` are DROPPED so a child
 *  never persists into the parent's long-term memory or pollutes its
 *  correlation/observability; `llm`/`stream`/`permission`/`system` are kept.
 *  Seed is `[{ role: "user", content: [{ type: "text", text:
 *  buildSeedPrompt(req) }] }]` — see {@link buildSeedPrompt} for the
 *  five-field (priorAttempt / ownedSurfaces / forbiddenSurfaces /
 *  checkpointPath / resultShape) augmentation rules. */
const buildChildConfig = (parent, req, cwd) => {
    const seed = [
        { role: "user", content: [{ type: "text", text: buildSeedPrompt(req) }] },
    ];
    // Shallow clone, then strip the inheritance-unsafe keys. We rebuild the
    // object explicitly (rather than `delete`) to satisfy
    // exactOptionalPropertyTypes: omit keys entirely, never assign `undefined`.
    const child = {
        llm: parent.llm,
        registry: filterRegistry(parent.registry, req.toolFilter),
        stream: parent.stream,
        permission: parent.permission,
        messages: seed,
        system: parent.system,
        cwd,
        maxTurns: req.budget?.maxTurns ?? parent.maxTurns,
        // Child abort is composed from BOTH the parent loop's signal and the
        // per-request signal (driven by `TaskRegistry.stop(id)` from `task_stop`).
        // Either source aborting unwinds the forked `runAgent`. See chainedSignal.
        signal: chainedSignal(parent.signal, req.signal),
        // Recursion-depth marker; dispatch.ts surfaces it onto ToolContext so the
        // child's `agent` tool computes `childDepth = depth+1`. With `subagent`
        // propagated below, this is LOAD-BEARING: the maxDepth guard actually
        // bounds real multi-level recursion. Duck-typed cast sets it
        // unconditionally without tripping exactOptionalPropertyTypes.
        ...{ depth: req.depth },
        // Kept (safe to share, no parent-state mutation):
        ...(parent.onConfirm ? { onConfirm: parent.onConfirm } : {}),
        ...(parent.embedder ? { embedder: parent.embedder } : {}),
        ...(parent.compaction ? { compaction: parent.compaction } : {}),
        ...(parent.planMode !== undefined ? { planMode: parent.planMode } : {}),
        // Codex-absorption inheritance (Round 2 fix): a child fork MUST
        // inherit the parent's safety / interaction posture or read-only modes
        // (review/audit) silently broaden in the child. Read-only modes block
        // mutating tools at dispatch — if the child collapses to `default`, a
        // review-posture parent could spawn a child that writes. Verify/closeout
        // guards and HITL 4-tier are also safety contracts the child must honor.
        ...(parent.mode !== undefined ? { mode: parent.mode } : {}),
        ...(parent.verifyGuard !== undefined ? { verifyGuard: parent.verifyGuard } : {}),
        ...(parent.closeoutGuard !== undefined ? { closeoutGuard: parent.closeoutGuard } : {}),
        ...(parent.hitl !== undefined ? { hitl: parent.hitl } : {}),
        // Propagated so a child can itself spawn sub-subagents — recursion is
        // bounded by the depth marker above + this runner's `req.depth > maxDepth`
        // deny guard (now the real, exercised bound, not belt-and-braces). Skills
        // are intentionally NOT propagated (a subagent gets a clean tool surface).
        ...(parent.subagent ? { subagent: parent.subagent } : {}),
        // DROPPED on purpose: store, sessionId, memory, hooks, metrics, run,
        // repoRules, globRules, workingState. A subagent must not write into the
        // parent's durable memory, emit into the parent's hook bus / metrics, or
        // share its correlation context. `repoRules` / `globRules` are dropped
        // because the child may run in a different `cwd` (worktree fork), where the
        // parent's file-scoped rules are stale authority. `workingState` is
        // session-scoped (Codex memory L3) — each agent gets a fresh scratchpad.
    };
    return child;
};
/**
 * Build the @/agent-side {@link SubagentRunner}. The host calls this once with
 * the parent {@link AgentConfig} and threads the returned runner (plus the
 * recommended `subagent.maxDepth`) so the `agent` tool can fork the loop.
 *
 * Each invocation:
 *  - DEPTH GUARD: `req.depth > maxDepth ⇒` resolve a non-ok result (never
 *    throw) — this is the authoritative recursion bound.
 *  - builds a child config (see {@link buildChildConfig} / override table);
 *  - `isolation:"worktree"` + parent cwd is a git repo ⇒ run inside a
 *    throwaway worktree (`withWorktree`) with the child cwd = worktree path;
 *    not a git repo ⇒ silently fall back to no isolation (never fail);
 *  - maps the {@link AgentOutcome} onto a {@link SubagentResult}.
 */
export const createSubagentRunner = (parent, opts = {}) => {
    const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    const run = opts.run ?? runAgent;
    const gitProbe = opts.isGitRepo ?? isGitRepo;
    const wt = opts.withWorktree ?? withWorktree;
    return async (req) => {
        if (req.depth > maxDepth) {
            return { ok: false, finalText: "max subagent depth exceeded", turns: 0 };
        }
        const wantsWorktree = req.isolation === "worktree";
        const isolate = wantsWorktree && (await gitProbe(parent.cwd));
        if (isolate) {
            // id is sanitized by withWorktree's safeId; depth+prompt make it
            // human-traceable while staying within the worktree-name charset.
            const id = `sub-d${req.depth}-${Date.now().toString(36)}`;
            const { value } = await wt(id, parent.cwd, async (worktreePath) => {
                const child = buildChildConfig(parent, req, worktreePath);
                return run(child);
            });
            return toResult(value);
        }
        // No isolation (explicit "none", missing, or worktree requested but the
        // parent cwd is not a git repo — graceful fallback, never fail). The child
        // always inherits `parent.cwd` here; the worktree path is only ever the
        // override in the isolated branch above.
        const child = buildChildConfig(parent, req, parent.cwd);
        return toResult(await run(child));
    };
};
