import type { SessionHost } from "@/kernel/session"
import type { RuntimeHost, RuntimeSessionConfig } from "./types"

export const createSingleSessionRuntimeHost = (
  factory: (config: RuntimeSessionConfig) => Promise<SessionHost> | SessionHost,
): RuntimeHost => ({
  createSessionHost: async (config) => await factory(config),
})
