import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSingleSessionRuntimeHost } from "@/host/runtime"
import type { SessionHost } from "@/kernel/session"
import { encodeSessionEvent, type SessionEvent } from "@/protocol/session"
import { createRuntime } from "@/sdk/runtime"
import { ResumeRehydrateRefusedError } from "@/sdk/runtime/session/rehydrate"
import { sessionFilePath } from "@/session/paths"
import { __resetRuntimeConfig } from "@/shared"
import { capabilitiesFor } from "../../../support/session-fixtures"

const LOG_ENV = "QUANTA_SESSION_EVENT_LOG_DIR"
const SESS_ENV = "QUANTA_SESSIONS_DIR"
const SESSION_ID = "d07-runtime-refuse"

const tmpDirs: string[] = []
const savedLog = process.env[LOG_ENV]
const savedSess = process.env[SESS_ENV]

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (savedLog === undefined) delete process.env[LOG_ENV]
  else process.env[LOG_ENV] = savedLog
  if (savedSess === undefined) delete process.env[SESS_ENV]
  else process.env[SESS_ENV] = savedSess
  __resetRuntimeConfig()
})

const deltaEvent = (seq: number, delta: string): SessionEvent => ({
  eventId: `e-${seq}`,
  seq,
  revision: seq,
  emittedAt: "2026-09-09T00:00:00.000Z",
  type: "turn.output.delta",
  delta,
})

const makeHost = (closeCalls: { count: number }): SessionHost =>
  ({
    describe: () => ({
      sessionId: SESSION_ID,
      permissionMode: "default",
      capabilityManifest: capabilitiesFor(),
      identityMode: "default",
      toolProfile: "write",
    }),
    runTurn: async () => {
      throw new Error("runTurn must not be reached after rehydrate refuse")
    },
    close: async () => {
      closeCalls.count += 1
    },
  }) as unknown as SessionHost

describe("SEP7-D-07.4 createRuntimeFacade refuses corrupt snapshot", () => {
  test("durable tip + corrupt snapshot refuses; no overwrite, no assembled session", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "r03-d074-log-"))
    const sessDir = mkdtempSync(join(tmpdir(), "r03-d074-sess-"))
    tmpDirs.push(logDir, sessDir)
    process.env[LOG_ENV] = logDir
    process.env[SESS_ENV] = sessDir
    __resetRuntimeConfig()

    const logPath = join(logDir, `${SESSION_ID}.jsonl`)
    const logBody = `${encodeSessionEvent(deltaEvent(1, "prior"))}\n`
    writeFileSync(logPath, logBody)
    const snapshotPath = sessionFilePath(SESSION_ID)
    const broken = "{ not a session"
    writeFileSync(snapshotPath, broken)

    const closeCalls = { count: 0 }
    const runtime = await createRuntime({
      host: createSingleSessionRuntimeHost(() => makeHost(closeCalls)),
    })
    await expect(
      runtime.createSession({ cwd: "/tmp", permissionMode: "default" }),
    ).rejects.toBeInstanceOf(ResumeRehydrateRefusedError)
    expect(closeCalls.count).toBe(1)
    expect(readFileSync(snapshotPath, "utf8")).toBe(broken)
    expect(readFileSync(logPath, "utf8")).toBe(logBody)
    expect(readdirSync(sessDir).filter((n) => n.endsWith(".json"))).toEqual([`${SESSION_ID}.json`])
    await runtime.close()
  })
})
