/**
 * Test fixture — minimal `RuntimeFacade` that returns a stub `RuntimeSession`.
 *
 * Goals:
 *   - Boot fast (no agent loop, no LLM, no filesystem).
 *   - Round-trip a `SessionTransportMessage` through the daemon: a `connect`
 *     command should trigger a snapshot frame back to the client.
 *   - Track close to assert teardown drives runtime.close().
 */

import type { SessionEvent, SessionSnapshotLite } from "@/protocol/session"
import type { RuntimeFacade, RuntimeSession } from "@/sdk/runtime"

const STUB_CAPS = {
  approvals: "none" as const,
  tools: false,
  memory: false,
  artifacts: false,
  subagents: false,
  automation: false,
  shellSnapshot: false,
  transport: "websocket" as const,
}

interface StubBag {
  sessionsCreated: number
  sessionsClosed: number
  runtimeClosed: boolean
  lastSession: RuntimeSession | undefined
}

export const createStubRuntimeFactory = (): {
  factory: () => Promise<RuntimeFacade>
  bag: StubBag
  emit: (event: SessionEvent) => void
} => {
  const bag: StubBag = {
    sessionsCreated: 0,
    sessionsClosed: 0,
    runtimeClosed: false,
    lastSession: undefined,
  }
  const listeners = new Set<(event: SessionEvent) => void>()
  const factory = async (): Promise<RuntimeFacade> => ({
    createSession: async (): Promise<RuntimeSession> => {
      bag.sessionsCreated += 1
      const sessionId = `stub-session-${bag.sessionsCreated}`
      const snapshot: SessionSnapshotLite = {
        sessionId,
        revision: 1,
        seq: 0,
        state: {
          status: "idle",
          draftInput: "",
          permissionMode: "default",
          messageCount: 0,
        },
        capabilities: STUB_CAPS,
        pendingApproval: null,
        openArtifacts: [],
      }
      const session: RuntimeSession = {
        sessionId,
        dispatch: async () => ({ revision: 1, seq: 0, events: [] }),
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        snapshot: async () => snapshot,
        close: async () => {
          bag.sessionsClosed += 1
          listeners.clear()
        },
        input: { append: async () => ({ revision: 1, seq: 0, events: [] }) },
        turn: { run: async () => ({ revision: 1, seq: 0, events: [] }) },
        identity: { set: async () => ({ revision: 1, seq: 0, events: [] }) },
        toolProfile: { set: async () => ({ revision: 1, seq: 0, events: [] }) },
        approval: { respond: async () => ({ revision: 1, seq: 0, events: [] }) },
        transcript: { replace: async () => ({ revision: 1, seq: 0, events: [] }) },
        side: {
          start: async () => ({
            outcome: {
              messages: [],
              reason: "stop",
              turns: 0,
              tokens: { input: 0, output: 0 },
            } as unknown as Awaited<ReturnType<RuntimeSession["side"]["start"]>>["outcome"],
            answerText: "",
            inputTokens: 0,
            outputTokens: 0,
            toolsAvailable: 0,
          }),
        },
      }
      bag.lastSession = session
      return session
    },
    close: async () => {
      bag.runtimeClosed = true
    },
  })
  const emit = (event: SessionEvent): void => {
    for (const listener of [...listeners]) listener(event)
  }
  return { factory, bag, emit }
}
