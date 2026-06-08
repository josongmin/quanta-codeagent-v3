import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { createInterruptedTurnBuffer } from "@/agent/interrupted-turn"
import { pollConversationAction } from "@/agent/loop/control-poll"
import { syncQueuedTurnInputs } from "@/agent/loop/turn-iteration"
import { createConversationActionSurface } from "@/apps/cli/repl/conversation-action-surface"
import type { Message } from "@/llm"
import {
  buildCrashResumeOffer,
  clearSessionInterrupted,
  CRASH_RESUME_GATE,
  detectInterruptedSessions,
  listSessions,
  loadSessionById,
  markSessionInterrupted,
  type PersistedInterruptedTurn,
  saveSessionById,
  sessionFilePath,
  type SessionMeta,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

/**
 * §13.2 CROWN JEWEL — crash-mid-turn → restart → detect + offer + resume.
 *
 * This is the END-TO-END seam, NOT a unit shape test. It drives the REAL loop
 * surfaces (the conversation-action surface, `syncQueuedTurnInputs` capture-on-
 * abort, `pollConversationAction` resume re-injection) AND the REAL session
 * store on a temp dir. The sequence:
 *
 *   1. A turn runs and is interrupted mid-flight via the real loop seam — the
 *      in-memory `InterruptedTurnBuffer` captures the partial work (jun-08 layer).
 *   2. The host persists that capture to the SESSION STORE (`markSessionInterrupted`)
 *      — the NEW durability layer this ticket adds.
 *   3. CRASH: the entire in-memory world (buffer, surface, runtime-config cache)
 *      is discarded — exactly what a SIGKILL/OOM/power-loss does.
 *   4. RESTART: a fresh "process" reads the store, DETECTS the interrupted
 *      session, and builds the operator resume OFFER.
 *   5. RESUME: the persisted marker re-seeds a fresh buffer, and the REAL
 *      `pollConversationAction` resume path re-injects the task — proving the
 *      agent picks the interrupted work back up across the crash boundary.
 *
 * The jun-08 in-memory buffer alone CANNOT survive step 3 — this test fails
 * against the pre-ticket code (no marker on disk ⇒ detect finds nothing).
 */

const ON = { [CRASH_RESUME_GATE]: "1" }

const msg = (role: "user" | "assistant", text: string): Message => ({
  role,
  content: [{ type: "text", text }],
})

/** Minimal structural WorkingMemory (avoids the restricted `@/memory` import). */
const fakeWm = (initial: Message[]) => {
  const buf = [...initial]
  return {
    messages: buf,
    append: (m: Message) => buf.push(m),
    snapshot: () => buf,
    clear: () => {
      buf.length = 0
    },
    replace: (xs: Message[]) => {
      buf.length = 0
      buf.push(...xs)
    },
    tokenEstimate: () => 0,
  }
}

const noopStream = { emit: () => {} }

const buildCfg = (
  surface: ReturnType<typeof createConversationActionSurface>,
  buffer: ReturnType<typeof createInterruptedTurnBuffer>,
): AgentConfig =>
  ({
    stream: noopStream,
    conversationActionPort: surface.port,
    activeTurnRef: surface.activeTurnRef,
    interruptedTurnBuffer: buffer,
  }) as unknown as AgentConfig

const mkMeta = (id: string): SessionMeta => ({
  id,
  title: `T-${id}`,
  cwd: "/tmp/work",
  createdAt: 1_000,
  lastTouched: 1_000,
  archived: false,
})

describe("§13.2 crash-resume hellgate — crash mid-turn → restart → resume", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "crash-resume-hell-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    Object.assign(process.env, ON)
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
  })

  const seedSession = async (id: string) =>
    saveSessionById(mkMeta(id), {
      reason: "in_progress",
      turns: 1,
      messages: [msg("user", "refactor the parser")],
    })

  test("FULL crash boundary: interrupt → persist → CRASH → restart → detect → resume", async () => {
    const SESSION_ID = "crash-1"
    await seedSession(SESSION_ID)

    /* ---- 1. live turn interrupted via the REAL loop seam (in-mem capture) -- */
    const surface = createConversationActionSurface()
    surface.activeTurnRef.current = {
      currentTurn: { turnId: "t1", kind: "main", startedAt: 1, threadId: SESSION_ID },
      isInterrupted: false,
    }
    const liveBuffer = createInterruptedTurnBuffer()
    const cfg = buildCfg(surface, liveBuffer)
    const wm = fakeWm([
      msg("user", "refactor the parser to support nested groups"),
      msg("assistant", "I extracted the tokenizer and started the group rule"),
    ])

    surface.pushCancel("crash")
    const outcome = await syncQueuedTurnInputs({
      cfg,
      wm: wm as never,
      sessionId: SESSION_ID,
      taskRegistry: undefined,
    })
    expect(outcome).toBe("aborted")
    expect(liveBuffer.has()).toBe(true)

    /* ---- 2. host PERSISTS the in-memory capture to the store -------------- */
    const captured = liveBuffer.peek()
    if (captured === null) throw new Error("expected a captured interrupted turn")
    const persisted: PersistedInterruptedTurn = {
      userText: captured.userText,
      partialAssistantText: captured.partialAssistantText,
      reason: captured.reason,
      interruptedAt: captured.interruptedAt,
    }
    await markSessionInterrupted(SESSION_ID, persisted, { env: process.env })

    // The marker is durable on disk RIGHT NOW (independent of the live buffer).
    expect(existsSync(sessionFilePath(SESSION_ID))).toBe(true)
    const onDisk = JSON.parse(readFileSync(sessionFilePath(SESSION_ID), "utf8"))
    expect(onDisk.meta.interruptedTurn?.reason).toBe("crash")

    /* ---- 3. CRASH: discard ALL in-memory state -------------------------- */
    // Simulate SIGKILL: the buffer, surface, and runtime-config cache vanish.
    // (In a real crash the whole process dies; here we drop every reference and
    //  reset the runtime-config so nothing in-memory carries over.)
    __resetRuntimeConfig()
    // re-point at the same on-disk store (a fresh process re-reads the env).
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()

    /* ---- 4. RESTART: detect + build the operator offer ------------------- */
    const list = await listSessions({ includeArchived: true })
    const detections = await detectInterruptedSessions(list, { env: process.env })
    expect(detections.length).toBe(1)
    expect(detections[0]?.sessionId).toBe(SESSION_ID)

    const offer = buildCrashResumeOffer(detections[0]!)
    expect(offer.summary).toContain("interrupted mid-turn")
    expect(offer.resumeMessage).toContain("refactor the parser to support nested groups")
    expect(offer.resumeMessage).toContain("I extracted the tokenizer")

    /* ---- 5. RESUME: re-seed a fresh buffer from the persisted marker and  */
    /*        drive the REAL resume path on a fresh surface ----------------- */
    const restartSurface = createConversationActionSurface()
    restartSurface.activeTurnRef.current = {
      currentTurn: { turnId: "t2", kind: "main", startedAt: 2, threadId: SESSION_ID },
      isInterrupted: false,
    }
    const restartBuffer = createInterruptedTurnBuffer()
    const snap = await loadSessionById(SESSION_ID)
    const marker = snap?.meta.interruptedTurn
    if (marker === undefined) throw new Error("expected persisted marker after restart")
    restartBuffer.capture(marker) // host re-hydrates the in-mem buffer from disk
    const restartCfg = buildCfg(restartSurface, restartBuffer)

    restartSurface.pushResume()
    const resumed = await pollConversationAction(restartCfg, undefined)
    expect(resumed.kind).toBe("injection")
    if (resumed.kind !== "injection") throw new Error("expected injection")
    const injected = resumed.message.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    expect(injected).toContain("refactor the parser to support nested groups")
    expect(injected).toContain("I extracted the tokenizer")
    expect(injected.toLowerCase()).toContain("resume")

    /* ---- 6. CLEAN UP: clearing the marker means a 2nd restart finds none -- */
    await clearSessionInterrupted(SESSION_ID, { env: process.env })
    const list2 = await listSessions({ includeArchived: true })
    expect(await detectInterruptedSessions(list2, { env: process.env })).toEqual([])
  })

  test("DEFAULT-OFF regression: gate absent ⇒ no marker survives a crash (jun-08 baseline)", async () => {
    // This is the pre-ticket world: the in-memory buffer captures, but WITHOUT
    // the gate the persist is a no-op, so a restart detects nothing — exactly
    // the gap §13.2 closes. Proves default-OFF is byte-identical to jun-08.
    delete process.env[CRASH_RESUME_GATE]
    __resetRuntimeConfig()

    const SESSION_ID = "crash-off"
    await seedSession(SESSION_ID)
    const before = readFileSync(sessionFilePath(SESSION_ID), "utf8")

    await markSessionInterrupted(SESSION_ID, {
      userText: "task",
      partialAssistantText: "partial",
      reason: "crash",
      interruptedAt: 5_000,
    }, { env: process.env })
    // No write happened (byte-identical snapshot) ...
    expect(readFileSync(sessionFilePath(SESSION_ID), "utf8")).toBe(before)
    // ... and a restart detects nothing.
    const list = await listSessions({ includeArchived: true })
    expect(await detectInterruptedSessions(list, { env: process.env })).toEqual([])
  })

  test("multiple crashed sessions ⇒ restart offers the most-recent first", async () => {
    await seedSession("early")
    await seedSession("late")
    await markSessionInterrupted("early", {
      userText: "first task",
      partialAssistantText: "",
      reason: "crash",
      interruptedAt: 1_000,
    }, { env: process.env })
    await markSessionInterrupted("late", {
      userText: "second task",
      partialAssistantText: "",
      reason: "crash",
      interruptedAt: 9_000,
    }, { env: process.env })
    const list = await listSessions({ includeArchived: true })
    const detections = await detectInterruptedSessions(list, { env: process.env })
    expect(detections.map((d) => d.sessionId)).toEqual(["late", "early"])
    expect(buildCrashResumeOffer(detections[0]!).summary).toContain("second task")
  })
})
