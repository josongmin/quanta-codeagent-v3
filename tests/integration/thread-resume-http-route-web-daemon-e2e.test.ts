/**
 * B2 SOTA++ hellgate e2e — web-daemon cross-surface thread RESUME HTTP route.
 *
 * The web `SessionClient` session id is SERVER-MINTED and the daemon runs ONE
 * shared live session (every WS client joins the SAME transcript — see
 * `@/apps/web-daemon/session-registry`). So a `?thread=<id>` deeplink RESUME of
 * an externally-addressed thread cannot re-attach the LIVE session; the honest
 * seam is the thread-ADDRESSED persisted-events route `GET /threads/:id/events`,
 * which serves ANY thread's persisted transcript READ-ONLY. This file seals that
 * route as the resume boundary end-to-end over a real ephemeral Bun.serve.
 *
 * Teeth (red-on-injection):
 *   TR-01  bearer auth ENFORCED on `/threads/:id/events` (no/bad token ⇒ 401;
 *          header AND ?token ⇒ 200). (drop requireAuth ⇒ 401 cases go 200 ⇒ RED.)
 *   TR-02  a DIFFERENT thread id (not the live server-minted session) returns
 *          THAT thread's persisted events + boundary:"read-only-history". (drive
 *          against only the live id ⇒ foreign events never surface ⇒ RED.)
 *   TR-03  the LIVE session id returns boundary:"live-attach". (misreport the
 *          boundary ⇒ RED.)
 *   TR-04  UNKNOWN / malformed id ⇒ 200 + {events:[]} clean empty (no crash, no
 *          auth bypass, no 5xx). (throw on unknown id ⇒ RED.)
 *   TR-05  `?since=N` filters to seq > N (resume cursor honored). (ignore since
 *          ⇒ RED.)
 *   TR-06  persistence OFF (`QUANTA_WEB_DB=off`) ⇒ 404 persistence_disabled
 *          (honest boundary, not a fake empty resume). (serve 200 empty ⇒ RED.)
 *
 * Hermetic + offline: a stub RuntimeFacade (no LLM), real sockets, `port:0`, a
 * PRIVATE temp `QUANTA_WEB_DB_DIR` seeded with a FOREIGN thread before boot.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openThreadStore } from "@/apps/web-daemon/persistence-sqlite"
import type { WebDaemonServerConfig } from "@/apps/web-daemon/server"
import { startWebDaemon } from "@/apps/web-daemon/server"
import type { WebDaemonHandle } from "@/apps/web-daemon/types"
import type { ConnectedSessionTransport, SessionTransport } from "@/ipc/session"
import type { SessionEvent, SessionSnapshotLite } from "@/protocol/session"
import { supported } from "@/protocol/session"
import type { RuntimeFacade, RuntimeSession, SessionDispatchResult } from "@/sdk/runtime"
import { __resetRuntimeConfig } from "@/shared"
import { capabilitiesFor, makeSnapshotLite } from "../support/session-fixtures"

const handles: WebDaemonHandle[] = []

// A private temp DB dir so we never touch the user's real threads.db, and can
// SEED a foreign thread's history before the daemon boots.
let dbDir: string
const prevDbDir = process.env.QUANTA_WEB_DB_DIR
const prevDbGate = process.env.QUANTA_WEB_DB

const LIVE_SESSION_ID = "live-shared-session-1"
const FOREIGN_THREAD_ID = "handoff-thread-42"

const makeEvent = (eventId: string, seq: number): SessionEvent =>
  ({
    eventId,
    seq,
    type: "turn.output.delta",
    emittedAt: new Date(seq * 1000).toISOString(),
    delta: `foreign-chunk-${eventId}`,
  }) as unknown as SessionEvent

beforeAll(() => {
  dbDir = mkdtempSync(join(tmpdir(), "quanta-resume-e2e-"))
  process.env.QUANTA_WEB_DB_DIR = dbDir
  delete process.env.QUANTA_WEB_DB // ensure persistence ON for the main suite
  // ADR-0503 P4 — `openThreadStore()` now reads the DB dir from the CACHED
  // `runtimeConfig().webDbDir`, not `process.env` directly. Without dropping the
  // cache the seed store + the daemon both fall back to the DEFAULT dir and the
  // seeded foreign thread never surfaces (TR-02/TR-05 read `[]`). Re-materialize
  // the frozen config now that the temp override is in `process.env`.
  __resetRuntimeConfig()
  // Seed the FOREIGN thread's persisted transcript BEFORE the daemon opens the
  // same DB file. The daemon's own live session (LIVE_SESSION_ID) is upserted at
  // boot; this foreign thread stands in for a conversation started on ANOTHER
  // surface (CLI / a prior web session) that the deeplink now resumes.
  const seed = openThreadStore()
  seed.upsertThread({ id: FOREIGN_THREAD_ID })
  seed.appendEvent(FOREIGN_THREAD_ID, makeEvent("f1", 1))
  seed.appendEvent(FOREIGN_THREAD_ID, makeEvent("f2", 2))
  seed.appendEvent(FOREIGN_THREAD_ID, makeEvent("f3", 3))
  seed.close()
})

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop()
    if (h !== undefined) await h.stop().catch(() => undefined)
  }
})

afterAll(() => {
  if (prevDbDir === undefined) delete process.env.QUANTA_WEB_DB_DIR
  else process.env.QUANTA_WEB_DB_DIR = prevDbDir
  if (prevDbGate === undefined) delete process.env.QUANTA_WEB_DB
  else process.env.QUANTA_WEB_DB = prevDbGate
  // Drop the temp-dir override from the frozen config so a later test file that
  // opens the store does not inherit this run's private dir.
  __resetRuntimeConfig()
  try {
    rmSync(dbDir, { recursive: true, force: true })
  } catch {
    // best-effort temp cleanup
  }
})

const CAPS = capabilitiesFor({
  approvals: "operator",
  tools: true,
  artifacts: true,
  subagents: true,
  shellSnapshot: true,
  transport: "websocket",
})

const okResult = (snap: SessionSnapshotLite): SessionDispatchResult => ({
  revision: snap.revision,
  seq: snap.seq,
  events: [],
})

/** A minimal stub facade whose session id is a KNOWN constant so the test can
 *  distinguish the live session from the seeded foreign thread. */
