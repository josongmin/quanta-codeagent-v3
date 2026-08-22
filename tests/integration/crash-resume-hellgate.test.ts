import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { createInterruptedTurnBuffer } from "@/agent/interrupted-turn"
import { pollConversationAction } from "@/agent/loop/control-poll"
import { prepareTurnIteration, syncQueuedTurnInputs } from "@/agent/loop/turn-iteration"
import { createConversationActionSurface } from "@/apps/cli/repl/conversation-action-surface"
import type { Message } from "@/llm"
import {
  buildCrashResumeOffer,
  CRASH_RESUME_GATE,
  clearSessionInterrupted,
  detectInterruptedSessions,
  listSessions,
  loadSessionById,
  markSessionInterrupted,
  type PersistedInterruptedTurn,
  type SessionMeta,
  saveSessionById,
  sessionFilePath,
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
      tokenBaseline: undefined,
    })
    expect(outcome).toBe("aborted_captured") // ALBB-06: /cancel drain self-captures
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
    const injected = resumed.message.content.map((b) => (b.type === "text" ? b.text : "")).join("")
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

    await markSessionInterrupted(
      SESSION_ID,
      {
        userText: "task",
        partialAssistantText: "partial",
        reason: "crash",
        interruptedAt: 5_000,
      },
      { env: process.env },
    )
    // No write happened (byte-identical snapshot) ...
    expect(readFileSync(sessionFilePath(SESSION_ID), "utf8")).toBe(before)
    // ... and a restart detects nothing.
    const list = await listSessions({ includeArchived: true })
    expect(await detectInterruptedSessions(list, { env: process.env })).toEqual([])
  })

  test("multiple crashed sessions ⇒ restart offers the most-recent first", async () => {
    await seedSession("early")
    await seedSession("late")
    await markSessionInterrupted(
      "early",
      {
        userText: "first task",
        partialAssistantText: "",
        reason: "crash",
        interruptedAt: 1_000,
      },
      { env: process.env },
    )
    await markSessionInterrupted(
      "late",
      {
        userText: "second task",
        partialAssistantText: "",
        reason: "crash",
        interruptedAt: 9_000,
      },
      { env: process.env },
    )
    const list = await listSessions({ includeArchived: true })
    const detections = await detectInterruptedSessions(list, { env: process.env })
    expect(detections.map((d) => d.sessionId)).toEqual(["late", "early"])
    expect(buildCrashResumeOffer(detections[0]!).summary).toContain("second task")
  })

  test("ALBB-06: a SIGNAL-abort (Ctrl+C) capture propagates to SessionMeta.interruptedTurn", async () => {
    // The NEW trigger — a plain AbortController.abort() on the threaded signal —
    // must flow all the way to the persisted snapshot, not just the /cancel verb.
    // RED-ON-INJECTION: mutating the path (a) capture site (prepareTurnIteration
    // signal.aborted early-return) to a no-op empties the buffer ⇒ the persisted
    // reason below is never "signal_abort" ⇒ this assertion goes red.
    const SESSION_ID = "sig-abort-1"
    await seedSession(SESSION_ID)

    const ac = new AbortController()
    ac.abort()
    const buffer = createInterruptedTurnBuffer()
    const cfg = {
      stream: noopStream,
      signal: ac.signal,
      interruptedTurnBuffer: buffer,
    } as unknown as AgentConfig
    const wm = fakeWm([
      msg("user", "refactor the exporter"),
      msg("assistant", "wrote the header stub"),
    ])

    const outcome = await prepareTurnIteration({
      cfg,
      wm: wm as never,
      sessionId: SESSION_ID,
      taskRegistry: undefined,
      turn: 2,
      localizePhaseState: undefined,
      dedupGate: undefined,
      shellSnapshotSession: undefined,
      hookPromptPending: [],
      tokenBaseline: undefined,
    })
    expect(outcome).toBe("aborted")
    expect(buffer.has()).toBe(true)
    expect(buffer.peek()?.reason).toBe("signal_abort")

    // Persist the in-memory capture, then fresh-read it back off disk.
    const captured = buffer.peek()!
    await markSessionInterrupted(
      SESSION_ID,
      {
        userText: captured.userText,
        partialAssistantText: captured.partialAssistantText,
        reason: captured.reason,
        interruptedAt: captured.interruptedAt,
      },
      { env: process.env },
    )
    const snap = await loadSessionById(SESSION_ID)
    expect(snap?.meta.interruptedTurn?.reason).toBe("signal_abort")
    expect(snap?.meta.interruptedTurn?.userText).toBe("refactor the exporter")
    expect(snap?.meta.interruptedTurn?.partialAssistantText).toBe("wrote the header stub")
  })
})

