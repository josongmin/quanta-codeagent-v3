/**
 * Mode-preset runner — DAEMON (ADR-0092, C1).
 *
 * The `mode === "daemon"` cell: a long-running scheduled service (nightly PR
 * review, webhook responder). The scheduler/host seeds the task on
 * `req.base.messages` and owns the persistent-state store; this runner
 * assembles the daemon-mode config (per-instance worktree sandbox, allowlist
 * network, branch-only git, persistent memory, structured output) and runs ONE
 * task to completion. Persistent cron-to-cron state is the host's concern
 * (it reuses `req.base.store` + `req.base.sessionId`); this runner is the
 * single-task executor.
 *
 * branch_search default-on (ADR-0084): N=3, tsc+lint+lsp_diag, worktree.
 *
 * Slice boundary: imports `@/agent`, `@/llm`, `@/permission`, `@/shared`,
 * `@/tool`, `@/stream`, and sibling assemble.ts. NO mode-preset sibling import.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Exterior adapter contract (scheduler / webhook host, OUT OF REPO):
 *
 *   Daemon mode is a SINGLE-TASK executor. The host (cron service, GitHub
 *   webhook responder, queue worker, …) is responsible for the lifetime
 *   loop AROUND `runMode`. The contract is:
 *
 *     - `req.base.messages` — the task payload (e.g. "review PR #42",
 *       "respond to webhook X").
 *     - `req.base.stream` — STRUCTURED event channel the host persists for
 *       later inspection (e.g. JSONL recorder, S3 log sink). Falls back to
 *       `StdoutStream` ONLY for the headless smoke; production hosts MUST
 *       inject their own.
 *     - `req.base.cwd` — per-instance worktree (the sandbox lever). The host
 *       creates and tears down the worktree; this runner does NOT.
 *     - `req.base.sessionId` (optional) — stable id so persistent memory
 *       (mode lever) carries cron-to-cron. Two consecutive `runMode`
 *       invocations with the same sessionId share memory state.
 *     - `req.base.store` (optional) — persistent state store the host
 *       backs (file / SQLite). This runner reads/writes through it via
 *       the standard mechanisms; ownership is the host's.
 *     - `req.base.permission` — defaults to `{ mode: "acceptEdits" }`
 *       since there is no human. Network is gated by the `allowlist`
 *       lever, git writes are gated by `branch-only`.
 *
 *   Idempotency: invoking `runMode` twice with the same `sessionId` is
 *   safe — the assembler builds a fresh BudgetMeter each call (the meter
 *   is per-task, not per-session). Persistent state lives on
 *   `req.base.store`, which the host owns.
 *
 *   Exit code mapping is owned by `exitCodeForOutcome` (../run.ts) — the
 *   host should propagate non-zero exits to its retry / alert policy.
 * ──────────────────────────────────────────────────────────────────────────
 */
import { buildSystemPrompt } from "@/agent";
import { StdoutStream } from "@/stream";
import { buildDefaultTools, ToolRegistry } from "@/tool";
import { assembleAgentConfig, resolveRunAgent, } from "../assemble";
import { exitCodeForOutcome } from "../run";
/** Per-branch verify budget for daemon: 90s — no human waiting, so allow a
 *  longer speculative branch than IDE for the diagnostic-rich verifier set. */
const DAEMON_BRANCH_TIMEOUT_MS = 90_000;
/** Daemon default branch_search: diagnostic-rich verifiers (next-day review). */
const DAEMON_BRANCH_SEARCH = {
    defaultN: 3,
    defaultVerifierKinds: ["tsc", "lint", "lsp_diag"],
    timeoutPerBranchMs: DAEMON_BRANCH_TIMEOUT_MS,
    isolation: "worktree",
};
const buildDaemonBase = (req) => {
    const cwd = req.base.cwd ?? process.cwd();
    const stream = req.base.stream ?? new StdoutStream();
    // No human ⇒ auto/acceptEdits within the allowlist (network/gitWrite levers
    // enforce the boundary; permission just clears in-scope edits).
    const permission = req.base.permission ?? { mode: "acceptEdits" };
    // DIP factory call; daemon has no preset-specific fs/diagnostics ports.
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
        maxTurns: req.base.maxTurns ?? 40,
        signal: req.base.signal ?? new AbortController().signal,
        branchSearch: req.base.branchSearch ?? DAEMON_BRANCH_SEARCH,
    };
};
export const runMode = async (req) => {
    if (req.mode !== "daemon") {
        throw new Error(`daemon.runMode: req.mode must be "daemon", got "${req.mode}"`);
    }
    const base = buildDaemonBase(req);
    const cfg = assembleAgentConfig({ ...req, base });
    const runner = resolveRunAgent(req.seams);
    const outcome = await runner(cfg);
    return { exitCode: exitCodeForOutcome(outcome), outcome };
};
