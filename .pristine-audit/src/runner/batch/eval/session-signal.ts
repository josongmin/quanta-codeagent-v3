import type { AgentConfig } from "@/agent"

export interface SessionScopedSignal {
  readonly signal: AbortSignal
  abort(reason?: unknown): void
}

const abortController = (controller: AbortController, reason?: unknown): void => {
  if (controller.signal.aborted) return
  if (reason === undefined) {
    controller.abort()
    return
  }
  controller.abort(reason)
}

export const createSessionScopedSignal = (outer: AbortSignal): SessionScopedSignal => {
  const controller = new AbortController()
  const abortFromOuter = (): void => abortController(controller, outer.reason)
  if (outer.aborted) abortFromOuter()
  else outer.addEventListener("abort", abortFromOuter, { once: true })
  return {
    signal: controller.signal,
    abort: (reason?: unknown) => {
      outer.removeEventListener("abort", abortFromOuter)
      abortController(controller, reason)
    },
  }
}

export const withSessionScopedSignal = (config: AgentConfig, signal: AbortSignal): AgentConfig => ({
  ...config,
  signal,
  ...(config.prewarm !== undefined ? { prewarm: { ...config.prewarm, warmSignal: signal } } : {}),
  ...(config.lspPrewarm !== undefined
    ? { lspPrewarm: { ...config.lspPrewarm, warmSignal: signal } }
    : {}),
})
