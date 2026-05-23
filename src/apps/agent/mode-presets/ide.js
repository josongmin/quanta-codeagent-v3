/**
 * Mode-preset runner — IDE (ADR-0092, C1).
 *
 * The `mode === "ide"` cell: editor-embedded (VS Code / Tauri). The HOST (the
 * IDE extension) drives the conversation — it seeds `req.base.messages`, owns
 * the `req.base.stream` (a structured event channel the editor UI consumes),
 * and supplies the reviewer modal via `req.base.onConfirm`. This server-side
 * runner only ASSEMBLES the ide-mode config (validating the matrix +
 * branch_search default-on) and runs the loop; the actual editor adapter lives
 * outside this repo (it injects stream/onConfirm/messages).
 *
 * Levers (see `agent/run-mode/presets.ts#IDE`): reviewer-backed permission,
 * user-stop, user-cwd, STRUCTURED output, host deps (IDE context provider +
 * full LSP tools), persistent memory, full-trajectory observation.
 *
 * branch_search default-on (ADR-0084): N=3, tsc+lint, worktree isolation —
 * IDE users get speculative N-best on hard edits unless the caller overrides.
 *
 * Slice boundary: imports `@/agent`, `@/llm`, `@/permission`, `@/shared`,
 * `@/tool`, `@/stream`, and sibling assemble.ts. NO mode-preset sibling import.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Exterior adapter contract (VS Code / Tauri host, OUT OF REPO):
 *
 *   The IDE host (extension or sidecar process) is responsible for SEEDING
 *   these fields on `req.base` before calling `runMode`. The contract is
 *   declarative — this runner does NOT construct any of them, only validates
 *   they are present in their expected slot or falls back to safe defaults.
 *
 *     - `req.base.messages` — user prompt seed (chat history if reused).
 *     - `req.base.stream` — STRUCTURED event channel the editor UI consumes
 *       (e.g. SSE bridge → webview, MessagePort, Tauri command). Falls back
 *       to `StdoutStream` ONLY for the headless smoke test — production
 *       hosts MUST inject their own.
 *     - `req.base.onConfirm` — reviewer modal hook. The IDE shows a Code
 *       Action / Quickpick / modal and resolves the boolean. This is the
 *       single source of human consent for the `ide` cell (reviewer-backed
 *       permission lever).
 *     - `req.base.permission` — initial PermissionContext (defaults to
 *       `{ mode: "default" }`). The host can promote to acceptEdits per
 *       turn via the standard PermissionContext mutations.
 *     - `req.base.ideContextProvider` (optional) — see `src/agent/ide-
 *       context.ts`. The IDE host injects active file + selection +
 *       diagnostics per turn via this provider.
 *     - `req.base.sessionId` (optional) — stable id so persistent memory
 *       (mode lever) survives reloads.
 *
 *   Exit code mapping is owned by `exitCodeForOutcome` (../run.ts) — the
 *   editor host should map non-zero exits to a visible status badge.
 * ──────────────────────────────────────────────────────────────────────────
 */
import { buildSystemPrompt } from "@/agent";
import { StdoutStream } from "@/stream";
import { buildDefaultTools, ToolRegistry } from "@/tool";
import { assembleAgentConfig, resolveRunAgent, } from "../assemble";
import { exitCodeForOutcome } from "../run";
/** Per-branch verify budget for IDE: 60s — interactive surface, a human is
 *  waiting, so cap each speculative branch tighter than the autonomous daemon. */
const IDE_BRANCH_TIMEOUT_MS = 60_000;
/** IDE default branch_search: interactive budget (N=3, fast verifiers). */
const IDE_BRANCH_SEARCH = {
    defaultN: 3,
    defaultVerifierKinds: ["tsc", "lint"],
    timeoutPerBranchMs: IDE_BRANCH_TIMEOUT_MS,
    isolation: "worktree",
};
const buildIdeBase = (req) => {
    const cwd = req.base.cwd ?? process.cwd();
    // The IDE host normally injects a structured StreamPort; StdoutStream is a
    // safe fallback for a headless smoke of the ide assembly.
    const stream = req.base.stream ?? new StdoutStream();
    const permission = req.base.permission ?? { mode: "default" };
    // DIP factory call; the IDE host injects its own registry in production. The
    // fallback has no preset-specific fs/diagnostics ports (IDE's LSP diagnostics
    // arrive via the host-injected registry, not via the default factory).
    const registry = req.base.registry instanceof ToolRegistry
        ? req.base.registry
        : new ToolRegistry(buildDefaultTools());
    return {
        ...req.base,
        llm: req.base.llm,
        registry,
        stream,
        permission,
        messages: req.base.messages ?? [],
        system: req.base.system ?? buildSystemPrompt(cwd),
        cwd,
        maxTurns: req.base.maxTurns ?? 200,
        signal: req.base.signal ?? new AbortController().signal,
        // branch_search default-on unless the caller already chose.
        branchSearch: req.base.branchSearch ?? IDE_BRANCH_SEARCH,
    };
};
export const runMode = async (req) => {
    if (req.mode !== "ide") {
        throw new Error(`ide.runMode: req.mode must be "ide", got "${req.mode}"`);
    }
    const base = buildIdeBase(req);
    const cfg = assembleAgentConfig({ ...req, base });
    const runner = resolveRunAgent(req.seams);
    const outcome = await runner(cfg);
    return { exitCode: exitCodeForOutcome(outcome), outcome };
};
