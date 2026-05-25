import type { SessionHost } from "@/kernel/session"
import {
  createLegacySessionHost,
  type LegacySessionHost,
  type LegacySessionHostOptions,
} from "./session-host"
import type { RuntimeHost, RuntimeSessionConfig } from "./types"

export const createSingleSessionRuntimeHost = (
  factory: (config: RuntimeSessionConfig) => Promise<SessionHost> | SessionHost,
): RuntimeHost => ({
  createSessionHost: async (config) => await factory(config),
})

export const createLegacySingleSessionRuntimeHost = (
  options: LegacySessionHostOptions,
): { readonly runtimeHost: RuntimeHost; readonly sessionHost: LegacySessionHost } => {
  const sessionHost = createLegacySessionHost(options)
  return {
    sessionHost,
    runtimeHost: createSingleSessionRuntimeHost(() => sessionHost),
  }
}