const stubFactory = (): (() => Promise<RuntimeFacade>) => {
  return async (): Promise<RuntimeFacade> => {
    let session: RuntimeSession | undefined
    return {
      createSession: async (): Promise<RuntimeSession> => {
        const snapshot: SessionSnapshotLite = makeSnapshotLite({
          sessionId: LIVE_SESSION_ID,
          revision: 1,
          seq: 0,
          state: {
            status: "idle",
            draftInput: "",
            permissionMode: "default",
            identityMode: "build",
            toolProfile: "full",
            modelSlug: "gpt-5",
            messageCount: 0,
          },
          capabilities: CAPS,
        })
        session = {
          sessionId: LIVE_SESSION_ID,
          snapshot: async () => snapshot,
          subscribe: () => () => undefined,
          attachSessionTransport: async (
            _t: SessionTransport,
          ): Promise<ConnectedSessionTransport> =>
            ({ close: async () => undefined }) as unknown as ConnectedSessionTransport,
          dispatch: async () => okResult(snapshot),
          close: async () => undefined,
          input: { append: async () => okResult(snapshot) },
          turn: { run: async () => okResult(snapshot) },
          identity: { set: async () => okResult(snapshot) },
          toolProfile: { set: async () => okResult(snapshot) },
          permission: { set: async () => okResult(snapshot) },
          objective: { mutate: async () => okResult(snapshot) },
          posture: { set: async () => okResult(snapshot) },
          skill: { setEnabled: async () => okResult(snapshot) },
          approval: { respond: async () => okResult(snapshot) },
          transcript: { replace: async () => okResult(snapshot) },
          side: {
            start: async () =>
              ({
                outcome: {
                  messages: [],
                  reason: "stop",
                  turns: 0,
                  tokens: { input: 0, output: 0 },
                },
                answerText: "",
                inputTokens: 0,
                outputTokens: 0,
                toolsAvailable: 0,
              }) as unknown as Awaited<ReturnType<RuntimeSession["side"]["start"]>>,
          },
        } as unknown as RuntimeSession
        return session
      },
      close: async () => {
        await session?.close()
      },
    }
  }
}