/* ================================================================== */
/* RFC01-4 — A1 boot rehydrate (aug-02 absorption) — NOW LIVE          */
/*                                                                     */
/* CONFIRMED-CORRECTION (README §"RFC-01 A1"): the kernel `SessionEvent`*/
/* log is a seq/wire-continuity rail, NOT a semantic-state SSOT — it   */
/* cannot exact-restore transcript / tool-use+result / approval /      */
/* artifact / revision. `rehydrateState(events)` is DROPPED. The SOLE  */
/* lossless durable authority is the existing `SavedSession` snapshot  */
/* (`messages: Message[]` = full transcript) loaded by                 */
/* `loadSessionById`. RFC01-4 INJECTS that snapshot into the SDK       */
/* runtime cold-start (`src/sdk/runtime/runtime.ts` `createSession` →  */
/* `src/sdk/runtime/session/rehydrate.ts`).                            */
/*                                                                     */
/* The former 5 admission SKIPs are now REAL. Each drives the REAL     */
/* `createRuntime` front door:                                         */
/*   • a durable event log with `tip() > 0` = "this id is RESUMING";   */
/*   • the SavedSession snapshot = the lossless transcript authority.  */
/* Resume MUST rehydrate the full transcript on a clean restart, and   */
/* MUST REFUSE (fail-closed, operator-visible throw) — never silently  */
/* start fresh / partial-merge — when the snapshot is MISSING,         */
/* IDENTITY-MISMATCHED, or its transcript is TAMPERED.                 */
/* ================================================================== */

