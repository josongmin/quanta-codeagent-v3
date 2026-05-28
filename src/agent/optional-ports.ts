import { createEffortClassifier } from "@/agent/effort-classifier"
import { createFastApplyFallback } from "@/agent/fast-apply-fallback"
import { dispatchSideConversation } from "@/agent/side-conversation"
import type { LLMPort } from "@/llm"
import { defaultRoleModelResolver, type RoleModelResolver } from "@/llm/role-model-override"
import type { AgentConfig } from "./types"

const QUANTA_FAST_APPLY_ENV = "QUANTA_FAST_APPLY"
const QUANTA_EFFORT_AUTO_ENV = "QUANTA_EFFORT_AUTO"

type OptionalPortEnv = Readonly<Record<string, string | undefined>>

type OptionalPortBase = Pick<
  AgentConfig,
  | "llm"
  | "signal"
  | "modelCandidates"
  | "fastApplyFallback"
  | "effortClassifier"
  | "roleModelResolver"
  | "sessionId"
> &
  Partial<AgentConfig>

const envGateOn = (env: OptionalPortEnv, key: string): boolean => env[key] === "on"

const resolveModelPort = (base: OptionalPortBase, modelId: string): LLMPort | null => {
  if (base.llm.model === modelId) return base.llm
  return base.modelCandidates?.find((candidate) => candidate.id === modelId)?.port ?? null
}

const resolveSessionId = (base: OptionalPortBase): string => base.sessionId ?? crypto.randomUUID()

const roleModelResolverOf = (base: OptionalPortBase): RoleModelResolver | undefined => {
  return base.roleModelResolver
}

export const wireOptionalAgentPorts = <T extends OptionalPortBase>(
  base: T,
  env: OptionalPortEnv = process.env,
): T => {
  let next = base

  if (envGateOn(env, QUANTA_FAST_APPLY_ENV)) {
    const roleModelResolver = roleModelResolverOf(next) ?? defaultRoleModelResolver()
    if (next.roleModelResolver === undefined) {
      next = { ...next, roleModelResolver } as T
    }
    if (next.fastApplyFallback === undefined) {
      const defaultModel = next.llm.model
      if (defaultModel !== undefined && defaultModel.length > 0) {
        const parentSessionId = resolveSessionId(next)
        next = {
          ...next,
          fastApplyFallback: createFastApplyFallback({
            roleResolver: roleModelResolver,
            defaultModel,
            sideConversation: {
              dispatch: async (req) => {
                const llm = resolveModelPort(next, req.model)
                if (llm === null) return { ok: false, text: "" }
                const result = await dispatchSideConversation(
                  {
                    parentSessionId,
                    question: req.prompt,
                    model: req.model,
                  },
                  {
                    resolveLlm: () => llm,
                    resolveTools: () => [],
                    signal: next.signal,
                  },
                )
                return { ok: true, text: result.answer }
              },
            },
          }),
        } as T
      }
    }
  }

  if (next.effortClassifier === undefined && envGateOn(env, QUANTA_EFFORT_AUTO_ENV)) {
    next = {
      ...next,
      effortClassifier: createEffortClassifier(),
    } as T
  }

  return next
}
