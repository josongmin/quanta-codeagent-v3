/**
 * Hellgate for N6 Phase-1b — the Bun-native (owned) PTY backend
 * (RFC `docs/plans/jun-6-pty-bun-native-backend.md` §6.1).
 *
 * Drives `createBunPtyAdapter` over a SCRIPTED in-memory `PtyFactoryPort` (no
 * real process / no `Bun.Terminal` / no `Bun.spawn`) so every case is
 * deterministic + CI-safe. Pins the owned-handle shape, resumable read through
 * the ring (monotone seq), resize bounds, write cap, cwd-jail at spawn, owned
 * kill/detach semantics, the ring bound + gap signal, the structural absence of
 * the foreign-denied gate, and the NO-THROW boundary (a throwing factory ⇒ a
 * typed result, never an exception).
 */

import { describe, expect, test } from "bun:test"
import {
  type BunPtyAdapter,
  createBunPtyAdapter,
  PTY_MAX_WRITE_BYTES,
  PTY_RING_BYTES,
  type PtyChildHandle,
  type PtyFactoryPort,
  type PtyTerminalHandle,
} from "@/tool/pty"

/* ─────────────────────────── scripted fake factory ─────────────────────────── */

interface FakeCtl {
  factory: PtyFactoryPort
  /** Drive child output (string ⇒ UTF-8 bytes) for the latest terminal. */
  emit: (text: string) => void
  /** Drive RAW child output bytes (to test split multi-byte sequences). */
  emitRaw: (bytes: Uint8Array) => void
  /** Fire the exit callback for the most-recently-opened terminal. */
  exit: (code: number) => void
  writes: string[]
  resizes: { cols: number; rows: number }[]
  rawModes: boolean[]
  spawned: { argv: readonly string[]; cwd: string; env: Readonly<Record<string, string>> }[]
  killed: number
  closed: number
}

const mkFake = (
  over: Partial<{
    jail: (cwd: string) => ReturnType<PtyFactoryPort["jailCwd"]>
    openThrows: boolean
    spawnThrows: boolean
    writeThrows: boolean
  }> = {},
): FakeCtl => {
  const writes: string[] = []
  const resizes: { cols: number; rows: number }[] = []
  const rawModes: boolean[] = []
  const spawned: FakeCtl["spawned"] = []
  let onData: ((b: Uint8Array) => void) | undefined
  let onExit: ((c: number) => void) | undefined
  const enc = new TextEncoder()
  const ctl: FakeCtl = {
    emit: (t) => onData?.(enc.encode(t)),
    emitRaw: (b) => onData?.(b),
    exit: (c) => onExit?.(c),
    writes,
    resizes,
    rawModes,
    spawned,
    killed: 0,
    closed: 0,
    factory: undefined as unknown as PtyFactoryPort,
  }
  const factory: PtyFactoryPort = {
    open(opts): PtyTerminalHandle {
      if (over.openThrows === true) throw new Error("open boom")
      onData = opts.onData
      onExit = opts.onExit
      return {
        write(d): number {
          if (over.writeThrows === true) throw new Error("write boom")
          writes.push(d)
          return d.length
        },
        resize(cols, rows): void {
          resizes.push({ cols, rows })
        },
        setRawMode(b): void {
          rawModes.push(b)
        },
        close(): void {
          ctl.closed++
        },
      }
    },
    spawn(argv, cwd, env): PtyChildHandle {
      if (over.spawnThrows === true) throw new Error("spawn boom")
      spawned.push({ argv, cwd, env })
      return {
        pid: 4242,
        kill(): void {
          ctl.killed++
        },
      }
    },
    jailCwd(cwd) {
      if (over.jail !== undefined) return over.jail(cwd)
      return { ok: true, cwd }
    },
  }
  ctl.factory = factory
  return ctl
}

const spawnOk = async (
  a: BunPtyAdapter,
  cwd = "/repo/work",
): Promise<{ handle: string; cursor: number }> => {
  const r = await a.spawn(["bash"], { cwd })
  if (!r.ok) throw new Error(`spawn unexpectedly failed: ${r.code}`)
  return r.value
}

