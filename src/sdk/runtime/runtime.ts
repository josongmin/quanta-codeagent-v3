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
      // AUDIT-γ H3 — the hostSession owns a PTY / subprocess / fds. Everything
      // between here and a fully-assembled RuntimeSession can throw (capability
      // mismatch; durable persistence hitting an unwritable log dir or a
      // live-pid single-writer lock), so any failure past this point must close
      // the hostSession before rethrowing — otherwise a long-lived daemon leaks
      // one host session per createSession under a misconfigured log dir.
      try {
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
      } catch (error) {
        await hostSession.close()
        throw error
      }
    },
    close: async () => {
      if (closed) return
      closed = true
      await options.host.close?.()
    },
  }
}
