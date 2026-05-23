/**
 * `BudgetMeter` — pure, deterministic state machine for cumulative
 * per-run quantitative tracking. NO I/O, NO clock side-effects (wall-clock
 * sampling is delegated to a caller-supplied `now()` so tests are
 * deterministic). Every gate is propositional: `dial !== undefined && observed
 * > dial`. There are NO numerical literals in the comparison logic — all
 * thresholds come from the constructor-supplied `BudgetDials`.
 *
 * Lifecycle:
 *   const meter = new BudgetMeter({ dials, caps, exhaustion })
 *   meter.tick("turn")
 *   meter.tick("tool_call")
 *   const e = meter.checkExhausted()  // propositional check across every dial
 *   meter.recordSuccess()              // resets consecutive_failure counter
 *
 * `tick(kind, n?)` increments by `n` (default `1`). `kind` is the closed
 * `TickKind` union — an unknown kind is a TS type error; runtime guards in
 * the switch are defense-in-depth.
 */
/** Default no-op cost estimator (callers wire their own pricing table). */
const ZERO_COST = () => 0;
export class BudgetMeter {
    dials;
    caps;
    exhaustion;
    clock;
    costFn;
    startedAtMs;
    // Counters — pure ints; mutation is the meter's only state.
    turns = 0;
    modelCalls = 0;
    toolCalls = 0;
    shellCommands = 0;
    testRuns = 0;
    inputTokens = 0;
    outputTokens = 0;
    reasoningTokens = 0;
    filesChanged = 0;
    patchBytes = 0;
    retries = 0;
    consecutiveFailures = 0;
    constructor(opts = {}) {
        this.dials = opts.dials ?? {};
        this.caps = opts.caps ?? {};
        this.exhaustion = opts.exhaustion ?? "stop";
        this.clock = opts.now ?? Date.now;
        this.costFn = opts.estimateCostUsd ?? ZERO_COST;
        this.startedAtMs = this.clock();
    }
    /**
     * Increment the counter for `kind` by `n` (default 1). Pure state mutation.
     *
     * `n` is hardened against non-finite / negative deltas. Token + cost dials
     * are fed by provider-reported usage (`loop.ts` passes `ev.inputTokens` /
     * `ev.outputTokens` straight through); when a provider omits a usage field
     * or reports `NaN`, an unguarded `counter += NaN` would POISON the counter
     * for the rest of the run — every later `observed > dial` becomes
     * `NaN > dial === false`, silently DISABLING the token + cost caps. We reject
     * a non-finite or negative `n` (a programmer/provider error) as a no-op so a
     * single bad usage report cannot defeat the budget gate. Valid finite
     * non-negative deltas are unaffected (byte-identical).
     */
    tick(kind, n = 1) {
        if (!Number.isFinite(n) || n < 0)
            return;
        switch (kind) {
            case "turn":
                this.turns += n;
                return;
            case "model_call":
                this.modelCalls += n;
                return;
            case "tool_call":
                this.toolCalls += n;
                return;
            case "shell_command":
                this.shellCommands += n;
                return;
            case "test_run":
                this.testRuns += n;
                return;
            case "input_tokens":
                this.inputTokens += n;
                return;
            case "output_tokens":
                this.outputTokens += n;
                return;
            case "reasoning_tokens":
                this.reasoningTokens += n;
                return;
            case "files_changed":
                this.filesChanged += n;
                return;
            case "patch_bytes":
                this.patchBytes += n;
                return;
            case "retry":
                this.retries += n;
                return;
            case "consecutive_failure":
                this.consecutiveFailures += n;
                return;
            default: {
                // Exhaustive switch — TS narrows `kind` to `never` here. Defense in
                // depth: throw on a programmer error rather than silently drop.
                const _exhaustive = kind;
                throw new Error(`BudgetMeter.tick: unknown kind ${String(_exhaustive)}`);
            }
        }
    }
    /** Reset the consecutive-failure counter (called on successful dispatch). */
    recordSuccess() {
        this.consecutiveFailures = 0;
    }
    /** Snapshot of every counter. Stable — every call returns a fresh object. */
    snapshot() {
        const wallClockMs = this.clock() - this.startedAtMs;
        const costUsd = this.costFn({
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            reasoningTokens: this.reasoningTokens,
        });
        return {
            turns: this.turns,
            modelCalls: this.modelCalls,
            toolCalls: this.toolCalls,
            shellCommands: this.shellCommands,
            testRuns: this.testRuns,
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            reasoningTokens: this.reasoningTokens,
            filesChanged: this.filesChanged,
            patchBytes: this.patchBytes,
            retries: this.retries,
            consecutiveFailures: this.consecutiveFailures,
            wallClockMs,
            costUsd,
        };
    }
    /**
     * Check every dial vs current observation. Returns the FIRST tripped dial
     * (deterministic order so behaviour is reproducible). Pure propositional
     * comparison — `dial !== undefined && observed > dial`. There are no
     * numerical literals in this function: every threshold comes from
     * `this.dials`.
     */
    checkExhausted() {
        const u = this.snapshot();
        const dials = this.dials;
        const check = (dialValue, observed, kind) => dialValue !== undefined && observed > dialValue
            ? { exhausted: true, kind, budget: dialValue, observed }
            : undefined;
        // Deterministic check order. Token totals (which combine multiple
        // counters) come AFTER the per-counter checks so a more specific dial
        // fires first.
        const totalTokens = u.inputTokens + u.outputTokens + u.reasoningTokens;
        return (check(dials.maxTurns, u.turns, "turn") ??
            check(dials.maxModelCalls, u.modelCalls, "model_call") ??
            check(dials.maxToolCalls, u.toolCalls, "tool_call") ??
            check(dials.maxShellCommands, u.shellCommands, "shell_command") ??
            check(dials.maxTestRuns, u.testRuns, "test_run") ??
            check(dials.maxInputTokens, u.inputTokens, "input_tokens") ??
            check(dials.maxOutputTokens, u.outputTokens, "output_tokens") ??
            check(dials.maxReasoningTokens, u.reasoningTokens, "reasoning_tokens") ??
            check(dials.maxTotalTokens, totalTokens, "total_tokens") ??
            check(dials.maxFilesChanged, u.filesChanged, "files_changed") ??
            check(dials.maxPatchBytes, u.patchBytes, "patch_bytes") ??
            check(dials.maxRetries, u.retries, "retry") ??
            check(dials.maxConsecutiveFailures, u.consecutiveFailures, "consecutive_failure") ??
            check(dials.maxWallClockMs, u.wallClockMs, "wall_clock_ms") ??
            check(dials.maxCostUsd, u.costUsd, "cost_usd") ?? { exhausted: false });
    }
}