/* ─────────────────────────────────── tests ─────────────────────────────────── */

describe("spawn-owned ⇒ handle + cursor + list entry", () => {
  test("a spawned handle is pty:<seq>, owned:true, kind:bun, cursor 0", async () => {
    const f = mkFake()
    const a = createBunPtyAdapter(f.factory)
    const { handle, cursor } = await spawnOk(a)
    expect(handle).toMatch(/^pty:\d+$/)
    expect(cursor).toBe(0)
    const list = await a.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ handle, kind: "bun", owned: true, cwd: "/repo/work" })
    // The child was spawned with the jailed cwd + our argv.
    expect(f.spawned).toHaveLength(1)
    expect(f.spawned[0]?.argv).toEqual(["bash"])
    expect(f.spawned[0]?.cwd).toBe("/repo/work")
  })

  test("handles are never reused — a fresh spawn after kill gets a new seq", async () => {
    const f = mkFake()
    const a = createBunPtyAdapter(f.factory)
    const first = await spawnOk(a)
    await a.kill(first.handle)
    const second = await spawnOk(a)
    expect(second.handle).not.toBe(first.handle)
    // The killed handle is now not-found.
    const re = await a.attach(first.handle)
    expect(re.ok).toBe(false)
  })
})

describe("write/read round-trip through the ring (monotone seq)", () => {
  test("scripted data A,B,C ⇒ read(since:0) returns ABC with nextSeq 3", async () => {
    const f = mkFake()
    const a = createBunPtyAdapter(f.factory)
    const { handle } = await spawnOk(a)
    f.emit("A")
    f.emit("B")
    f.emit("C")
    const r = await a.read(handle, 0)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.chunks.map((c) => c.data)).toEqual(["A", "B", "C"])
    expect(r.value.chunks.map((c) => c.seq)).toEqual([1, 2, 3])
    expect(r.value.nextSeq).toBe(3)
  })

  test("resumable: read(since:2) returns only C, no double-emit", async () => {
    const f = mkFake()
    const a = createBunPtyAdapter(f.factory)
    const { handle } = await spawnOk(a)
    f.emit("A")
    f.emit("B")
    f.emit("C")
    const r = await a.read(handle, 2)
    if (!r.ok) throw new Error("read failed")
    expect(r.value.chunks).toHaveLength(1)
    expect(r.value.chunks[0]?.data).toBe("C")
    expect(r.value.chunks[0]?.seq).toBe(3)
    expect(r.value.nextSeq).toBe(3)
  })

  test("read up-to-date ⇒ no chunks, cursor preserved", async () => {
    const f = mkFake()
    const a = createBunPtyAdapter(f.factory)
    const { handle } = await spawnOk(a)
    f.emit("A")
    const r = await a.read(handle, 1)
    if (!r.ok) throw new Error("read failed")
    expect(r.value.chunks).toHaveLength(0)
    expect(r.value.nextSeq).toBe(1)
  })

  test("write goes to the terminal; appendNewline appends exactly one \\n", async () => {
    const f = mkFake()
    const a = createBunPtyAdapter(f.factory)
    const { handle } = await spawnOk(a)
    expect((await a.write(handle, "ls")).ok).toBe(true)
    expect((await a.write(handle, "ls", { appendNewline: true })).ok).toBe(true)
    expect(f.writes).toEqual(["ls", "ls\n"])
  })

  test("multi-byte UTF-8 split across two data callbacks is decoded losslessly", async () => {
    const f = mkFake()
    const a = createBunPtyAdapter(f.factory)
    const { handle } = await spawnOk(a)
    // 😀 = F0 9F 98 80; split the 4 bytes across two raw onData callbacks. A naive
    // per-callback `TextDecoder.decode` would corrupt the straddling code point
    // into U+FFFD; the streaming decoder must reassemble it.
    const all = new TextEncoder().encode("😀")
    f.emitRaw(all.slice(0, 2))
    f.emitRaw(all.slice(2))
    const r = await a.read(handle, 0)
    if (!r.ok) throw new Error("read failed")
    expect(r.value.chunks.map((c) => c.data).join("")).toBe("😀")
  })
})

