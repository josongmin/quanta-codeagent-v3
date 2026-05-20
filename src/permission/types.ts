import type { ClassifierPort } from "./classifier"

export type PermissionDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason: string }

export interface ToolAction {
  tool: string
  input: unknown
  isReadOnly: boolean
}

/**
 * Codex HITL 4-tier taxonomy (hitl-audit.md). Each tool action — and within
 * `bash`, each command — maps to exactly one tier. The dispatch gate routes
 * tier-specific behaviour (handoff terminates; always-confirm bypasses mode;
 * pre-approval-ok defers to the existing mode policy; none allows).
 *
 *  - "hand-off-required": agent must terminate; only a human can proceed
 *    (matches HARD_DENY patterns and password/safety-bypass scenarios).
 *  - "always-confirm": explicit confirm EVERY time, even under
 *    `acceptEdits`/`bypass` (deletion, permissions change, financial txn,
 *    sending DMs, mutating network egress like `git push`).
 *  - "pre-approval-ok": existing mode policy applies; can be batch-approved.
 *  - "none": read-only / reversible / harmless.
 *
 * Canonical home is `@/permission`. `@/tool` keeps its own structurally-
 * identical literal union to preserve slice isolation (biome forbids
 * `@/tool` from importing `@/permission`).
 */
export type HITLTier = "hand-off-required" | "always-confirm" | "pre-approval-ok" | "none"

/** `auto` = use an injected model classifier (AutoModeClassifier) to decide
 *  allow/deny in place of an interactive prompt (AFK / long-running tasks).
 *  Absent `classify` port ⇒ "auto" degrades safely to "ask". */
export type PermissionMode = "default" | "acceptEdits" | "bypass" | "auto"

export interface PermissionContext {
  mode: PermissionMode
  /** Optional injected intelligence port for "auto" mode. The permission
   *  slice never imports @/llm or @/agent — the real impl is wired by the
   *  main thread. When absent, "auto" mode degrades to "ask". */
  classify?: ClassifierPort
}
