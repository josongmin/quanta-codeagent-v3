/**
 * Bench-instance retry policy — transient-only.
 *
 * Why a separate layer on top of Best-of-N:
 *   - Best-of-N (`--n`) samples K trajectories and picks the best by score
 *     — it treats EVERY failure mode the same (LLM fail, infra crash, real
 *     model loss). For measurement integrity we want to:
 *       1. NEVER retry a REAL model failure (`completed_unresolved` /
 *          `verify_loop_stuck` / `max_turns_exhausted`) — that is signal,
 *          not noise.
 *       2. RETRY a transient infra signal (`empty-patch`, harness crash)
 *          once or twice to avoid scoring "OAuth blip" as a model fail.
 *   - The retry layer is OUTSIDE Best-of-N: each `runInstance` call is a
 *     full Best-of-N round; if its outcome is transient, the next attempt
 *     runs another full Best-of-N. This is conservative on cost (max
 *     `n * retries` total LLM streams) but byte-identical when
 *     `maxAttempts === 1`.
 *
 * Closed port: `RetryPolicy.shouldRetry` returns `{ reason }` to retry or
 * `undefined` to stop. The caller (runInstance / app/bench) loops the
 * attempt; the policy itself is pure (no side effects, no I/O).
 *
 * Default policy:
 *   - empty-patch        ⇒ RETRY (LLM/API hiccup)
 *   - infra-fail         ⇒ RETRY (harness crash, mkdir EACCES)
 *   - timeout            ⇒ NO RETRY (ambiguous — caller may swap policy
 *                                    if it wants a longer-budget retry)
 *   - real-fail / pass   ⇒ NO RETRY (terminal: signal or success)
 *
 * Real-fail is FROZEN no-retry by contract — the constant `DEFAULT_POLICY`
 * is the only contract our bench exposes; alternative policies are an
 * *opt-in test seam*, never a production default.
 *
 * Error-pattern classification: see {@link classifyOutcome} for the
 * `InstanceResult` → `AttemptOutcome` mapping table. The bench reports
 * adopt the structured outcome shape; the classifier folds heterogeneous
 * `error` strings (from `runAgent` / `verify` / `withGitSnapshot`) into the
 * closed enum.
 */

import type { InstanceResult } from "../types"

/**
 * Closed enum of possible per-attempt outcomes, ranked by retry intent:
 *   - `pass`         — agent succeeded. Stop (success).
 *   - `generation-fail` — the agent loop itself stopped with a provider/model
 *                      error before producing a candidate patch. Stop by
 *                      default; quota/rate-limit errors are not improved by
 *                      immediate bench retries.
 *   - `empty-patch`  — agent never produced a diff. Almost always an LLM /
 *                      provider problem (rate limit, OAuth drop, stream
 *                      error caught by the LLM port). Retry is safe.
 *   - `timeout`      — wall-clock deadline hit. Ambiguous — could be
 *                      legitimate (huge repo, slow turn) or transient (slow
 *                      external API). Default policy: do NOT retry. A caller
 *                      that knows it raised the budget can swap to a policy
 *                      that retries here.
 *   - `real-fail`    — agent produced a patch but the official verifier
 *                      rejected it (`completed_unresolved`), or the loop
 *                      stalled (`verify_loop_stuck`), or turns exhausted.
 *                      This is the MODEL'S SIGNAL — never retried.
 *   - `infra-fail`   — anything else (harness crash, sandbox copy error,
 *                      python subprocess EACCES). Retry is safe.
 *
 * `subkind` on `real-fail` is a precision flag for the report — it lets the
 * caller distinguish "agent's answer was wrong" from "agent ran out of
 * budget" without changing retry intent. */
export type AttemptOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "empty-patch"; readonly reason?: string }
  | { readonly kind: "generation-fail"; readonly reason: string }
  | { readonly kind: "timeout" }
  | {
      readonly kind: "real-fail"
      readonly subkind: "completed_unresolved" | "verify_loop_stuck" | "max_turns_exhausted"
    }
  | { readonly kind: "infra-fail"; readonly reason: string }

/** Pure decision interface. Returns `{ reason }` to retry the next attempt,
 *  or `undefined` to stop. The caller increments `attempt` per loop. */
export interface RetryPolicy {
  shouldRetry(
    outcome: AttemptOutcome,
    attempt: number,
    maxAttempts: number,
  ): { reason: string } | undefined
}

