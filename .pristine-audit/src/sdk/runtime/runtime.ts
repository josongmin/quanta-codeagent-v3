import { assertCapabilityExpectation, createSessionPersistence } from "@/host/runtime"
import { isDurableSessionEventLog, systemClock } from "@/kernel/session"
import { createRuntimeSession } from "./session"
import { rehydrateResumeTranscript } from "./session/rehydrate"
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
        // W4-b: env-gated backend (`QUANTA_SESSION_EVENT_LOG_DIR`) — unset ⇒ the
        // historical in-memory log, byte-identical. Set ⇒ durable JSONL keyed by
        // this session id (seq issuance then resumes from its tip).
        const eventLog = createSessionPersistence({ sessionId: description.sessionId })
        // RFC01-4 A1 — cold-start rehydrate INJECTION. A durable log whose
        // `tip() > 0` means this session id is being RESUMED across a restart.
        // The confirmed-correction (README §"RFC-01 A1") DROPS event-fold: the
        // SOLE lossless transcript authority is the existing `SavedSession`
        // snapshot loaded by `loadSessionById` — an INDEPENDENT rail from this
        // seq/wire log. When such a snapshot EXISTS, inject its full transcript
        // so the resumed runtime restores the conversation instead of starting
        // empty; when it is IDENTITY-MISMATCHED or its transcript is TAMPERED,
        // `rehydrateResumeTranscript` THROWS here (before any RuntimeSession is
        // assembled) — the runtime REFUSES rather than partial-merging a corrupt
        // transcript. When NO snapshot exists (a pure wire/seq-only resume, or
        // an in-memory log with `tip === 0`), it returns `undefined` ⇒ the
        // empty-transcript cold start, byte-identical to the pre-feature runtime.
        const durableTip = isDurableSessionEventLog(eventLog) ? eventLog.tip() : 0
        const rehydratedMessages =
          durableTip > 0 ? await rehydrateResumeTranscript(description.sessionId) : undefined
        return createRuntimeSession({
          hostSession,
          kernel: { clock: systemClock, eventLog },
          ...(rehydratedMessages !== undefined ? { rehydratedMessages } : {}),
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
