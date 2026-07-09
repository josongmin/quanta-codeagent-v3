/**
 * Hellgate — `/voice` register-or-degrade (plan D-9; UUX-2-05 + UUX-1-10).
 *
 * The full `/voice` handler (voice-cmd.ts, ADR-0208) existed with ZERO slash
 * registry entries — only `/voice-live` was registered, so the advertised
 * ADR-0208 surface was unreachable. D-9's decision: REGISTER with an honest
 * transcriber-presence degrade (not delete).
 *
 * Honesty pins:
 *  HELL-VREG-01: `/voice` exists in the assembled BUILTINS registry.
 *  HELL-VREG-02: dispatch with NO voice wire ⇒ exit NONZERO + a `hint:` line
 *                (never a silent success).
 *  HELL-VREG-03: recorder wired but NO transcriber ⇒ exit nonzero + hint AND
 *                the recorder is NEVER started — the pre-fix flow recorded
 *                10s of audio, threw it away, and exited 0 (UUX-6-27's
 *                capture-then-exit-0 lie).
 *  HELL-VREG-04: `/voice cancel` still works and SAYS what it actually does
 *                (a stateless no-op in this surface), exit 0.
 *  HELL-VREG-05: `/voice status` reports the wire state through the registry
 *                entry (ctx.voice threads into the handler).
 */

import { describe, expect, test } from "bun:test"
import type { AudioRecorderPort } from "@/voice"
import { BUILTINS, runSlashCommand, type SlashContext } from "../../../src/apps/cli/slash-commands"

const buildCtx = (
  voice?: SlashContext["voice"],
): { ctx: SlashContext; out: () => string; err: () => string } => {
  let out = ""
  let err = ""
  return {
    ctx: {
      out: (s) => {
        out += s
      },
      err: (s) => {
        err += s
      },
      cwd: "/tmp",
      ...(voice !== undefined ? { voice } : {}),
    },
    out: () => out,
    err: () => err,
  }
}

/** Recorder fake that TRACKS whether start() was ever invoked. */
const trackingRecorder = (): { recorder: AudioRecorderPort; started: () => boolean } => {
  let started = false
  const recorder: AudioRecorderPort = {
    availability: () => "sox",
    start: async () => {
      started = true
      return {
        ok: true,
        value: {
          backend: "sox",
          format: "wav",
          rate: 16000,
          channels: 1,
          _internal: {
            stopAndDrain: async () => ({ ok: true as const, bytes: new Uint8Array(4) }),
            kill: () => {},
          },
        },
      }
    },
    stop: async () => ({
      ok: true,
      value: { format: "wav", bytes: new Uint8Array(4), rate: 16000, channels: 1 },
    }),
  }
  return { recorder, started: () => started }
}

describe("voice slash register-or-degrade hellgate (D-9)", () => {
  test("HELL-VREG-01: /voice is registered in BUILTINS", () => {
    const names = BUILTINS.map((c) => c.name)
    expect(names).toContain("/voice")
  })

  test("HELL-VREG-02: no voice wire ⇒ exit nonzero + hint line", async () => {
    const h = buildCtx()
    const code = await runSlashCommand("/voice", h.ctx)
    expect(code).not.toBe(0)
    const all = h.out() + h.err()
    expect(all.toLowerCase()).toContain("hint:")
  })

  test("HELL-VREG-03: transcriber missing ⇒ refuses BEFORE capture (no start), exit nonzero + hint", async () => {
    const tracked = trackingRecorder()
    const h = buildCtx({ recorder: tracked.recorder })
    const code = await runSlashCommand("/voice", h.ctx)
    expect(code).not.toBe(0)
    // The capture-then-exit-0 lie (UUX-6-27): audio must NEVER be recorded
    // when it would only be discarded.
    expect(tracked.started()).toBe(false)
    const all = h.out() + h.err()
    expect(all).toContain("transcriber")
    expect(all.toLowerCase()).toContain("hint:")
  })

  test("HELL-VREG-04: /voice cancel still works and says what it actually does (exit 0)", async () => {
    const h = buildCtx()
    const code = await runSlashCommand("/voice cancel", h.ctx)
    expect(code).toBe(0)
    expect(h.out().toLowerCase()).toContain("nothing to cancel")
  })

  test("HELL-VREG-05: /voice status threads the ctx wire into the handler", async () => {
    const tracked = trackingRecorder()
    const h = buildCtx({ recorder: tracked.recorder })
    const code = await runSlashCommand("/voice status", h.ctx)
    expect(code).toBe(0)
    expect(h.out()).toContain("backend=sox")
    expect(h.out()).toContain("transcriber=not wired")
  })
})
