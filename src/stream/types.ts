export type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "assistant_text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; preview: string }
  | { type: "error"; message: string }
  | { type: "done"; reason: string; turns: number }
