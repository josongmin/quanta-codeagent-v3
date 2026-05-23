/**
 * Mode-policy presets — the 4×12 lever matrix per RFC may-22 §4.
 *
 * Every cell is defined; matrix violations (e.g. `batch` + `reviewer-backed`
 * permission) cannot exist here because the four entries are written by hand
 * and the `narrowMode` helper would refuse the wrong shape at compile time
 * anyway.
 *
 * Budget defaults are propositional — every value comes from this single
 * source-of-truth file. The loop never literal-compares against a number;
 * it reads from a `BudgetMeter` constructed with these dials.
 */
const INTERACTIVE = {
    mode: "interactive",
    permission: { kind: "reviewer-backed" },
    termination: { kind: "user-stop" },
    sandbox: { kind: "user-cwd" },
    output: { kind: "stdout-chat" },
    externalDeps: { kind: "host" },
    toolSurface: { kind: "full" },
    promptPack: { kind: "assistant" },
    memory: { kind: "persistent" },
    observation: { kind: "stream-only" },
    network: { kind: "open" },
    gitWrite: { kind: "free" },
    secrets: { kind: "host-env" },
};
const HEADLESS = {
    mode: "headless",
    permission: { kind: "auto", policy: "acceptEdits" },
    termination: { kind: "single-turn" },
    sandbox: { kind: "user-cwd" },
    output: { kind: "stdout-chat" },
    externalDeps: { kind: "hermetic-with-overrides" },
    toolSurface: { kind: "headless-safe" },
    promptPack: { kind: "task-runner" },
    memory: { kind: "ephemeral" },
    observation: { kind: "stream-only" },
    network: { kind: "open" },
    gitWrite: { kind: "free" },
    secrets: { kind: "scoped" },
};
const BATCH = {
    mode: "batch",
    permission: { kind: "auto", policy: "acceptEdits" },
    termination: { kind: "verdict" },
    sandbox: { kind: "per-instance" },
    output: { kind: "structured" },
    externalDeps: { kind: "hermetic" },
    toolSurface: { kind: "bench" },
    promptPack: { kind: "benchmark" },
    memory: { kind: "disabled" },
    observation: { kind: "full-trajectory" },
    network: { kind: "denied" },
    gitWrite: { kind: "snapshot-only" },
    secrets: { kind: "none" },
};
const CI_BOT = {
    mode: "ci-bot",
    permission: { kind: "auto", policy: "acceptEdits" },
    termination: { kind: "diff-ready" },
    sandbox: { kind: "branch-only" },
    output: { kind: "github-check" },
    externalDeps: { kind: "hermetic-with-overrides" },
    toolSurface: { kind: "ci-restricted" },
    promptPack: { kind: "pr-agent" },
    memory: { kind: "ephemeral" },
    observation: { kind: "structured-report" },
    network: { kind: "allowlist" },
    gitWrite: { kind: "branch-only" },
    secrets: { kind: "scoped" },
};
/** IDE (ADR-0092, C1) — editor-embedded surface (VS Code / Tauri). Distinct
 *  from `interactive` on OUTPUT (`structured` events the IDE UI parses, not
 *  `stdout-chat`) + `full-trajectory` observation. Otherwise human-near like
 *  interactive (reviewer-backed via an IDE modal, user-cwd, host deps + full
 *  LSP tools, persistent memory). */
const IDE = {
    mode: "ide",
    permission: { kind: "reviewer-backed" },
    termination: { kind: "user-stop" },
    sandbox: { kind: "user-cwd" },
    output: { kind: "structured" },
    externalDeps: { kind: "host" },
    toolSurface: { kind: "full" },
    promptPack: { kind: "assistant" },
    memory: { kind: "persistent" },
    observation: { kind: "full-trajectory" },
    network: { kind: "open" },
    gitWrite: { kind: "free" },
    secrets: { kind: "host-env" },
};
/** DAEMON (ADR-0092, C1) — long-running scheduled service (nightly PR review,
 *  webhook responder). Distinct from `headless` (one-shot) on memory
 *  (`persistent` cron-to-cron) + sandbox (`per-instance` worktree) +
 *  termination (`diff-ready`) + network (`allowlist`) + gitWrite
 *  (`branch-only`). No human ⇒ auto/acceptEdits within the allowlist. */