const boot = async (over: { authToken?: string | undefined }): Promise<WebDaemonHandle> => {
  const config: WebDaemonServerConfig = {
    port: 0,
    bind: "127.0.0.1",
    authToken: over.authToken,
    runtimeFactory: stubFactory(),
    sessionConfig: {},
    supportedReadModels: {
      session: supported("session.v1"),
      agentState: { status: "unsupported" },
      canvas: { status: "unsupported" },
      observability: { status: "unsupported" },
    },
  }
  const handle = await startWebDaemon(config)
  handles.push(handle)
  return handle
}

interface EventsBody {
  threadId: string
  boundary?: string
  events: readonly SessionEvent[]
}

describe("GET /threads/:id/events — B2 thread RESUME route (web daemon)", () => {
  test("TR-01: bearer auth is ENFORCED (401 without/with-wrong token, 200 with header AND ?token)", async () => {
    const handle = await boot({ authToken: "s3cr3t-token" })
    const base = `http://127.0.0.1:${handle.port}/threads/${FOREIGN_THREAD_ID}/events`

    expect((await fetch(base)).status).toBe(401)
    expect((await fetch(base, { headers: { authorization: "Bearer nope" } })).status).toBe(401)
    expect((await fetch(base, { headers: { authorization: "Bearer s3cr3t-token" } })).status).toBe(
      200,
    )
    expect((await fetch(`${base}?token=s3cr3t-token`)).status).toBe(200)
  })

  test("TR-02: a DIFFERENT (foreign) thread id resumes THAT thread's persisted events, read-only", async () => {
    const handle = await boot({ authToken: undefined })
    const res = await fetch(`http://127.0.0.1:${handle.port}/threads/${FOREIGN_THREAD_ID}/events`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as EventsBody
    expect(body.threadId).toBe(FOREIGN_THREAD_ID)
    // The foreign thread's persisted transcript surfaces — NOT the (empty) live
    // session. Driving hydration against only the live id would return [] ⇒ RED.
    expect(body.events.map((e) => e.eventId)).toEqual(["f1", "f2", "f3"])
    // Honest boundary: a thread that is NOT the live session is read-only history.
    expect(body.boundary).toBe("read-only-history")
  })

  test("TR-03: the LIVE session id reports boundary:'live-attach'", async () => {
    const handle = await boot({ authToken: undefined })
    const res = await fetch(`http://127.0.0.1:${handle.port}/threads/${LIVE_SESSION_ID}/events`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as EventsBody
    expect(body.threadId).toBe(LIVE_SESSION_ID)
    expect(body.boundary).toBe("live-attach")
  })

  test("TR-04: UNKNOWN / malformed id ⇒ 200 + empty log (clean, no crash, no auth bypass)", async () => {
    const handle = await boot({ authToken: undefined })

    const ghost = await fetch(`http://127.0.0.1:${handle.port}/threads/never-existed/events`)
    expect(ghost.status).toBe(200)
    const ghostBody = (await ghost.json()) as EventsBody
    expect(ghostBody.events).toEqual([])
    expect(ghostBody.boundary).toBe("read-only-history")

    // A percent-encoded traversal-ish id is decoded to a SEGMENT and treated as
    // an unknown thread — it never resolves a path or 5xxes.
    const hostile = await fetch(
      `http://127.0.0.1:${handle.port}/threads/${encodeURIComponent("../../admin")}/events`,
    )
    expect(hostile.status).toBe(200)
    expect(((await hostile.json()) as EventsBody).events).toEqual([])
  })

  test("TR-05: `?since=N` honors the resume cursor (only seq > N)", async () => {
    const handle = await boot({ authToken: undefined })
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/threads/${FOREIGN_THREAD_ID}/events?since=1`,
    )
    const body = (await res.json()) as EventsBody
    expect(body.events.map((e) => e.eventId)).toEqual(["f2", "f3"])
  })
})

describe("GET /threads/:id/events — persistence OFF honest boundary", () => {
  test("TR-06: QUANTA_WEB_DB=off ⇒ 404 persistence_disabled (not a fake empty resume)", async () => {
    const prev = process.env.QUANTA_WEB_DB
    process.env.QUANTA_WEB_DB = "off"
    try {
      const handle = await boot({ authToken: undefined })
      const res = await fetch(`http://127.0.0.1:${handle.port}/threads/${FOREIGN_THREAD_ID}/events`)
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toBe("persistence_disabled")
    } finally {
      if (prev === undefined) delete process.env.QUANTA_WEB_DB
      else process.env.QUANTA_WEB_DB = prev
    }
  })
})
