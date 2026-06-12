import { AGENT_STATE_PROTOCOL_VERSION } from "@/protocol/agent-state"
import { CANVAS_PROTOCOL_VERSION } from "@/protocol/canvas"
import { OBSERVABILITY_PROTOCOL_VERSION } from "@/protocol/observability"
import { SESSION_PROTOCOL_VERSION, type SessionProtocolVersion } from "./version"

export const SURFACE_READ_MODEL_IDS = [
  "session",
  "agentState",
  "canvas",
  "observability",
] as const

export type SurfaceReadModelId = (typeof SURFACE_READ_MODEL_IDS)[number]

export const SURFACE_READ_MODEL_STATUSES = [
  "subscribed",
  "supported",
  "unsupported",
] as const

export type SurfaceReadModelStatus = (typeof SURFACE_READ_MODEL_STATUSES)[number]

export type ResolvedReadModelSupport<TProtocol extends string> =
  | {
      readonly status: "subscribed" | "supported"
      readonly protocol: TProtocol
    }
  | {
      readonly status: "unsupported"
    }

export type SurfaceSubscriptionSupport<TProtocol extends string> =
  | {
      readonly status: "subscribed"
      readonly protocol: TProtocol
    }
  | {
      readonly status: "unsupported"
    }

export type SupportedReadModelSupport<TProtocol extends string> =
  | {
      readonly status: "supported"
      readonly protocol: TProtocol
    }
  | {
      readonly status: "unsupported"
    }

export interface SupportedReadModels {
  readonly session: SupportedReadModelSupport<SessionProtocolVersion>
  readonly agentState: SupportedReadModelSupport<typeof AGENT_STATE_PROTOCOL_VERSION>
  readonly canvas: SupportedReadModelSupport<typeof CANVAS_PROTOCOL_VERSION>
  readonly observability: SupportedReadModelSupport<typeof OBSERVABILITY_PROTOCOL_VERSION>
}

export interface SurfaceSubscription {
  readonly session: SurfaceSubscriptionSupport<SessionProtocolVersion>
  readonly agentState: SurfaceSubscriptionSupport<typeof AGENT_STATE_PROTOCOL_VERSION>
  readonly canvas: SurfaceSubscriptionSupport<typeof CANVAS_PROTOCOL_VERSION>
  readonly observability: SurfaceSubscriptionSupport<typeof OBSERVABILITY_PROTOCOL_VERSION>
}

export interface ResolvedReadModels {
  readonly session: ResolvedReadModelSupport<SessionProtocolVersion>
  readonly agentState: ResolvedReadModelSupport<typeof AGENT_STATE_PROTOCOL_VERSION>
  readonly canvas: ResolvedReadModelSupport<typeof CANVAS_PROTOCOL_VERSION>
  readonly observability: ResolvedReadModelSupport<typeof OBSERVABILITY_PROTOCOL_VERSION>
}

const subscribed = <TProtocol extends string>(
  protocol: TProtocol,
): SurfaceSubscriptionSupport<TProtocol> => ({
  status: "subscribed",
  protocol,
})

export const supported = <TProtocol extends string>(
  protocol: TProtocol,
): SupportedReadModelSupport<TProtocol> => ({
  status: "supported",
  protocol,
})

const unsupported = (): { readonly status: "unsupported" } => ({
  status: "unsupported",
})

export const LEGACY_DEFAULT_SURFACE_SUBSCRIPTION: SurfaceSubscription = {
  session: subscribed(SESSION_PROTOCOL_VERSION),
  agentState: subscribed(AGENT_STATE_PROTOCOL_VERSION),
  canvas: subscribed(CANVAS_PROTOCOL_VERSION),
  observability: subscribed(OBSERVABILITY_PROTOCOL_VERSION),
}

export const isSurfaceReadModelStatus = (value: unknown): value is SurfaceReadModelStatus =>
  typeof value === "string" &&
  (SURFACE_READ_MODEL_STATUSES as readonly string[]).includes(value)

