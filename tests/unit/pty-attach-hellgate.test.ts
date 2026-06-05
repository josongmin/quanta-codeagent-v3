/**
 * Hellgate for N6 — PTY/tmux attach tools (RFC §6.1). Drives the 6 tools over a
 * FAKE in-memory `PtySessionPort` (no real tmux/process — deterministic, CI-safe).
 * Pins the resumable-read cursor, resize bounds, write cap, handle jail, cap, and
 * the read-only/exec risk split.
 */

import { describe, expect, test } from "bun:test"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import {
  type AttachResult,
  createTmuxAdapter,
  PTY_MAX_ATTACHED,
  PTY_MAX_WRITE_BYTES,
  type PtyChunk,
  type PtyHandle,
  type PtyHandleInfo,
  type PtyResult,
  type PtySessionPort,
  ptyTools,
  type ReadResult,
  type TmuxExec,
} from "@/tool/pty"

const ctx = (): ToolContext =>
  ({ cwd: "/repo", signal: new AbortController().signal }) as ToolContext

const run = async (tool: Tool, input: unknown): Promise<{ ok: boolean; output: string }> => {
  let last = { ok: false, output: "no result" }
  for await (const ev of tool.execute(input as never, ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = { ok: ev.result.ok, output: ev.result.output }
  }
  return last
}

const ok = <T>(value: T): PtyResult<T> => ({ ok: true, value })
const err = <T>(
  code: PtyResult<T> extends { ok: false; code: infer C } ? C : never,
  message: string,
): PtyResult<T> => ({ ok: false, code, message }) as PtyResult<T>

/** A scripted in-memory backend: a ring of chunks per handle + a foreign jail. */
const mkFake = (
  over: Partial<PtySessionPort> = {},
): {
  port: PtySessionPort
  feed: (handle: PtyHandle, data: string) => void
  resizes: { handle: string; cols: number; rows: number }[]
  writes: { handle: string; data: string }[]
  killed: Set<string>
} => {
  const rings = new Map<PtyHandle, PtyChunk[]>()
  const known = new Set<PtyHandle>(["tmux:quanta-a", "pty:1"])
  const resizes: { handle: string; cols: number; rows: number }[] = []
  const writes: { handle: string; data: string }[] = []
  const killed = new Set<string>()
  let seq = 0
  const feed = (handle: PtyHandle, data: string) => {
    const ring = rings.get(handle) ?? []
    ring.push({ seq: ++seq, data })
    rings.set(handle, ring)
  }
  const base: PtySessionPort = {
    list: async (): Promise<readonly PtyHandleInfo[]> =>
      [...known].map((h) => ({
        handle: h,
        kind: h.startsWith("tmux:") ? "tmux" : "bun",
        owned: h.startsWith("pty:"),
      })),
    attach: async (handle): Promise<PtyResult<AttachResult>> => {
      if (handle.startsWith("tmux:foreign")) return err("foreign-denied", "not allow-listed")
      if (!known.has(handle)) return err("not-found", `no session ${handle}`)
      const ring = rings.get(handle) ?? []
      return ok({ handle, cursor: ring.length === 0 ? 0 : (ring[ring.length - 1] as PtyChunk).seq })
    },
    write: async (handle, data): Promise<PtyResult<void>> => {
      if (!known.has(handle)) return err("not-found", "no session")
      writes.push({ handle, data })
      return ok(undefined)
    },
    read: async (handle, sinceSeq): Promise<PtyResult<ReadResult>> => {
      if (!known.has(handle)) return err("not-found", "no session")
      const ring = rings.get(handle) ?? []
      const chunks = ring.filter((c) => c.seq > sinceSeq)
      const nextSeq = chunks.length > 0 ? (chunks[chunks.length - 1] as PtyChunk).seq : sinceSeq
      return ok({ chunks, nextSeq })
    },
    resize: async (handle, cols, rows): Promise<PtyResult<void>> => {
      if (!known.has(handle)) return err("not-found", "no session")
      resizes.push({ handle, cols, rows })
      return ok(undefined)
    },
    detach: async (): Promise<PtyResult<void>> => ok(undefined),
    kill: async (handle): Promise<PtyResult<void>> => {
      if (!known.has(handle)) return err("not-found", "no session")
      killed.add(handle)
      known.delete(handle)
      return ok(undefined)
    },
    ...over,
  }
  return { port: base, feed, resizes, writes, killed }
}

const byName = (tools: Tool[], name: string): Tool => {
  const t = tools.find((x) => x.name === name)
  if (t === undefined) throw new Error(`missing tool ${name}`)
  return t
}

describe("pty tools — surface + risk split", () => {
  test("exactly the 6 tools, correct read-only/exec split", () => {
    const tools = ptyTools(mkFake().port)
    expect(tools.map((t) => t.name)).toEqual([
      "pty_list",
      "pty_attach",
      "pty_write",
      "pty_read",
      "pty_resize",
      "pty_kill",
    ])
    expect(byName(tools, "pty_list").isReadOnly?.()).toBe(true)
    expect(byName(tools, "pty_read").isReadOnly?.()).toBe(true)
    for (const n of ["pty_attach", "pty_write", "pty_resize", "pty_kill"]) {
      expect(byName(tools, n).isReadOnly?.()).toBe(false)
    }
  })
})

describe("pty tools — resumable read cursor (the last_event_id invariant)", () => {
  test("write A,B,C → read(since 0)=ABC; read(since 2)=C only; no double-emit", async () => {
    const fake = mkFake()
    const tools = ptyTools(fake.port)
    fake.feed("tmux:quanta-a", "A")
    fake.feed("tmux:quanta-a", "B")
    fake.feed("tmux:quanta-a", "C")
    const r0 = await run(byName(tools, "pty_read"), { handle: "tmux:quanta-a", sinceSeq: 0 })
    expect(r0.ok).toBe(true)
    expect(r0.output).toContain("ABC")
    expect(r0.output).toContain("nextSeq=3")
    const r2 = await run(byName(tools, "pty_read"), { handle: "tmux:quanta-a", sinceSeq: 2 })
    expect(r2.output).toContain("C")
    expect(r2.output).not.toContain("AB")
    expect(r2.output).toContain("nextSeq=3")
  })

  test("attach is idempotent — returns the current cursor", async () => {
    const fake = mkFake()
    const tools = ptyTools(fake.port)
    fake.feed("pty:1", "x")
    const a1 = await run(byName(tools, "pty_attach"), { handle: "pty:1" })
    const a2 = await run(byName(tools, "pty_attach"), { handle: "pty:1" })
    expect(a1.ok).toBe(true)
    expect(a2.ok).toBe(true)
    expect(a1.output).toBe(a2.output) // same cursor, no error
  })
})

describe("pty tools — bounds + jail (adversarial)", () => {
  test("resize rejects 0 / negative / absurd; accepts 80x24 with exact dims", async () => {
    const fake = mkFake()
    const tools = ptyTools(fake.port)
    expect(
      (await run(byName(tools, "pty_resize"), { handle: "pty:1", cols: 0, rows: 24 })).ok,
    ).toBe(false)
    expect(
      (await run(byName(tools, "pty_resize"), { handle: "pty:1", cols: -1, rows: 24 })).ok,
    ).toBe(false)
    expect(
      (await run(byName(tools, "pty_resize"), { handle: "pty:1", cols: 99999, rows: 99999 })).ok,
    ).toBe(false)
    const okR = await run(byName(tools, "pty_resize"), { handle: "pty:1", cols: 80, rows: 24 })
    expect(okR.ok).toBe(true)
    expect(fake.resizes).toEqual([{ handle: "pty:1", cols: 80, rows: 24 }])
  })

  test("write cap: 64KiB+1 rejected before reaching the backend", async () => {
    const fake = mkFake()
    const tools = ptyTools(fake.port)
    const huge = "x".repeat(PTY_MAX_WRITE_BYTES + 1)
    const r = await run(byName(tools, "pty_write"), { handle: "pty:1", data: huge })
    expect(r.ok).toBe(false)
    expect(fake.writes.length).toBe(0) // never reached the backend
  })

  test("foreign tmux attach is fail-closed (foreign-denied)", async () => {
    const tools = ptyTools(mkFake().port)
    const r = await run(byName(tools, "pty_attach"), { handle: "tmux:foreign-prod" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("foreign-denied")
  })

  test("a cap-exceeded backend surfaces a rejected result", async () => {
    const tools = ptyTools(
      mkFake({ attach: async () => err("cap-exceeded", `>${PTY_MAX_ATTACHED}`) }).port,
    )
    const r = await run(byName(tools, "pty_attach"), { handle: "pty:1" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("cap-exceeded")
  })

  test("malformed args → typed ok:false, no throw", async () => {
    const tools = ptyTools(mkFake().port)
    expect((await run(byName(tools, "pty_attach"), {})).ok).toBe(false)
    expect((await run(byName(tools, "pty_write"), { handle: "pty:1" })).ok).toBe(false)
    expect((await run(byName(tools, "pty_resize"), { handle: "pty:1", cols: 80 })).ok).toBe(false)
  })

  test("pty_read caps a huge pane (no token explosion) with a truncation marker", async () => {
    const fake = mkFake()
    const tools = ptyTools(fake.port)
    fake.feed("tmux:quanta-a", "S".repeat(200 * 1024)) // a giant scrolled pane
    const r = await run(byName(tools, "pty_read"), { handle: "tmux:quanta-a", sinceSeq: 0 })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("chars truncated")
    // Bounded well under the raw 200 KiB (cap 32 KiB head+tail + markers).
    expect(r.output.length).toBeLessThan(80 * 1024)
  })
})

describe("pty tools — lifecycle", () => {
  test("kill terminates owned handle; list drops it; write/append flows to backend", async () => {
    const fake = mkFake()
    const tools = ptyTools(fake.port)
    const w = await run(byName(tools, "pty_write"), {
      handle: "pty:1",
      data: "ls",
      appendNewline: true,
    })
    expect(w.ok).toBe(true)
    expect(fake.writes).toEqual([{ handle: "pty:1", data: "ls" }])
    const k = await run(byName(tools, "pty_kill"), { handle: "pty:1" })
    expect(k.ok).toBe(true)
    expect(fake.killed.has("pty:1")).toBe(true)
    const list = await run(byName(tools, "pty_list"), {})
    expect(list.output).not.toContain("pty:1")
  })
})

// ── tmux backend (MVP-A) over a FAKE TmuxExec (no real tmux) ───────────────────

const mkTmuxExec = (
  script: (args: readonly string[]) => { ok: boolean; stdout: string } = () => ({
    ok: true,
    stdout: "",
  }),
) => {
  const calls: string[][] = []
  const exec: TmuxExec = {
    run: async (args) => {
      calls.push([...args])
      return script(args)
    },
  }
  return { exec, calls }
}

describe("pty tmux-adapter — allow-prefix jail (security)", () => {
  test("foreign session (outside allow-prefix) → foreign-denied, NO tmux call", async () => {
    const t = mkTmuxExec()
    const adapter = createTmuxAdapter({ exec: t.exec }) // default allowPrefix "quanta-"
    const r = await adapter.attach("tmux:somebody-prod")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("foreign-denied")
    expect(t.calls.length).toBe(0) // fail-closed BEFORE touching tmux
  })

  test("allow-listed session attaches (has-session probed)", async () => {
    const t = mkTmuxExec((a) => ({ ok: a[0] === "has-session", stdout: "" }))
    const adapter = createTmuxAdapter({ exec: t.exec })
    const r = await adapter.attach("tmux:quanta-build")
    expect(r.ok).toBe(true)
    expect(t.calls[0]).toEqual(["has-session", "-t", "quanta-build"])
  })

  test("allowForeign:true routes a foreign session through (host gates HITL)", async () => {
    const t = mkTmuxExec((a) => ({ ok: a[0] === "has-session", stdout: "" }))
    const adapter = createTmuxAdapter({ exec: t.exec, allowForeign: true })
    const r = await adapter.attach("tmux:prod")
    expect(r.ok).toBe(true)
  })
})

describe("pty tmux-adapter — send-keys / resize / capture", () => {
  test("write uses `-l` literal + `--`; appendNewline sends a separate Enter", async () => {
    const t = mkTmuxExec()
    const adapter = createTmuxAdapter({ exec: t.exec })
    await adapter.write("tmux:quanta-a", "rm -rf x", { appendNewline: true })
    expect(t.calls[0]).toEqual(["send-keys", "-t", "quanta-a", "-l", "--", "rm -rf x"])
    expect(t.calls[1]).toEqual(["send-keys", "-t", "quanta-a", "Enter"])
  })

  test("write data beginning with '-' is NOT flag-parsed by tmux (the `--` guard)", async () => {
    const t = mkTmuxExec()
    const adapter = createTmuxAdapter({ exec: t.exec })
    // "-X" would be a tmux flag without the `--` separator → arg-injection.
    await adapter.write("tmux:quanta-a", "-X --kill")
    expect(t.calls[0]).toEqual(["send-keys", "-t", "quanta-a", "-l", "--", "-X --kill"])
    // The data lands AFTER `--`, so tmux treats it as literal keys, not options.
    expect(t.calls[0]?.indexOf("--")).toBeLessThan(t.calls[0]?.indexOf("-X --kill") ?? -1)
  })

  test("resize maps to resize-window -x cols -y rows; bounds rejected pre-exec", async () => {
    const t = mkTmuxExec()
    const adapter = createTmuxAdapter({ exec: t.exec })
    const bad = await adapter.resize("tmux:quanta-a", 0, 40)
    expect(bad.ok).toBe(false)
    expect(t.calls.length).toBe(0)
    await adapter.resize("tmux:quanta-a", 120, 40)
    expect(t.calls[0]).toEqual(["resize-window", "-t", "quanta-a", "-x", "120", "-y", "40"])
  })

  test("read diffs capture-pane snapshots into a monotone seq (tail only)", async () => {
    let pane = "line1\n"
    const t = mkTmuxExec((a) =>
      a[0] === "capture-pane" ? { ok: true, stdout: pane } : { ok: true, stdout: "" },
    )
    const adapter = createTmuxAdapter({ exec: t.exec })
    const r1 = await adapter.read("tmux:quanta-a", 0)
    expect(r1.ok).toBe(true)
    if (r1.ok) {
      expect(r1.value.chunks.map((c) => c.data).join("")).toBe("line1\n")
      expect(r1.value.nextSeq).toBe(1)
    }
    pane = "line1\nline2\n"
    const r2 = await adapter.read("tmux:quanta-a", 1)
    if (r2.ok) {
      expect(r2.value.chunks.map((c) => c.data).join("")).toBe("line2\n") // appended tail only
      expect(r2.value.nextSeq).toBe(2)
    }
    // No new output → no chunk, seq unchanged.
    const r3 = await adapter.read("tmux:quanta-a", 2)
    if (r3.ok) expect(r3.value.chunks.length).toBe(0)
  })
})