describe("RFC01-4 A1 boot rehydrate — LIVE (SavedSession injection)", () => {
  const A1_ENV = "QUANTA_SESSION_EVENT_LOG_DIR"
  const SESSIONS_ENV = "QUANTA_SESSIONS_DIR"
  const savedA1Env = process.env[A1_ENV]
  const savedSessionsEnv = process.env[SESSIONS_ENV]
  const a1Dirs: string[] = []
  afterEach(() => {
    if (savedA1Env === undefined) delete process.env[A1_ENV]
    else process.env[A1_ENV] = savedA1Env
    if (savedSessionsEnv === undefined) delete process.env[SESSIONS_ENV]
    else process.env[SESSIONS_ENV] = savedSessionsEnv
    __resetRuntimeConfig()
    for (const d of a1Dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  // Front-door harness: a fresh temp durable-log dir + temp sessions dir, and a
  // single-session host describing `sessionId`. Returns a `createRuntime`
  // cold-start factory that resumes over BOTH dirs — exactly the shape a real
  // process restart sees (durable log persists seq; SavedSession persists the
  // transcript).
  const setupResumeWorld = async (sessionId: string) => {
    const { createRuntime } = await import("@/sdk/runtime")
    const { createSingleSessionRuntimeHost } = await import("@/host/runtime")
    const logDir = mkdtempSync(join(tmpdir(), "rfc01-4-a1-log-"))
    const sessDir = mkdtempSync(join(tmpdir(), "rfc01-4-a1-sess-"))
    a1Dirs.push(logDir, sessDir)
    process.env[A1_ENV] = logDir
    process.env[SESSIONS_ENV] = sessDir
    __resetRuntimeConfig()
    const capabilities = (await import("../support/session-fixtures")).capabilitiesFor()
    const makeHost = () => ({
      describe: () => ({
        sessionId,
        permissionMode: "default" as const,
        capabilityManifest: capabilities,
      }),
      runTurn: async () => {
        throw new Error("not exercised")
      },
      close: async () => undefined,
    })
    const coldStart = async () =>
      (await createRuntime({ host: createSingleSessionRuntimeHost(makeHost) })).createSession({
        cwd: "/tmp",
        permissionMode: "default",
      })
    return { coldStart }
  }

  // Drive one real durable turn append so the event log's `tip() > 0` (the
  // resume signal), then close so a fresh runtime reads a real prior tip.
  const seedDurableTip = async (
    coldStart: () => Promise<{
      input: { append: (t: string) => Promise<unknown> }
      close?: () => Promise<void>
    }>,
  ) => {
    const session0 = await coldStart()
    await session0.input.append("first user message")
    await session0.close?.()
  }

  // (1) CLEAN RESTART EXACT TRANSCRIPT EQUALITY — the happy path. A durable tip
  // + a lossless SavedSession snapshot ⇒ the resumed runtime rehydrates the
  // FULL transcript verbatim (not just seq). RED-ON-INJECTION: reverting the
  // `runtime.ts` rehydrate wiring (or the `session.ts` seed) makes `messages()`
  // empty ⇒ this deep-equal fails.
  test("[rehydrate] clean restart rehydrates the exact SavedSession transcript", async () => {
    const sessionId = "a1-clean"
    const { coldStart } = await setupResumeWorld(sessionId)
    await seedDurableTip(coldStart)

    // Persist the lossless transcript authority (what a real turn-complete save
    // writes) with distinctive tool-use + assistant content.
    const transcript: Message[] = [
      msg("user", "refactor the parser"),
      msg("assistant", "I extracted the tokenizer and called the edit tool"),
      msg("user", "now run the tests"),
    ]
    await saveSessionById(mkMeta(sessionId), {
      reason: "in_progress",
      turns: 2,
      messages: transcript,
    })

    // Cold-start over the SAME durable dir + the seeded snapshot.
    const resumed = await coldStart()
    const rehydrated = resumed.transcript.messages()
    expect(rehydrated).toEqual(transcript)
    // Structural cross-check: the snapshot's content is really present (not an
    // empty vacuous pass).
    const flat = rehydrated
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
    expect(flat).toContain("extracted the tokenizer and called the edit tool")
    // seq + transcript COMPOSE: the derived snapshot summary reflects the
    // rehydrated transcript (messageCount), AND seq continuity still holds — a
    // post-resume append extends past the durable tip rather than restarting.
    const snap = await resumed.snapshot()
    expect(snap.state.messageCount).toBe(transcript.length)
    const appended = await resumed.input.append("post-resume follow-up")
    const nextSeq = appended.events.map((e) => e.seq).reduce((a, b) => Math.max(a, b), 0)
    expect(nextSeq).toBeGreaterThan(1)
    await resumed.close?.()
  })

  // (2) ABSENT SNAPSHOT (two-rail independence) ⇒ byte-identical fresh, NOT a
  // refusal. The durable event log is the seq/wire rail; the `SavedSession`
  // snapshot is an INDEPENDENT transcript rail. A durable log can legitimately
  // exist with NO snapshot (a pure wire/seq-only resume — transport-unified
  // ticket-05). Absence is NOT tamper: resume continues seq but starts with the
  // historical EMPTY transcript, exactly as today (this is the CONTRACT's
  // "no snapshot ⇒ fresh runtime exactly as today"). RED-ON-INJECTION for the
  // refusal-vs-fresh boundary lives in tests (3)/(4) below.
  test("[rehydrate] absent SavedSession (seq-only resume) ⇒ byte-identical fresh, no refusal", async () => {
    const sessionId = "a1-missing"
    const { coldStart } = await setupResumeWorld(sessionId)
    await seedDurableTip(coldStart)
    // NO saveSessionById — the transcript rail is simply empty for this id.
    const resumed = await coldStart()
    // No throw, and the transcript is the historical empty cold start.
    expect(resumed.transcript.messages()).toEqual([])
    // Seq continuity still holds (the seq rail is untouched by the absent
    // transcript rail): the next append extends past the seeded tip.
    const appended = await resumed.input.append("post-resume message")
    const nextSeq = appended.events.map((e) => e.seq).reduce((a, b) => Math.max(a, b), 0)
    expect(nextSeq).toBeGreaterThan(1)
    await resumed.close?.()
  })

  // (3) IDENTITY MISMATCH ⇒ REFUSE (fail-closed). A snapshot that IS present for
  // the resuming id but declares a DIFFERENT `meta.id` (a swapped / tampered
  // file) must refuse rather than adopt a foreign transcript. This test pins the
  // exact refusal + component at the pure validator boundary; the SAME refusal
  // driven through the REAL `createRuntime` front door is test (7).
  test("[rehydrate] snapshot identity mismatch (foreign transcript) ⇒ REFUSED", async () => {
    const sessionId = "a1-ident"
    const { validateResumeSnapshot, ResumeRehydrateRefusedError } = await import(
      "@/sdk/runtime/session/rehydrate"
    )
    const { SESSION_VERSION } = await import("@/session")
    const foreign = {
      version: SESSION_VERSION,
      meta: mkMeta("some-other-session"),
      reason: "in_progress",
      turns: 1,
      messages: [msg("user", "foreign work")],
    }
    let caught: unknown
    try {
      validateResumeSnapshot(sessionId, foreign)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ResumeRehydrateRefusedError)
    expect((caught as InstanceType<typeof ResumeRehydrateRefusedError>).component).toBe("identity")
    expect((caught as Error).message).toContain("identity mismatch")
    expect((caught as Error).message).toContain("some-other-session")
  })

  // (4) TAMPERED TRANSCRIPT — never partial-merges a corrupt transcript. Two
  // guards compose here, both fail-closed against silently adopting garbage:
  //   (a) the `@/session` store's own `savedSessionSchema.safeParse` refuses to
  //       LOAD a badly-corrupt file (`loadSessionById → undefined`), so the
  //       front door takes the byte-identical FRESH path — a corrupt file is
  //       NEVER partial-merged into the runtime;
  //   (b) the boot-time `validateResumeSnapshot` re-check REFUSES a snapshot
  //       that parses the store schema but still violates the Message contract
  //       (defense-in-depth; proven at the pure boundary in test (5)).
  // This test exercises (a) through the REAL front door: a store-corrupt
  // transcript resumes seq only and starts EMPTY, never surfacing the garbage.
  test("[rehydrate] store-corrupt transcript ⇒ never partial-merged (fresh, not garbage)", async () => {
    const sessionId = "a1-tamper"
    const { coldStart } = await setupResumeWorld(sessionId)
    await seedDurableTip(coldStart)
    // Write a well-formed snapshot, then TAMPER the on-disk transcript so one
    // entry is not a valid Message (simulating a corrupted tool-use record).
    await saveSessionById(mkMeta(sessionId), {
      reason: "in_progress",
      turns: 1,
      messages: [msg("user", "call the edit tool")],
    })
    const path = sessionFilePath(sessionId)
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    parsed.messages = [{ role: "assistant", content: "not-an-array-tool-result" }]
    writeFileSync(path, JSON.stringify(parsed))
    __resetRuntimeConfig()

    // The store refuses to load the corrupt file, so the runtime does NOT throw
    // and — critically — does NOT surface the garbage: the transcript is empty,
    // never the corrupt `"not-an-array-tool-result"` string.
    const resumed = await coldStart()
    const messages = resumed.transcript.messages()
    expect(messages).toEqual([])
    const flat = JSON.stringify(messages)
    expect(flat).not.toContain("not-an-array-tool-result")
    await resumed.close?.()
  })

  // (5) FAIL-CLOSED on garbage transcript entry (revision/hash-tamper proxy):
  // any structurally-invalid entry (e.g. a stray non-Message injected mid-log)
  // refuses. Proven at the pure boundary so the exact tamper index is visible.
  test("[rehydrate] structurally-invalid transcript entry ⇒ fail-closed refuse", async () => {
    const sessionId = "a1-garbage"
    const { validateResumeSnapshot, ResumeRehydrateRefusedError } = await import(
      "@/sdk/runtime/session/rehydrate"
    )
    const { SESSION_VERSION } = await import("@/session")
    const tampered = {
      version: SESSION_VERSION,
      meta: mkMeta(sessionId),
      reason: "in_progress",
      turns: 1,
      // valid, valid, GARBAGE — the third entry has a bad role.
      messages: [
        msg("user", "ok"),
        msg("assistant", "sure"),
        { role: "system", content: [] } as unknown as Message,
      ],
    }
    let caught: unknown
    try {
      validateResumeSnapshot(sessionId, tampered)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ResumeRehydrateRefusedError)
    expect((caught as InstanceType<typeof ResumeRehydrateRefusedError>).component).toBe(
      "transcript",
    )
    expect((caught as Error).message).toContain("entry #2")
  })

  // (6) ABSENT-SNAPSHOT BYTE-IDENTICAL: with the in-memory log (default,
  // `QUANTA_SESSION_EVENT_LOG_DIR` unset) there is NO durable tip, so the
  // rehydrate seam is NEVER consulted — cold-start is the historical
  // empty-transcript runtime even if a SavedSession happens to exist on disk.
  // This is the default-OFF guard: the feature adds nothing to the non-durable
  // path.
  test("[rehydrate] no durable log ⇒ rehydrate never runs (byte-identical cold start)", async () => {
    const { createRuntime } = await import("@/sdk/runtime")
    const { createSingleSessionRuntimeHost } = await import("@/host/runtime")
    // Durable log UNSET; sessions dir present WITH a snapshot that WOULD
    // rehydrate if the seam ran.
    delete process.env[A1_ENV]
    const sessDir = mkdtempSync(join(tmpdir(), "rfc01-4-a1-off-"))
    a1Dirs.push(sessDir)
    process.env[SESSIONS_ENV] = sessDir
    __resetRuntimeConfig()
    const sessionId = "a1-off"
    await saveSessionById(mkMeta(sessionId), {
      reason: "in_progress",
      turns: 1,
      messages: [msg("user", "should NOT be rehydrated")],
    })
    const capabilities = (await import("../support/session-fixtures")).capabilitiesFor()
    const makeHost = () => ({
      describe: () => ({
        sessionId,
        permissionMode: "default" as const,
        capabilityManifest: capabilities,
      }),
      runTurn: async () => {
        throw new Error("not exercised")
      },
      close: async () => undefined,
    })
    const runtime = await createRuntime({ host: createSingleSessionRuntimeHost(makeHost) })
    const session = await runtime.createSession({ cwd: "/tmp", permissionMode: "default" })
    // Empty transcript — the in-memory path never touches the SavedSession.
    expect(session.transcript.messages()).toEqual([])
    await session.close?.()
    await runtime.close?.()
  })

  // (7) FRONT-DOOR REFUSAL PROOF: the refusal is genuinely WIRED into the real
  // `createRuntime` cold-start (not just the pure helper). A snapshot that the
  // `@/session` store WILL load (schema-valid) but whose `meta.id` declares a
  // DIFFERENT session (a swapped file) makes `createSession` THROW before any
  // RuntimeSession is assembled — fail-closed, operator-visible, never silent-
  // fresh. RED-ON-INJECTION: reverting the `runtime.ts` wiring (drop the
  // `rehydrateResumeTranscript` call) makes this cold-start SUCCEED with an
  // empty transcript ⇒ `refused` stays false ⇒ this test goes red.
  test("[rehydrate] FRONT DOOR: identity-mismatched loadable snapshot ⇒ createSession THROWS", async () => {
    const sessionId = "a1-frontdoor-ident"
    const { coldStart } = await setupResumeWorld(sessionId)
    await seedDurableTip(coldStart)
    // Persist under `<sessionId>.json` (so loadSessionById(sessionId) FINDS it)
    // but with a meta.id pointing at a DIFFERENT session — a swapped/tampered
    // file the store schema still accepts.
    const swappedMeta = { ...mkMeta(sessionId), id: "SWAPPED-other-id" }
    await saveSessionById(swappedMeta, {
      reason: "in_progress",
      turns: 1,
      messages: [msg("user", "foreign transcript")],
    })
    // saveSessionById wrote to `SWAPPED-other-id.json` (it keys by meta.id), so
    // rename it onto `<sessionId>.json` to simulate the swap on disk.
    const swappedPath = sessionFilePath("SWAPPED-other-id")
    const targetPath = sessionFilePath(sessionId)
    writeFileSync(targetPath, readFileSync(swappedPath, "utf8"))
    __resetRuntimeConfig()

    // Sanity: the store DOES load this file for `sessionId`, and its meta.id is
    // the foreign one (so the identity branch — not the absent branch — fires).
    const loaded = await loadSessionById(sessionId)
    expect(loaded?.meta.id).toBe("SWAPPED-other-id")

    let refused = false
    let started: Awaited<ReturnType<typeof coldStart>> | undefined
    try {
      started = await coldStart()
    } catch (error) {
      refused = true
      expect((error as Error).message).toContain("refusing to resume")
      expect((error as Error).message).toContain("identity mismatch")
    }
    expect(refused).toBe(true)
    expect(started).toBeUndefined()
  })
})
