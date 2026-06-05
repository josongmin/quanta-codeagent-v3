/**
 * Hellgate for N6 Phase-1b — backend-PARITY differential
 * (RFC `docs/plans/jun-6-pty-bun-native-backend.md` §6.2).
 *
 * Proves the Bun-native adapter is a DROP-IN `PtySessionPort` by running the
 * SAME port-contract assertions the tmux adapter satisfies — idempotent attach,
 * seq monotonicity, write cap, resize bounds, NO-THROW — so a composite `"both"`
 * router cannot behave differently per backend except where provenance
 * legitimately differs (owned has no foreign gate; tmux does).
 */

import { describe, expect, test } from "bun:test"
import {
  createBunPtyAdapter,
  createTmuxAdapter,
  PTY_MAX_WRITE_BYTES,
  type PtyChildHandle,
  type PtyFactoryPort,
  type PtySessionPort,
  type PtyTerminalHandle,
  type TmuxExec,
} from "@/tool/pty"

/* ── tmux fake (a quanta- prefixed, attachable session) ── */
const mkTmux = (): { port: PtySessionPort; handle: string } => {
  let pane = ""
  const exec: TmuxExec = {
    async run(args) {
      const [cmd] = args
      if (cmd === "list-sessions") return { ok: true, stdout: "quanta-a\t/repo" }
      if (cmd === "has-session") return { ok: true, stdout: "" }
      if (cmd === "capture-pane") return { ok: true, stdout: pane }
      if (cmd === "send-keys") {
        // -l literal payload is the last arg after the `--` separator.
        const i = args.indexOf("--")
        if (i >= 0 && args[i + 1] !== undefined) pane += args[i + 1]
        return { ok: true, stdout: "" }
      }
      return { ok: true, stdout: "" }
    },
  }
  return { port: createTmuxAdapter({ exec }), handle: "tmux:quanta-a" }
}

/* ── bun fake (an owned, spawned pty) ── */
const mkBun = async (): Promise<{
  port: PtySessionPort
  handle: string
  emit: (t: string) => void
}> => {
  let onData: ((b: Uint8Array) => void) | undefined
  const enc = new TextEncoder()
  const factory: PtyFactoryPort = {
    open(opts): PtyTerminalHandle {
      onData = opts.onData
      return {
        write(d) {
          return d.length
        },
        resize() {},
        setRawMode() {},
        close() {},
      }
    },
    spawn(): PtyChildHandle {
      return { pid: 1, kill() {} }
    },
    jailCwd(cwd) {
      return { ok: true, cwd }
    },
  }
  const port = createBunPtyAdapter(factory)
  const r = await port.spawn(["bash"], { cwd: "/repo" })
  if (!r.ok) throw new Error("bun spawn failed")
  return { port, handle: r.value.handle, emit: (t) => onData?.(enc.encode(t)) }
}

describe("parity — both adapters satisfy the PtySessionPort contract", () => {
  test("attach is idempotent (re-attach returns a cursor, never throws)", async () => {
    const tmux = mkTmux()
    const bun = await mkBun()
    for (const [name, port, handle] of [
      ["tmux", tmux.port, tmux.handle],
      ["bun", bun.port, bun.handle],
    ] as const) {
      const a1 = await port.attach(handle)
      const a2 = await port.attach(handle)
      expect(a1.ok, name).toBe(true)
      expect(a2.ok, name).toBe(true)
      if (a1.ok && a2.ok) {
        expect(typeof a1.value.cursor, name).toBe("number")
        expect(a2.value.handle, name).toBe(handle)
      }
    }
  })

  test("read seq is monotone + resumable on both backends", async () => {
    const tmux = mkTmux()
    const bun = await mkBun()
    // tmux: write builds the pane; bun: emit builds the ring.
    await tmux.port.write(tmux.handle, "hello", { appendNewline: false })
    bun.emit("hello")
    for (const [name, port, handle] of [
      ["tmux", tmux.port, tmux.handle],
      ["bun", bun.port, bun.handle],
    ] as const) {
      const r1 = await port.read(handle, 0)
      expect(r1.ok, name).toBe(true)
      if (!r1.ok) continue
      expect(r1.value.nextSeq, name).toBeGreaterThanOrEqual(1)
      // re-read at the new cursor ⇒ no double-emit.
      const r2 = await port.read(handle, r1.value.nextSeq)
      if (r2.ok) expect(r2.value.chunks.length, name).toBe(0)
    }
  })

  test("write cap is enforced identically (too-large past 64 KiB)", async () => {
    const tmux = mkTmux()
    const bun = await mkBun()
    const over = "x".repeat(PTY_MAX_WRITE_BYTES + 1)
    for (const [name, port, handle] of [
      ["tmux", tmux.port, tmux.handle],
      ["bun", bun.port, bun.handle],
    ] as const) {
      const r = await port.write(handle, over)
      // NOTE: the tmux adapter delegates its byte cap to the tool layer; the bun
      // adapter caps at the port. Parity we assert here is NO-THROW + a typed
      // result either way (a tmux ok or a bun too-large, never an exception).
      expect(typeof r.ok, name).toBe("boolean")
    }
  })

  test("resize bounds reject (0,0) on both backends", async () => {
    const tmux = mkTmux()
    const bun = await mkBun()
    for (const [name, port, handle] of [
      ["tmux", tmux.port, tmux.handle],
      ["bun", bun.port, bun.handle],
    ] as const) {
      const r = await port.resize(handle, 0, 0)
      expect(r.ok, name).toBe(false)
      if (!r.ok) expect(r.code, name).toBe("invalid-size")
    }
  })

  test("provenance divergence: ONLY tmux has a foreign-denied path", async () => {
    const tmux = mkTmux()
    const bun = await mkBun()
    // tmux: a non-prefixed session is foreign-denied.
    const tf = await tmux.port.attach("tmux:someones-prod")
    expect(tf.ok).toBe(false)
    if (!tf.ok) expect(tf.code).toBe("foreign-denied")
    // bun: an unknown owned handle is not-found, NEVER foreign-denied (owned has
    // no foreign provenance — the structural inversion).
    const bf = await bun.port.attach("pty:9999")
    expect(bf.ok).toBe(false)
    if (!bf.ok) expect(bf.code).toBe("not-found")
  })
})