describe("resize bounds (Bun resize(cols,rows) order)", () => {
  test("(0,0) / (-1,40) / (99999,99999) ⇒ invalid-size; (80,24) ⇒ ok, exact order recorded", async () => {
    const f = mkFake()
    const a = createBunPtyAdapter(f.factory)
    const { handle } = await spawnOk(a)
    for (const [c, r] of [
      [0, 0],
      [-1, 40],
      [99999, 99999],
    ] as const) {
      const res = await a.resize(handle, c, r)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe("invalid-size")
    }
    const okRes = await a.resize(handle, 80, 24)
    expect(okRes.ok).toBe(true)
    expect(f.resizes).toEqual([{ cols: 80, rows: 24 }])
  })
})

describe("write cap (matches the tmux adapter / write_stdin discipline)", () => {
  test("64 KiB + 1 ⇒ too-large; exactly 64 KiB ⇒ ok", async () => {
    const f = mkFake()
    const a = createBunPtyAdapter(f.factory)
    const { handle } = await spawnOk(a)
    const over = "x".repeat(PTY_MAX_WRITE_BYTES + 1)
    const r1 = await a.write(handle, over)
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.code).toBe("too-large")
    const at = "x".repeat(PTY_MAX_WRITE_BYTES)
    expect((await a.write(handle, at)).ok).toBe(true)
  })

  test("appendNewline counts toward the cap (64 KiB + the \\n ⇒ too-large)", async () => {
    const f = mkFake()
    const a = createBunPtyAdapter(f.factory)
    const { handle } = await spawnOk(a)
    const at = "x".repeat(PTY_MAX_WRITE_BYTES)
    const r = await a.write(handle, at, { appendNewline: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("too-large")
  })
})

describe("cwd-jail at spawn (can't escape) — the ONLY trust boundary", () => {
  test("a cwd the jail rejects ⇒ foreign-denied, no child spawned", async () => {
    const f = mkFake({
      jail: (cwd) =>
        cwd.includes("..") || cwd.startsWith("/etc")
          ? { ok: false, reason: "escapes workspace" }
          : { ok: true, cwd },
    })
    const a = createBunPtyAdapter(f.factory)
    const r = await a.spawn(["cat", "/etc/passwd"], { cwd: "/repo/../etc" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("foreign-denied")
    expect(f.spawned).toHaveLength(0)
    expect(await a.list()).toHaveLength(0)
  })

  test("the jail's NORMALIZED cwd is what the child is spawned under", async () => {
    const f = mkFake({ jail: () => ({ ok: true, cwd: "/repo/canonical" }) })
    const a = createBunPtyAdapter(f.factory)
    await spawnOk(a, "/repo/./sub/../")
    expect(f.spawned[0]?.cwd).toBe("/repo/canonical")
  })
})

describe("kill / detach ownership (owned ⇒ no allow-list)", () => {
  test("detach leaves the child alive + list-visible; read still resumes", async () => {
    const f = mkFake()
    const a = createBunPtyAdapter(f.factory)
    const { handle } = await spawnOk(a)
    f.emit("hi")
    expect((await a.detach(handle)).ok).toBe(true)
    expect(f.killed).toBe(0)
    expect(await a.list()).toHaveLength(1)
    const r = await a.read(handle, 0)
    if (!r.ok) throw new Error("read failed")
    expect(r.value.chunks[0]?.data).toBe("hi")
  })

  test("kill reaps the child + closes the terminal + drops the handle", async () => {
    const f = mkFake()
    const a = createBunPtyAdapter(f.factory)
    const { handle } = await spawnOk(a)
    expect((await a.kill(handle)).ok).toBe(true)
    expect(f.killed).toBe(1)
    expect(f.closed).toBe(1)
    expect(await a.list()).toHaveLength(0)
    // post-kill ops are not-found, never a throw.
    expect((await a.write(handle, "x")).ok).toBe(false)
    expect((await a.read(handle, 0)).ok).toBe(false)
  })

  test("closeAll reaps every owned child; idempotent (call twice ⇒ 0 live)", async () => {
    const f = mkFake()
    const a = createBunPtyAdapter(f.factory)
    await spawnOk(a)
    await spawnOk(a)
    await a.closeAll()
    expect(f.killed).toBe(2)
    expect(await a.list()).toHaveLength(0)
    await a.closeAll() // idempotent
    expect(f.killed).toBe(2)
  })
})

describe("NO foreign gate — owned posture is structurally distinct from tmux", () => {
  test("the adapter never emits foreign-denied for a legitimately-jailed pty op", async () => {
    const f = mkFake()
    const a = createBunPtyAdapter(f.factory)
    const { handle } = await spawnOk(a)
    // None of the port ops carries a foreign-denied path for an owned handle.
    for (const r of [
      await a.attach(handle),
      await a.write(handle, "x"),
      await a.read(handle, 0),
      await a.resize(handle, 80, 24),
      await a.detach(handle),
    ]) {
      if (!r.ok) expect(r.code).not.toBe("foreign-denied")
    }
  })

  test("unknown pty:<seq> ⇒ not-found (NOT foreign-denied)", async () => {
    const f = mkFake()
    const a = createBunPtyAdapter(f.factory)
    const r = await a.attach("pty:999")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("not-found")
  })
})

describe("ring bound + gap signal (no unbounded growth, no silent drop)", () => {
  test("flooding >256 KiB while nobody reads keeps the ring bounded", async () => {
    const f = mkFake()
    const a = createBunPtyAdapter(f.factory)
    const { handle } = await spawnOk(a)
    // 40 chunks of 16 KiB = 640 KiB total, far over PTY_RING_BYTES.
    for (let i = 0; i < 40; i++) f.emit("y".repeat(16 * 1024))
    const r = await a.read(handle, 0)
    if (!r.ok) throw new Error("read failed")
    const retained = r.value.chunks.reduce((n, c) => n + c.data.length, 0)
    expect(retained).toBeLessThanOrEqual(PTY_RING_BYTES + 16 * 1024)
  })

  test("a read whose cursor was evicted reports a gap marker (not silent)", async () => {
    const f = mkFake()
    const a = createBunPtyAdapter(f.factory)
    const { handle } = await spawnOk(a)
    for (let i = 0; i < 40; i++) f.emit("z".repeat(16 * 1024))
    // The earliest seqs were evicted; reading from seq 0 must SIGNAL the gap.
    const r = await a.read(handle, 0)
    if (!r.ok) throw new Error("read failed")
    expect(r.value.chunks[0]?.data ?? "").toContain("dropped")
  })

  test("a single chunk ALONE over the budget is tail-trimmed (one flood can't blow the bound)", async () => {
    const f = mkFake()
    const a = createBunPtyAdapter(f.factory)
    const { handle } = await spawnOk(a)
    f.emit("q".repeat(PTY_RING_BYTES * 2))
    const r = await a.read(handle, 0)
    if (!r.ok) throw new Error("read failed")
    const retained = r.value.chunks.reduce((n, c) => n + c.data.length, 0)
    expect(retained).toBeLessThanOrEqual(PTY_RING_BYTES)
  })
})

describe("NO-THROW boundary — a throwing factory ⇒ a typed result", () => {
  test("factory.open throws ⇒ backend-error, no exception", async () => {
    const f = mkFake({ openThrows: true })
    const a = createBunPtyAdapter(f.factory)
    const r = await a.spawn(["bash"], { cwd: "/repo" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("backend-error")
  })

  test("factory.spawn throws ⇒ backend-error", async () => {
    const f = mkFake({ spawnThrows: true })
    const a = createBunPtyAdapter(f.factory)
    const r = await a.spawn(["bash"], { cwd: "/repo" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("backend-error")
  })

  test("terminal.write throws ⇒ backend-error (never propagates)", async () => {
    const f = mkFake({ writeThrows: true })
    const a = createBunPtyAdapter(f.factory)
    const { handle } = await spawnOk(a)
    const r = await a.write(handle, "x")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("backend-error")
  })
})