/**
 * The bench's frozen default policy:
 *   - empty-patch  ⇒ retry (LLM/API transient)
 *   - generation-fail ⇒ DO NOT retry (provider quota/rate-limit waste guard)
 *   - infra-fail   ⇒ retry (harness transient)
 *   - timeout      ⇒ DO NOT retry (ambiguous; budget already exhausted)
 *   - real-fail    ⇒ DO NOT retry (model signal — measurement integrity)
 *   - pass         ⇒ DO NOT retry (success)
 *
 * `attempt >= maxAttempts` short-circuits to `undefined` regardless of kind
 * (budget exhausted).
 */
export const DEFAULT_POLICY: RetryPolicy = {
  shouldRetry(
    outcome: AttemptOutcome,
    attempt: number,
    maxAttempts: number,
  ): { reason: string } | undefined {
    if (attempt >= maxAttempts) return undefined
    if (outcome.kind === "empty-patch") {
      return { reason: "agent produced empty patch (likely LLM/API failure)" }
    }
    if (outcome.kind === "infra-fail") {
      return { reason: outcome.reason }
    }
    // generation-fail: usually quota/rate-limit or model refusal; immediate
    // retries waste budget. timeout: ambiguous — default is NO retry.
    // real-fail / pass: terminal.
    return undefined
  },
}

/**
 * Map an `InstanceResult` (the bench's heterogeneous outcome) into a
 * structured `AttemptOutcome` the policy can reason about.
 *
 * Classification table (in priority order):
 *   1. `result.passed === true`                        ⇒ pass
 *   2. `result.verdict === "env_prep_failed"`          ⇒ infra-fail (T4)
 *   3. `result.verdict === "degraded"`                 ⇒ infra-fail (recorder)
 *   4. `result.verdict === "grader_invalid"`           ⇒ infra-fail
 *   4. `error` matches provider/model generation failure ⇒ generation-fail
 *   5. `error` contains "empty prediction"             ⇒ empty-patch
 *   6. `error` contains "no patch produced"            ⇒ empty-patch
 *   7. `patch === ""`  AND  `error` non-empty          ⇒ empty-patch
 *   8. `error` matches /operation timed out|SIGTERM|aborted/i ⇒ timeout
 *   9. `error` matches /harness|spawn|EACCES|ENOENT/i  ⇒ infra-fail
 *  10. `error` matches /verify loop stuck|loop_stuck/i ⇒ real-fail / verify_loop_stuck
 *  11. `error` matches /max turns|turns exhausted/i    ⇒ real-fail / max_turns_exhausted
 *  12. otherwise (passed=false, has patch)             ⇒ real-fail / completed_unresolved
 *
 * The classifier is pure; the bench driver may call it AFTER `runInstance`
 * to decide whether to loop.
 */
/** Verdict-driven infra classification (harness-level signals). Returns
 *  `undefined` to fall through to string sniffing. Extracted from
 *  `classifyOutcome` to keep its cognitive complexity under the biome cap. */
const classifyByVerdict = (result: InstanceResult): AttemptOutcome | undefined => {
  if (result.verdict === "env_prep_failed") {
    return { kind: "infra-fail", reason: result.error ?? "env_prep_failed" }
  }
  if (result.verdict === "degraded") {
    return { kind: "infra-fail", reason: result.error ?? "observation degraded" }
  }
  if (result.verdict === "grader_invalid") {
    return { kind: "infra-fail", reason: result.error ?? "grader_invalid" }
  }
  return undefined
}

/** Error-string sniffer. Returns `undefined` when no string-pattern matches;
 *  the caller falls through to the patch-state heuristics. Extracted from
 *  `classifyOutcome` to keep complexity under the biome cap. */
const classifyByErrorString = (err: string): AttemptOutcome | undefined => {
  if (err === "") return undefined
  if (
    /agent stopped with (?:error|refusal)|LLM stream failed|usage_limit_reached|usage limit|rate[_ -]?limit|429 Too Many Requests/i.test(
      err,
    )
  ) {
    return { kind: "generation-fail", reason: err }
  }
  if (err.includes("empty prediction") || err.includes("no patch produced")) {
    return { kind: "empty-patch", reason: err }
  }
  if (/operation timed out|SIGTERM|aborted by signal|abortcontroller|abort signal/i.test(err)) {
    return { kind: "timeout" }
  }
  if (/\bharness\b|spawn\s+E|EACCES|ENOENT|EPERM|ECONNREFUSED|ENETUNREACH/i.test(err)) {
    return { kind: "infra-fail", reason: err }
  }
  if (/verify[\s_-]loop[\s_-]stuck|loop_stuck/i.test(err)) {
    return { kind: "real-fail", subkind: "verify_loop_stuck" }
  }
  if (/max[\s_-]turns|turns[\s_-]exhausted/i.test(err)) {
    return { kind: "real-fail", subkind: "max_turns_exhausted" }
  }
  return undefined
}

