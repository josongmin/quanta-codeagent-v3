export type PermissionDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason: string }

export interface ToolAction {
  tool: string
  input: unknown
  isReadOnly: boolean
}

export type PermissionMode = "default" | "acceptEdits" | "bypass"

export interface PermissionContext {
  mode: PermissionMode
}
