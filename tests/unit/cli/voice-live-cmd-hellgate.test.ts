import { describe, expect, test } from "bun:test"
import {
  runVoiceLiveCmd,
  type VoiceLiveControl,
  type VoiceLiveCtx,
  type VoiceLiveKeyReader,
} from "@/apps/cli/voice-live-cmd"
import type {
  RealtimeVoiceSessionPort,
  VoiceSessionError,
  VoiceSessionEvent,
  VoiceSessionState,
} from "@/realtime/voice-session"
import { err, ok, type Result } from "@/shared"

/**
 * Hellgate for the `/voice-live` slash (ADR-0439, RFC §5). Asserts exact REPL
 * strings for start/listening/mute/interrupt/end + the default-OFF and
 * headless gates. Injected `out`/`err` + a fake session — zero real I/O.
 */

/** A scripted key reader that yields a fixed control sequence. */
const scriptedKeys = (seq: ReadonlyArray<VoiceLiveControl | null>): VoiceLiveKeyReader => {
  let i = 0
  return {
    async next(): Promise<VoiceLiveControl | null> {
      const v = i < seq.length ? seq[i] : null
      i++
      return v ?? null
    },
  }
}

/** A fake session that records ops + lets the test drive state/events. */
interface FakeSession extends RealtimeVoiceSessionPort {
  readonly ops: string[]
  fire(e: VoiceSessionEvent): void
  setStartError(e: VoiceSessionError): void
  setState(s: VoiceSessionState): void
}
const fakeSession = (): FakeSession => {
  const ops: string[] = []
  let handler: ((e: VoiceSessionEvent) => void) | null = null
  let state: VoiceSessionState = "idle"
  let muted = false
  let startError: VoiceSessionError | null = null
  const self: FakeSession = {
    ops,
    fire(e) {
      handler?.(e)
    },
    setStartError(e) {
      startError = e
    },
    setState(s) {
      state = s
    },
    async start(): Promise<Result<void, VoiceSessionError>> {
      ops.push("start")
      if (startError) return err(startError)
      state = "listening"
      handler?.({ kind: "state", state: "listening", at: 1 })
      return ok(undefined)
    },
    commitTurn() {
      ops.push("commitTurn")
      return ok(undefined)
    },
    sendText() {
      return ok(undefined)
    },
    setMuted(m: boolean) {
      ops.push(`setMuted:${m}`)
      muted = m
      return ok(undefined)
    },
    interrupt() {
      ops.push("interrupt")
      return ok(undefined)
    },
    onEvent(h) {
      handler = h
      return () => {
        handler = null
      }
    },
    state() {
      return state
    },
    muted() {
      return muted
    },
    async close() {
      ops.push("close")
      state = "closed"
      return ok(undefined)
    },
  }
  return self
}

const capture = (): { ctx: Pick<VoiceLiveCtx, "out" | "err">; out: string[]; errs: string[] } => {
  const out: string[] = []
  const errs: string[] = []
  return { ctx: { out: (s) => out.push(s), err: (s) => errs.push(s) }, out, errs }
}

describe("/voice-live default-OFF gate", () => {
  test("no session ⇒ 'not wired' + exit 1", async () => {
    const c = capture()
    const code = await runVoiceLiveCmd("/voice-live", { ...c.ctx })
    expect(code).toBe(1)
    expect(c.errs.join("")).toContain("realtime voice not wired")
  })
})

describe("/voice-live headless decline", () => {
  test("session wired but no keys ⇒ exit 0 + interactive-terminal notice", async () => {
    const c = capture()
    const session = fakeSession()
    const code = await runVoiceLiveCmd("/voice-live", { ...c.ctx, session })
    expect(code).toBe(0)
    expect(c.out.join("")).toContain("requires an interactive terminal")
    // never started a mic session headless.
    expect(session.ops).not.toContain("start")
  })
})

describe("/voice-live status", () => {
  test("prints state + muted + mode", async () => {
    const c = capture()
    const session = fakeSession()
    session.setState("listening")
    const code = await runVoiceLiveCmd("/voice-live status", {
      ...c.ctx,
      session,
      mode: "push_to_talk",
    })
    expect(code).toBe(0)
    expect(c.out.join("")).toContain("state=listening")
    expect(c.out.join("")).toContain("muted=false")
    expect(c.out.join("")).toContain("mode=push_to_talk")
  })

  test("status without session ⇒ exit 1", async () => {
    const c = capture()
    const code = await runVoiceLiveCmd("/voice-live status", { ...c.ctx })
    expect(code).toBe(1)
  })
})

describe("/voice-live live loop", () => {
  test("start → mute → interrupt → end emits the mirrored composer labels", async () => {
    const c = capture()
    const session = fakeSession()
    const keys = scriptedKeys(["mute", "interrupt", "end"])
    const code = await runVoiceLiveCmd("/voice-live", { ...c.ctx, session, keys })
    expect(code).toBe(0)
    const joined = c.out.join("")
    expect(joined).toContain("listening...")
    expect(joined).toContain("muted")
    expect(joined).toContain("interrupted")
    expect(joined).toContain("ending...")
    expect(session.ops).toEqual(["start", "setMuted:true", "interrupt", "close"])
  })

  test("start error renders connection error + exit 1", async () => {
    const c = capture()
    const session = fakeSession()
    session.setStartError({ kind: "connect-failed", degradeReason: "refused" })
    const keys = scriptedKeys(["end"])
    const code = await runVoiceLiveCmd("/voice-live", { ...c.ctx, session, keys })
    expect(code).toBe(1)
    expect(c.errs.join("")).toContain("connection error")
  })

  test("mic-permission start error renders microphone permission error", async () => {
    const c = capture()
    const session = fakeSession()
    session.setStartError({ kind: "mic-permission", degradeReason: "no backend" })
    const keys = scriptedKeys(["end"])
    const code = await runVoiceLiveCmd("/voice-live", { ...c.ctx, session, keys })
    expect(code).toBe(1)
    expect(c.errs.join("")).toContain("microphone permission error")
  })

  test("transcript-delta events stream to stdout", async () => {
    const c = capture()
    const session = fakeSession()
    const keys: VoiceLiveKeyReader = {
      async next() {
        // fire a transcript delta then end.
        session.fire({ kind: "transcript-delta", text: "hi there", at: 2 })
        return "end"
      },
    }
    await runVoiceLiveCmd("/voice-live", { ...c.ctx, session, keys })
    expect(c.out.join("")).toContain("hi there")
  })
})

describe("/voice-live unknown subcommand", () => {
  test("exits 1 with usage", async () => {
    const c = capture()
    const session = fakeSession()
    const code = await runVoiceLiveCmd("/voice-live frobnicate", { ...c.ctx, session })
    expect(code).toBe(1)
    expect(c.errs.join("")).toContain("unknown subcommand")
  })
})
