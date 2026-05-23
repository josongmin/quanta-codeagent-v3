import { isMutatingToolBlockedInMode } from "./mode";
/**
 * Plan mode gate — DEPRECATED alias.
 *
 * Original RFC §13 Q3 design: a single boolean restriction (read-only tools
 * only) + a per-turn prompt notice, NO new tool. That remains correct, but
 * Phase 3 (Codex `mode-and-plan-process-audit.md` absorption) generalizes the
 * gate into a typed enum that ALSO covers `review` / `audit` read-only
 * postures. New code should call {@link isMutatingToolBlockedInMode} with the
 * resolved {@link AgentMode}; this thin wrapper is preserved so unmigrated
 * callers compile and behave unchanged.
 */
export const isMutatingToolBlockedInPlan = (action) => isMutatingToolBlockedInMode("plan", action);
