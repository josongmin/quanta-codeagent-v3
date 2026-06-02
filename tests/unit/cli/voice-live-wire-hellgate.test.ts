/**
 * Hellgate — `/voice-live` composition-root WIRE (ADR-0442 limitation closure).
 *
 * The cmd-level REPL contract is pinned by `voice-live-cmd-hellgate.test.ts`.
 * THIS battery pins the COMPOSITION: that typing `/voice-live` actually
 * CONSTRUCTS a live `RealtimeVoiceSessionPort` with the correct injected deps,
 * behind the opt-in gate, TTY-only, with auth injected at the root (never read
 * inside the realtime slice), and byte-identical when the feature is off.
 *
 *  HELL-VLW-01: gate off (no QUANTA_VOICE_LIVE) ⇒ buildVoiceLiveCtx === undefined
 *  HELL-VLW-02: voiceLiveEnabled honours only 1/on/true (default-OFF otherwise)
 *  HELL-VLW-03: opt-in + TTY ⇒ ctx with a constructed session + endpoint/model/auth + key reader
 *  HELL-VLW-04: opt-in + non-TTY ⇒ ctx built but NO key reader ⇒ runVoiceLiveCmd declines (exit 0)
 *  HELL-VLW-05: auth injected from the PASSED env (OPENAI_API_KEY), not a global read
 *  HELL-VLW-06: resolveRealtimeBearer prefers OPENAI_API_KEY; absent ⇒ null (no auth slot)
 *  HELL-VLW-07: env endpoint/model/voice overrides ride through into the ctx
 *  HELL-VLW-08: registry — /voice-live is registered + describable
 *  HELL-VLW-09: registry — slot absent ⇒ "not wired" + exit 0 (default-OFF byte-identical)
 *  HELL-VLW-10: registry — builder resolves undefined (gate off/non-TTY) ⇒ decline + exit 0
 *  HELL-VLW-11: registry — builder resolves a ctx ⇒ routed into the session (status path)
 */

import { describe, expect, test } from "bun:test"
import {
  buildVoiceLiveCtx,
  resolveRealtimeBearer,
  voiceLiveEnabled,
} from "@/apps/cli/repl/voice-live-wire"
import { describeSlashCommand, runSlashCommand, type SlashContext } from "@/apps/cli/slash-commands"
import type { VoiceLiveCtx } from "@/apps/cli/voice-live-cmd"
import type { RealtimePort, RealtimeStatus } from "@/realtime"
import type { RealtimeVoiceSessionPort } from "@/realtime/voice-session"

const collect = (): {
  out: string[]
  err: string[]
  outFn: (s: string) => void
  errFn: (s: string) => void
} => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, outFn: (s) => out.push(s), errFn: (s) => err.push(s) }
}

/** A fake transport that records connect/send and never opens a real socket. */
const fakeTransport = (): RealtimePort => ({
  async connect() {
    return { ok: true, value: undefined }
  },
  send() {
    return { ok: true, value: undefined }
  },
  onMessage() {
    return () => {}
  },
  async negotiate() {
    return { ok: true, value: { sdp: "", codec: "pcm" as const } }
  },
  audioStart() {
    return { ok: true, value: undefined }
  },
  audioStop() {
    return { ok: true, value: undefined }
  },
  status(): RealtimeStatus {
    return "closed"
  },
  async close() {
    return { ok: true, value: undefined }
  },
})

/** A recorder spawner whose `which` resolves so the wire picks a backend, but
 *  whose `spawn` is never driven in these tests (we don't start a session). */
const fakeRecorderSpawner = (binPath: string | null) => ({
  which: () => binPath,
  spawn: () => ({
    stdout: null,
    exited: Promise.resolve(0),
    kill: () => {},
  }),
})

const fakePlaybackSpawner = () => ({
  which: () => null,
  spawn: () => ({ write: () => {}, end: () => {}, kill: () => {} }),
})

const baseDeps = (env: Record<string, string | undefined>, isTty: boolean) => ({
  env,
  isTty,
  now: () => 0,
  transportFactory: (): RealtimePort => fakeTransport(),
  recorderSpawner: fakeRecorderSpawner("/usr/bin/sox"),
  playbackSpawner: fakePlaybackSpawner(),
})

describe("voice-live-wire — opt-in gate", () => {
  test("HELL-VLW-01: gate off ⇒ buildVoiceLiveCtx undefined", async () => {
    const ctx = await buildVoiceLiveCtx(baseDeps({}, true))
    expect(ctx).toBeUndefined()
  })

  test("HELL-VLW-02: voiceLiveEnabled honours only 1/on/true", () => {
    expect(voiceLiveEnabled({ QUANTA_VOICE_LIVE: "1" })).toBe(true)
    expect(voiceLiveEnabled({ QUANTA_VOICE_LIVE: "on" })).toBe(true)
    expect(voiceLiveEnabled({ QUANTA_VOICE_LIVE: "true" })).toBe(true)
    expect(voiceLiveEnabled({ QUANTA_VOICE_LIVE: "0" })).toBe(false)
    expect(voiceLiveEnabled({ QUANTA_VOICE_LIVE: "yes" })).toBe(false)
    expect(voiceLiveEnabled({})).toBe(false)
  })
})

