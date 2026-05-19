/**
 * Shared integration-test harness for the e2e gap-closing suites.
 *
 * Same fake-LLM / RecordingStream / cfg() style as
 * `agent-recovery-e2e.test.ts` and `agent-features.test.ts` — extracted here so
 * the six new gap-closing suites reuse ONE harness instead of redefining it.
 * No production code is touched; this lives only under tests/integration/.
 */

import type { AgentConfig } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { LLMError } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

/** One scripted stream step: replay `events`, or `throw` before yielding. */
export type Step = { kind: "throw"; error: unknown } | { kind: "events"; events: StreamEvent[] }

export const ev = (events: StreamEvent[]): Step => ({ kind: "events", events })
export const thr = (error: unknown): Step => ({ kind: "throw", error })

/**
 * Replays a script step-per-`stream()` call. `throw` steps reject before
 * yielding (exercising the loop's same-turn retry / PTL path). The last step
 * repeats if the loop calls more often than scripted (defensive, like the
 * existing `ScriptedLLM`). Records every `StreamInput`.
 */
export class ScriptedLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0
  readonly model = "scripted-test-model"
  private readonly steps: Step[]
  constructor(steps: Step[]) {
    this.steps = steps
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    const step = this.steps.shift() ?? this.steps[this.steps.length - 1]
    if (!step) throw new LLMError("script exhausted")
    if (step.kind === "throw") throw step.error
    for (const e of step.events) yield e
  }
}

/** StreamPort double recording every emitted AgentEvent. */
export class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

export const text = (t: string, stop = "end_turn"): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: stop },
]

export const toolUse = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

export const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 5,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

/** Hard guard: a hang here is a real loop bug, not a slow test. */
export const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HANG: ${label} did not terminate in ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
