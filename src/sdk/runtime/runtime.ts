import { assertCapabilityExpectation, createSessionPersistence } from "@/host/runtime"
import { systemClock } from "@/kernel/session"
import { createRuntimeSession } from "./session"
import type { CreateRuntimeOptions, RuntimeFacade } from "./types"

export const createRuntimeFacade = (options: CreateRuntimeOptions): RuntimeFacade => {
  let closed = false
  return {
    createSession: async (config) => {
      if (closed) throw new Error("runtime is closed")
      const hostSession = await options.host.createSessionHost(config)
      const description = hostSession.describe()
      assertCapabilityExpectation(options.expectedCapabilities, description.capabilityManifest)
      return createRuntimeSession({
        hostSession,
        kernel: {
          clock: systemClock,
          // W4-b: env-gated backend (`QUANTA_SESSION_EVENT_LOG_DIR`) — unset ⇒
          // the historical in-memory log, byte-identical. Set ⇒ durable JSONL
          // keyed by this session id (seq issuance then resumes from its tip).
          eventLog: createSessionPersistence({ sessionId: description.sessionId }),
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
