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