export const isSurfaceReadModelId = (value: unknown): value is SurfaceReadModelId =>
  typeof value === "string" && (SURFACE_READ_MODEL_IDS as readonly string[]).includes(value)

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const matchesProtocol = (
  id: SurfaceReadModelId,
  protocol: unknown,
): boolean =>
  (id === "session" && protocol === SESSION_PROTOCOL_VERSION) ||
  (id === "agentState" && protocol === AGENT_STATE_PROTOCOL_VERSION) ||
  (id === "canvas" && protocol === CANVAS_PROTOCOL_VERSION) ||
  (id === "observability" && protocol === OBSERVABILITY_PROTOCOL_VERSION)

const isSurfaceReadModelSupport = (
  id: SurfaceReadModelId,
  value: unknown,
): value is ResolvedReadModelSupport<string> => {
  if (!isPlainObject(value) || !isSurfaceReadModelStatus(value.status)) return false
  if (value.status === "unsupported") {
    return value.protocol === undefined
  }
  return matchesProtocol(id, value.protocol)
}

export const isSurfaceSubscription = (value: unknown): value is SurfaceSubscription => {
  if (!isPlainObject(value)) return false
  for (const id of SURFACE_READ_MODEL_IDS) {
    if (!isSurfaceReadModelSupport(id, value[id])) return false
  }
  return true
}

export const normalizeSurfaceSubscription = (
  subscription: SurfaceSubscription | undefined,
): SurfaceSubscription => subscription ?? LEGACY_DEFAULT_SURFACE_SUBSCRIPTION

export const isSupportedReadModels = (value: unknown): value is SupportedReadModels => {
  if (!isPlainObject(value)) return false
  for (const id of SURFACE_READ_MODEL_IDS) {
    const candidate = value[id]
    if (!isPlainObject(candidate)) return false
    if (candidate.status !== "supported" && candidate.status !== "unsupported") return false
    if (candidate.status === "unsupported") {
      if (candidate.protocol !== undefined) return false
      continue
    }
    if (!matchesProtocol(id, candidate.protocol)) return false
  }
  return true
}

export const isReadModelSubscribed = (
  subscription: SurfaceSubscription,
  id: SurfaceReadModelId,
): boolean => subscription[id].status === "subscribed"

export const resolveReadModels = (
  supportedReadModels: SupportedReadModels,
  subscription: SurfaceSubscription | undefined,
): ResolvedReadModels => {
  const normalized = normalizeSurfaceSubscription(subscription)
  return {
    session:
      supportedReadModels.session.status === "supported" &&
      normalized.session.status === "subscribed"
        ? subscribed(SESSION_PROTOCOL_VERSION)
        : supportedReadModels.session.status === "supported"
          ? supported(SESSION_PROTOCOL_VERSION)
          : unsupported(),
    agentState:
      supportedReadModels.agentState.status === "supported" &&
      normalized.agentState.status === "subscribed"
        ? subscribed(AGENT_STATE_PROTOCOL_VERSION)
        : supportedReadModels.agentState.status === "supported"
          ? supported(AGENT_STATE_PROTOCOL_VERSION)
          : unsupported(),
    canvas:
      supportedReadModels.canvas.status === "supported" &&
      normalized.canvas.status === "subscribed"
        ? subscribed(CANVAS_PROTOCOL_VERSION)
        : supportedReadModels.canvas.status === "supported"
          ? supported(CANVAS_PROTOCOL_VERSION)
          : unsupported(),
    observability:
      supportedReadModels.observability.status === "supported" &&
      normalized.observability.status === "subscribed"
        ? subscribed(OBSERVABILITY_PROTOCOL_VERSION)
        : supportedReadModels.observability.status === "supported"
          ? supported(OBSERVABILITY_PROTOCOL_VERSION)
          : unsupported(),
  }
}
