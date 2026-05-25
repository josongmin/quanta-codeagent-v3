import { assertCapabilityExpectation, createInMemorySessionPersistence } from "@/host/runtime"
import { systemClock } from "@/kernel/session"
import { createRuntimeSession } from "./session"
import type { CreateRuntimeOptions, RuntimeFacade } from "./types"

export const createRuntimeFacade = (options: CreateRuntimeOptions): RuntimeFacade => {
  let closed = false
  return {
    createSession: async (config) => {
      if (closed) throw new Error("runtime is closed")
      const hostSession = await options.host.createSessionHost(config)
      assertCapabilityExpectation(
        options.expectedCapabilities,
        hostSession.describe().capabilityManifest,
      )
      return createRuntimeSession({
        hostSession,
        kernel: {
          clock: systemClock,
          eventLog: createInMemorySessionPersistence(),
        },
      })
    },
    close: async () => {
      if (closed) return
      closed = true
      await options.host.close?.()
    },
  }
}
