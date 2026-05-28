/**
 * ADR-0397 — Run Ledger attribution slice barrel.
 *
 * The ONLY allowed import path from `@/agent/run-ledger-attribution`.
 * Re-exports the matcher contract, the default matcher factory, and the
 * hook-bus subscriber factory.
 *
 * Slice fence: the slice imports ONLY `@/agent/run-ledger` (for the
 * `RunLedgerPort` type) and `@/shared` (utilities). It NEVER imports
 * `@/tool/bash`, `@/subagent`, `@/mcp`, or any other peer slice. The
 * subscriber wired here is itself default-OFF: nothing constructs it until
 * a composition root opts in (a follow-up slice).
 */

export { createDefaultLedgerMatcher } from "./matchers"
export { createRunLedgerHookSubscriber } from "./subscriber"
export type {
  DefaultLedgerMatcherOptions,
  LedgerAction,
  LedgerMatcher,
  ObservedToolEvent,
  RunLedgerHookHandler,
  RunLedgerHookSubscriberDeps,
} from "./types"