/** Patch-state fallback. Used when neither verdict nor error string offers
 *  a definitive classification. */
const classifyByPatchState = (patch: string, err: string): AttemptOutcome => {
  if (patch !== "" && err !== "") {
    return { kind: "real-fail", subkind: "completed_unresolved" }
  }
  if (patch === "") {
    return err !== "" ? { kind: "empty-patch", reason: err } : { kind: "empty-patch" }
  }
  return { kind: "real-fail", subkind: "completed_unresolved" }
}

export const classifyOutcome = (result: InstanceResult): AttemptOutcome => {
  if (result.passed === true) return { kind: "pass" }
  const byVerdict = classifyByVerdict(result)
  if (byVerdict !== undefined) return byVerdict
  const err = typeof result.error === "string" ? result.error : ""
  const patch = typeof result.patch === "string" ? result.patch : ""
  const byErr = classifyByErrorString(err)
  if (byErr !== undefined) return byErr
  return classifyByPatchState(patch, err)
}

/**
 * Parse `QUANTA_BENCH_RETRY_TRANSIENT` to a positive integer N in [1, 5].
 * Returns `undefined` for every other shape (absent / empty / negative /
 * NaN / non-integer / garbage / N>5). The caller treats `undefined` as
 * "use the default (1 = no retry, byte-identical)".
 *
 *   - N=1 ⇒ no retry (single attempt). Byte-identical fence.
 *   - N=2 ⇒ up to one retry.
 *   - N=5 ⇒ hard cap (5 full Best-of-N rounds per instance is already
 *           5n LLM streams; allowing more would defeat the cost discipline).
 */
export const parseRetryTransientEnv = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < 1 || n > 5) return undefined
  return n
}

/** Result of one retry-loop iteration: the final outcome + the per-attempt
 *  history (last entry is the final outcome). Caller plumbs this into the
 *  `budget` field on `InstanceResult`. */
export interface RetryLoopResult {
  readonly outcomes: readonly AttemptOutcome[]
  readonly attempts: number
}

/**
 * Drive the retry loop. Calls `runOne` up to `maxAttempts` times, classifying
 * each result via `classifyOutcome`, and short-circuiting on the first
 * non-transient outcome (real-fail / pass / policy.shouldRetry === undefined).
 *
 * The function is shape-agnostic: it returns the per-attempt outcome list and
 * the LAST `InstanceResult` (the one that broke the loop). Callers stamp the
 * budget metadata onto the returned result.
 *
 * Closed-port: `policy` defaults to `DEFAULT_POLICY` (the only production
 * shape); test seams may inject a permissive policy that retries on timeout.
 */
export const runRetryLoop = async (
  runOne: (attempt: number) => Promise<InstanceResult>,
  maxAttempts: number,
  policy: RetryPolicy = DEFAULT_POLICY,
): Promise<{ result: InstanceResult; loop: RetryLoopResult }> => {
  const outcomes: AttemptOutcome[] = []
  // Defensive: maxAttempts < 1 ⇒ pin to 1. Caller is responsible for
  // passing a parsed value; this is belt-and-braces.
  const cap = Math.max(1, Math.floor(maxAttempts))
  let last: InstanceResult | undefined
  for (let attempt = 1; attempt <= cap; attempt++) {
    last = await runOne(attempt)
    const outcome = classifyOutcome(last)
    outcomes.push(outcome)
    const decision = policy.shouldRetry(outcome, attempt, cap)
    if (decision === undefined) break
  }
  // last is guaranteed defined: cap >= 1 ⇒ runOne is called at least once.
  if (last === undefined) {
    throw new Error("runRetryLoop invariant: runOne was never called (cap < 1)")
  }
  return {
    result: last,
    loop: { outcomes, attempts: outcomes.length },
  }
}