describe("voice-live-wire — construction", () => {
  test("HELL-VLW-03: opt-in + TTY ⇒ constructed session + endpoint/model/auth + key reader", async () => {
    const ctx = await buildVoiceLiveCtx({
      ...baseDeps({ QUANTA_VOICE_LIVE: "1", OPENAI_API_KEY: "sk-test" }, true),
      keypressStdin: {
        isTTY: true,
        setRawMode: () => {},
        resume: () => {},
        pause: () => {},
        on: () => {},
        off: () => {},
      },
    })
    expect(ctx).toBeDefined()
    const built = ctx as VoiceLiveCtx
    // A real RealtimeVoiceSessionPort was constructed (5-state machine, idle).
    const session = built.session as RealtimeVoiceSessionPort
    expect(typeof session.state).toBe("function")
    expect(session.state()).toBe("idle")
    expect(session.muted()).toBe(false)
    expect(built.endpoint).toBe("wss://api.openai.com/v1/realtime")
    expect(built.model).toBe("gpt-realtime")
    expect(built.auth).toBe("sk-test")
    // TTY ⇒ a raw-mode key reader is present.
    expect(built.keys).toBeDefined()
  })

  test("HELL-VLW-04: opt-in + non-TTY ⇒ no key reader ⇒ runVoiceLiveCmd declines (exit 0)", async () => {
    const ctx = await buildVoiceLiveCtx(
      baseDeps({ QUANTA_VOICE_LIVE: "1", OPENAI_API_KEY: "sk-test" }, false),
    )
    expect(ctx).toBeDefined()
    const built = ctx as VoiceLiveCtx
    expect(built.keys).toBeUndefined()
    const io = collect()
    const { runVoiceLiveCmd } = await import("@/apps/cli/voice-live-cmd")
    const code = await runVoiceLiveCmd("/voice-live", {
      ...built,
      out: io.outFn,
      err: io.errFn,
    })
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("interactive terminal")
  })

  test("HELL-VLW-05/06: auth injected from PASSED env (OPENAI_API_KEY wins); no resolvable bearer ⇒ no auth slot", async () => {
    // OPENAI_API_KEY in the PASSED env wins (BYOK) — proves the bearer comes
    // from the injected env, not a global process.env read inside the slice.
    expect(await resolveRealtimeBearer({ OPENAI_API_KEY: "sk-from-env" })).toBe("sk-from-env")
    // Empty key string is NOT treated as a bearer (falls through to OAuth/null).
    // We can't assert the OAuth fallback deterministically on a logged-in host,
    // so the "no bearer" path is pinned via the injected resolveBearer stub.
    // Built ctx with no resolvable bearer ⇒ `auth` slot omitted.
    const ctx = await buildVoiceLiveCtx({
      ...baseDeps({ QUANTA_VOICE_LIVE: "1" }, true),
      resolveBearer: async () => null,
      keypressStdin: {
        isTTY: true,
        setRawMode: () => {},
        resume: () => {},
        pause: () => {},
        on: () => {},
        off: () => {},
      },
    })
    expect((ctx as VoiceLiveCtx).auth).toBeUndefined()
  })

  test("HELL-VLW-07: env endpoint/model/voice overrides ride through", async () => {
    const ctx = await buildVoiceLiveCtx({
      ...baseDeps(
        {
          QUANTA_VOICE_LIVE: "1",
          OPENAI_API_KEY: "sk-test",
          QUANTA_VOICE_LIVE_ENDPOINT: "wss://example.test/rt",
          QUANTA_VOICE_LIVE_MODEL: "gpt-realtime-mini",
          QUANTA_VOICE_LIVE_VOICE: "verse",
        },
        false,
      ),
    })
    const built = ctx as VoiceLiveCtx
    expect(built.endpoint).toBe("wss://example.test/rt")
    expect(built.model).toBe("gpt-realtime-mini")
    expect(built.voice).toBe("verse")
  })
})

describe("voice-live-wire — REPL registry", () => {
  test("HELL-VLW-08: /voice-live is registered + describable", () => {
    expect(describeSlashCommand("/voice-live")).toBeDefined()
    expect(describeSlashCommand("/voice-live")).toContain("QUANTA_VOICE_LIVE")
  })

  test("HELL-VLW-09: slot absent ⇒ 'not wired' + exit 0 (default-OFF)", async () => {
    const io = collect()
    const ctx: SlashContext = {
      out: io.outFn,
      err: io.errFn,
      cwd: "/tmp",
      // no voiceLive slot
    }
    const code = await runSlashCommand("/voice-live", ctx)
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("not wired")
  })

  test("HELL-VLW-10: builder resolves undefined (gate off / non-TTY) ⇒ decline + exit 0", async () => {
    const io = collect()
    const ctx: SlashContext = {
      out: io.outFn,
      err: io.errFn,
      cwd: "/tmp",
      voiceLive: async () => undefined,
    }
    const code = await runSlashCommand("/voice-live", ctx)
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("not enabled")
  })

  test("HELL-VLW-11: builder resolves a ctx ⇒ routed into the session (status)", async () => {
    const sessionOut: string[] = []
    const built = await buildVoiceLiveCtx({
      ...baseDeps({ QUANTA_VOICE_LIVE: "1", OPENAI_API_KEY: "sk-test" }, true),
      keypressStdin: {
        isTTY: true,
        setRawMode: () => {},
        resume: () => {},
        pause: () => {},
        on: () => {},
        off: () => {},
      },
    })
    const io = collect()
    const ctx: SlashContext = {
      out: io.outFn,
      err: io.errFn,
      cwd: "/tmp",
      // Re-route the built ctx's out to our buffer so we can assert the
      // session status line came from the constructed session.
      voiceLive: async () => ({
        ...(built as VoiceLiveCtx),
        out: (s: string) => sessionOut.push(s),
      }),
    }
    const code = await runSlashCommand("/voice-live status", ctx)
    expect(code).toBe(0)
    // The status line is produced by the CONSTRUCTED RealtimeVoiceSessionPort.
    expect(sessionOut.join("")).toContain("state=idle")
    expect(sessionOut.join("")).toContain("mode=server_vad")
  })
})
