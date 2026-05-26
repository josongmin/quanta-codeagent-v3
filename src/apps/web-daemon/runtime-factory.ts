/**
 * `@/apps/web-daemon/runtime-factory` — production composition root.
 *
 * The daemon entry (`./index.ts`) injects this factory ONLY when invoked as
 * a script (`import.meta.main`). Tests still inject their own factory.
 *
 * Mirrors `src/apps/agent/mode-presets/interactive.ts` — same
 * `assembleAgentConfig({ mode:"interactive", ... })` pipeline, just exposed
 * as a long-running session over the WS transport instead of stdin.
 */

import type { AgentConfig } from "@/agent"
import { buildSystemPrompt } from "@/agent"
import { pickProvider, tryCreateLLM } from "@/llm"
import type { PermissionContext } from "@/permission"
import {
  createRuntimeFromAgentConfigBase,
  type RuntimeAgentConfigBase,
  type RuntimeAgentTurnAssembler,
  type RuntimeFacade,
} from "@/sdk/runtime"
import { StdoutStream } from "@/stream"
import { buildDefaultTools, ToolRegistry } from "@/tool"
import { assembleAgentConfig } from "@/apps/agent/assemble"

type InteractiveTurnDeps = Pick<
  RuntimeAgentConfigBase,
  "cwd" | "llm" | "maxTurns" | "permission" | "registry" | "signal" | "stream" | "system"
>

export const buildInteractiveTurnAssembler = (
  base: Omit<AgentConfig, "modePolicy" | "budgetMeter">,
): RuntimeAgentTurnAssembler => (messages, turnDeps) => {
  const deps = turnDeps as InteractiveTurnDeps
  return assembleAgentConfig({
    mode: "interactive",
    base: {
      ...base,
      llm: deps.llm,
      registry: deps.registry,
      stream: deps.stream,
      permission: deps.permission,
      messages,
      system: deps.system,
      cwd: deps.cwd,
      maxTurns: deps.maxTurns,
      signal: deps.signal,
    },
  })
}

/**
 * Build a `runtimeFactory` suitable for `WebDaemonConfig`. The LLM port is
 * resolved ONCE at boot (env-driven provider pick); each invocation of the
 * returned factory mints a fresh `RuntimeFacade` (= fresh session host).
 */
export const buildProductionRuntimeFactory = (): (() => Promise<RuntimeFacade>) => {
  const env = process.env as Record<string, string | undefined>
  const provider = pickProvider(env)
  const llm = tryCreateLLM(provider, {}, env)
  if (llm === null) {
    throw new Error(
      `web-daemon: LLM provider "${provider}" not configured ` +
        `(set ANTHROPIC_API_KEY / OPENAI_API_KEY, or run /login for chatgpt-oauth)`,
    )
  }

  return async (): Promise<RuntimeFacade> => {
    const cwd = process.cwd()
    const abort = new AbortController()
    const permission: PermissionContext = { mode: "default" }
    const base: Omit<AgentConfig, "modePolicy" | "budgetMeter"> = {
      llm,
      registry: new ToolRegistry(buildDefaultTools()),
      stream: new StdoutStream(),
      permission,
      messages: [],
      system: buildSystemPrompt(cwd),
      cwd,
      maxTurns: 200,
      signal: abort.signal,
    }
    const turnAssembler = buildInteractiveTurnAssembler(base)
    const { runtime } = await createRuntimeFromAgentConfigBase({
      base,
      turnAssembler,
      history: [...base.messages],
      state: undefined,
      idMeta: undefined,
      shutdown: async () => undefined,
    })
    return runtime
  }
}
