/**
 * AUDIT-γ H3 (resource leak) — createSession must not orphan a hostSession when
 * session persistence throws.
 *
 * BUG. `createRuntimeFacade.createSession` creates the hostSession FIRST
 * (`options.host.createSessionHost`) and only THEN builds session persistence
 * (`createSessionPersistence`). The durable JSONL backend legitimately throws at
 * this point — an unwritable log dir, or a `<sessionId>.jsonl.lock` held by a
 * LIVE pid (single-writer guard). With no try/finally, that throw escapes with
 * the hostSession (PTY / subprocess / fds) never closed. In a long-lived daemon
 * with a misconfigured log dir, EVERY createSession leaks a host session.
 *
 * CONTRACT. On any throw AFTER the hostSession is created, createSession must
 * (a) close the hostSession exactly once and (b) rethrow the original error.
 *
 * REAL SEAM. We drive the ACTUAL persistence path (not a stubbed factory):
 * point `QUANTA_SESSION_EVENT_LOG_DIR` at a dir where a lock file for this
 * session id is already held by THIS (live) process pid, so
 * `JsonlSessionEventLog`'s single-writer guard throws `already open by live
 * pid`. The hostSession exposes a close SPY; we assert it fired.
 *
 * RED-ON-INJECTION. Delete the try/finally in runtime.ts and this goes red —
 * the rethrow still happens (the error propagates naturally) but close() is
 * never called, so the closeCalls assertion fails.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSingleSessionRuntimeHost } from "@/host/runtime"
import { JsonlSessionEventLogLockError, type SessionHost } from "@/kernel/session"
import { createRuntime } from "@/sdk/runtime"
import { capabilitiesFor } from "../../support/session-fixtures"

const tmpDirs: string[] = []
const priorEnv = process.env.QUANTA_SESSION_EVENT_LOG_DIR
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (priorEnv === undefined) delete process.env.QUANTA_SESSION_EVENT_LOG_DIR
  else process.env.QUANTA_SESSION_EVENT_LOG_DIR = priorEnv
})

const SESSION_ID = "leak-probe"

/** A minimal hostSession whose close() is a spy; other members are inert — the
 *  session is expected to throw during assembly, long before they're touched. */
const makeSpyHost = (closeCalls: { count: number }): SessionHost =>
  ({
    describe: () => ({
      sessionId: SESSION_ID,
      permissionMode: "default",
      capabilityManifest: capabilitiesFor(),
      identityMode: "default",
      toolProfile: "write",
    }),
    runTurn: async () => {
      throw new Error("runTurn must not be reached in the leak probe")
    },
    close: async () => {
      closeCalls.count += 1
    },
  }) as unknown as SessionHost

describe("AUDIT-γ H3 — createSession closes hostSession when persistence throws", () => {
  test("live-pid lock makes persistence throw → hostSession.close() fired + rethrown", async () => {
    // Durable backend ON, pointed at a dir where the lock is already held by
    // THIS (live) process → the single-writer guard throws.
    const dir = mkdtempSync(join(tmpdir(), "quanta-h3-leak-"))
    tmpDirs.push(dir)
    writeFileSync(join(dir, `${SESSION_ID}.jsonl.lock`), String(process.pid))
    process.env.QUANTA_SESSION_EVENT_LOG_DIR = dir

    const closeCalls = { count: 0 }
    const runtime = await createRuntime({
      host: createSingleSessionRuntimeHost(() => makeSpyHost(closeCalls)),
    })

    let thrown: unknown
    try {
      await runtime.createSession({ cwd: "/tmp", permissionMode: "default" })
    } catch (error) {
      thrown = error
    }

    // (b) the original persistence error is rethrown, not swallowed.
    expect(thrown).toBeInstanceOf(JsonlSessionEventLogLockError)
    // (a) the already-created hostSession was closed exactly once — no orphan.
    expect(closeCalls.count).toBe(1)

    await runtime.close()
  })
})
