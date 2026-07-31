/**
 * e2e: the CLI attach client against an EPHEMERAL in-process web daemon
 * (`startWebDaemon` via the `@/apps/web-daemon` `main` export on port 0).
 *
 * Asserts the full loop: `attachToDaemon` opens a real WebSocket, performs the
 * session.v1 discovery→adopt handshake, a typed line reaches the daemon's
 * shared session as `input.append`+`turn.run`, and the resulting assistant
 * stream is rendered back to the terminal sink.
 *
 * The daemon uses the SAME stub runtime fixture the web-daemon e2e suite uses,
 * so no LLM / network is touched. Port 0 ⇒ never collides with the real :4096.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { attachToDaemon } from "@/apps/cli/attach"
import { main as startDaemon } from "@/apps/web-daemon"
import type { WebDaemonHandle } from "@/apps/web-daemon/types"
import { createStubRuntimeFactory } from "../../web-daemon/fixture"

const handles: WebDaemonHandle[] = []

// Isolate the daemon's SQLite thread store to a tmp dir so the e2e never
// reads/writes the operator's real `~/.quanta/web-daemon/threads.db`.
let tmpDbDir: string
let prevDbDir: string | undefined

beforeAll(() => {
  tmpDbDir = mkdtempSync(join(tmpdir(), "quanta-attach-e2e-db-"))
  prevDbDir = process.env.QUANTA_WEB_DB_DIR
  process.env.QUANTA_WEB_DB_DIR = tmpDbDir
})

afterAll(() => {
  if (prevDbDir === undefined) delete process.env.QUANTA_WEB_DB_DIR
  else process.env.QUANTA_WEB_DB_DIR = prevDbDir
  rmSync(tmpDbDir, { recursive: true, force: true })
})

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop()
    if (h !== undefined) await h.stop().catch(() => undefined)
  }
})

const waitUntil = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("attachToDaemon e2e (ephemeral in-process daemon)", () => {
  test("attaches, sends a line, and renders the assistant stream back", async () => {
    const { factory } = createStubRuntimeFactory()
    const handle = await startDaemon({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const rendered: string[] = []
    // A controllable stdin: the harness pushes lines; the client reads them.
    let pushLine: ((line: string) => void) | undefined
    const stdin = (async function* () {
      const queue: string[] = []
      let resolveNext: (() => void) | undefined
      pushLine = (line: string) => {
        queue.push(line)
        resolveNext?.()
      }
      // Yield forever until the session closes the iterator (client returns).
      for (;;) {
        if (queue.length > 0) {
          const next = queue.shift()
          if (next !== undefined) yield next
          continue
        }
        await new Promise<void>((resolve) => {
          resolveNext = resolve
        })
      }
    })()

    const session = await attachToDaemon({
      url: `ws://127.0.0.1:${handle.port}/`,
      stdin,
      write: (chunk) => rendered.push(chunk),
      // Auto-deny approvals in the test (no interactive prompt needed here).
      promptApproval: async () => "n",
    })

    // Handshake must settle (canonical sessionId adopted, snapshot received).
    await waitUntil(() => session.sessionId === "stub-session-1")

    // Push a line — it should reach the shared session and stream back.
    expect(pushLine).toBeDefined()
    pushLine?.("hello")

    await waitUntil(() => rendered.join("").includes("stub: hello"))
    expect(rendered.join("")).toContain("stub: hello")

    await session.close()
  })

  test("the session id is the daemon's canonical id, not the discovery sentinel", async () => {
    const { factory } = createStubRuntimeFactory()
    const handle = await startDaemon({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const noopStdin = (async function* () {
      // Never yields — keeps the read loop parked so the test can inspect the
      // adopted id without sending anything.
      await new Promise<void>(() => undefined)
    })()

    const session = await attachToDaemon({
      url: `ws://127.0.0.1:${handle.port}/`,
      stdin: noopStdin,
      write: () => undefined,
      promptApproval: async () => "n",
    })

    await waitUntil(() => session.sessionId !== undefined)
    expect(session.sessionId).toBe("stub-session-1")
    expect(session.sessionId).not.toBe("ui-session")

    await session.close()
  })
})