const DAEMON = {
    mode: "daemon",
    permission: { kind: "auto", policy: "acceptEdits" },
    termination: { kind: "diff-ready" },
    sandbox: { kind: "per-instance" },
    output: { kind: "structured" },
    externalDeps: { kind: "hermetic-with-overrides" },
    toolSurface: { kind: "headless-safe" },
    promptPack: { kind: "task-runner" },
    memory: { kind: "persistent" },
    observation: { kind: "full-trajectory" },
    network: { kind: "allowlist" },
    gitWrite: { kind: "branch-only" },
    secrets: { kind: "scoped" },
};
/** The full 6×12 matrix. Indexing is `MODE_PRESETS[mode]`. */
export const MODE_PRESETS = {
    interactive: INTERACTIVE,
    headless: HEADLESS,
    batch: BATCH,
    "ci-bot": CI_BOT,
    ide: IDE,
    daemon: DAEMON,
};
/**
 * Per-mode budget defaults. These are *baseline* dials a caller can override
 * (the meter constructor merges caller dials over these). They are explicit
 * here so the only "magic numbers" in the codebase live in one operator-
 * visible table; the loop never reads them directly.
 *
 * Rationale:
 *   - interactive: generous turns, no wall-clock (human-paced)
 *   - headless: single-shot — turns/calls capped tight
 *   - batch: per-task budget bounded; cost cap enforced
 *   - ci-bot: PR-sized — small turn budget, branch-only
 */
const INTERACTIVE_BUDGET = {
    maxTurns: 200,
    maxRetries: 8,
    maxConsecutiveFailures: 5,
};
const HEADLESS_BUDGET = {
    maxTurns: 20,
    maxWallClockMs: 600_000, // 10 min
    maxModelCalls: 40,
    maxRetries: 4,
    maxConsecutiveFailures: 3,
};
const BATCH_BUDGET = {
    maxTurns: 60,
    maxWallClockMs: 1_800_000, // 30 min
    maxModelCalls: 120,
    maxToolCalls: 400,
    maxShellCommands: 200,
    maxTestRuns: 60,
    maxCostUsd: 5,
    maxRetries: 6,
    maxConsecutiveFailures: 4,
};
const CI_BOT_BUDGET = {
    maxTurns: 30,
    maxWallClockMs: 900_000, // 15 min
    maxModelCalls: 60,
    maxToolCalls: 200,
    maxShellCommands: 80,
    maxFilesChanged: 50,
    maxPatchBytes: 200_000,
    maxCostUsd: 2,
    maxRetries: 5,
    maxConsecutiveFailures: 3,
};
/** IDE: human-paced like interactive — generous turns, no wall-clock cap. */
const IDE_BUDGET = {
    maxTurns: 200,
    maxRetries: 8,
    maxConsecutiveFailures: 5,
};
/** DAEMON: bounded per scheduled task (cron-sized) — branch-only, cost-capped. */
const DAEMON_BUDGET = {
    maxTurns: 40,
    maxWallClockMs: 1_200_000, // 20 min
    maxModelCalls: 80,
    maxToolCalls: 250,
    maxShellCommands: 100,
    maxFilesChanged: 60,
    maxCostUsd: 3,
    maxRetries: 5,
    maxConsecutiveFailures: 4,
};
export const BUDGET_PRESETS = {
    interactive: INTERACTIVE_BUDGET,
    headless: HEADLESS_BUDGET,
    batch: BATCH_BUDGET,
    "ci-bot": CI_BOT_BUDGET,
    ide: IDE_BUDGET,
    daemon: DAEMON_BUDGET,
};
