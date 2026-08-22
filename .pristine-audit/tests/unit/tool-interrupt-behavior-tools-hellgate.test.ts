/**
 * jun-6 tool-interrupt-behavior — HELLGATE proving the HEADLINE value on the
 * REAL `write` / `edit` tools (RFC §6.2, §6.5): a `block` tool's atomic FS-write
 * window withholds an in-flight ESC so the file is NEVER half-applied, while the
 * legacy `cancel` path CAN tear mid-write (documenting the feature's worth).
 *
 * The harness mirrors how the `@/agent` composition root will wire a `"block"`
 * tool (the dispatch hot-path the parent integrates): construct the
 * interrupt-router over a derived controller, thread `derived.signal` into
 * `ctx.signal` and `router.seam` into `ctx.criticalSection`. A `cancel`-policy
 * run threads the raw signal and NO seam (today's behavior).
 *
 * The fake FileSystemPort's `writeFile` is "tearing": it checks the signal
 * mid-write and, if aborted, writes only a TRUNCATED prefix (the half-apply
 * hazard). With the critical section the abort is withheld so the write lands
 * whole; without it the write tears — the differential is the proof.
 */
import { describe, expect, test } from "bun:test"
import type { FileSystemPort } from "@/storage"
import { type CriticalSectionScheduler, makeInterruptRouter, type ToolContext } from "@/tool"
import { makeEditTool } from "@/tool/edit"
import { makeWriteTool } from "@/tool/write"

const makeFakeTime = () => {
  let nowMs = 0
  let seq = 0
  const timers = new Map<number, { at: number; cb: () => void }>()
  const scheduler: CriticalSectionScheduler = {
    schedule(ms, cb) {
      const id = seq++
      timers.set(id, { at: nowMs + ms, cb })
      return () => {
        timers.delete(id)
      }
    },
  }
  return {
    now: () => nowMs,
    scheduler,
    advance(ms: number) {
      nowMs += ms
      for (const [id, t] of [...timers.entries()].filter(([, x]) => x.at <= nowMs)) {
        timers.delete(id)
        t.cb()
      }
    },
  }
}

/** In-memory FS whose `writeFile` models the half-apply hazard: `onCommit` runs
 *  AT the commit point (the moment the ESC realistically lands INSIDE the
 *  FS-write window) — tests fire the upstream abort there. Then, if `signal()`
 *  observes an abort, it stores only the leading half of the bytes (a truncated
 *  file); otherwise it stores the whole content. With the critical section the
 *  abort is withheld so `signal().aborted` is still false ⇒ whole write. */
const makeTearingFs = (
  signal: () => AbortSignal,
  opts?: { seed?: Record<string, string>; onCommit?: () => void },
): FileSystemPort => {
  const store = new Map<string, string>(Object.entries(opts?.seed ?? {}))
  return {
    async readFile(path) {
      const v = store.get(path)
      if (v === undefined) throw new Error(`ENOENT ${path}`)
      return v
    },
    async writeFile(path, content) {
      opts?.onCommit?.() // the ESC lands here, inside the FS-write window
      if (signal().aborted) {
        // half-apply hazard: only the leading half lands on disk
        store.set(path, content.slice(0, Math.floor(content.length / 2)))
        return
      }
      store.set(path, content)
    },
    async statFile(path) {
      return { path, mtimeMs: 1, size: store.get(path)?.length ?? 0 } as never
    },
    async fileExists(path) {
      return store.has(path)
    },
    _store: store,
  } as FileSystemPort & { _store: Map<string, string> }
}

const MAX_MS = 50

/** Build a `block` ctx mirroring the dispatch root: derived signal + seam. */
const blockCtx = (source: AbortController) => {
  const time = makeFakeTime()
  const derived = new AbortController()
  const router = makeInterruptRouter({
    source: source.signal,
    derived,
    now: time.now,
    maxMs: MAX_MS,
    scheduler: time.scheduler,
  })
  const ctx: ToolContext = {
    cwd: "/work",
    signal: derived.signal,
    criticalSection: router.seam,
  }
  return { ctx, router, time, derivedSignal: () => derived.signal }
}

/** Build a `cancel` ctx (today's path): raw signal, NO seam. */
const cancelCtx = (source: AbortController): { ctx: ToolContext } => ({
  ctx: { cwd: "/work", signal: source.signal },
})

const drain = async (it: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of it) {
    /* exhaust */
  }
}

describe("write: block withholds the ESC across the atomic write (no half-apply)", () => {
  test("§6.5 abort fires INSIDE the write window; the critical section makes the write WHOLE", async () => {
    const source = new AbortController()
    const { ctx, router, derivedSignal } = blockCtx(source)
    const fs = makeTearingFs(derivedSignal, {
      onCommit: () => source.abort(new Error("esc")), // ESC lands mid-write
    }) as FileSystemPort & { _store: Map<string, string> }
    const tool = makeWriteTool(fs)
    await drain(tool.execute({ path: "/work/a.txt", content: "FULL-CONTENT-1234567890" }, ctx))
    // File landed WHOLE despite the in-flight abort (withheld across the section).
    expect(fs._store.get("/work/a.txt")).toBe("FULL-CONTENT-1234567890")
    // The turn STILL aborts: the withheld abort was re-delivered at end().
    expect(derivedSignal().aborted).toBe(true)
    router.dispose()
  })

  test("§6.5 DIFFERENTIAL — the legacy cancel path CAN tear the same write", async () => {
    const source = new AbortController()
    const { ctx } = cancelCtx(source)
    const fs = makeTearingFs(() => source.signal, {
      onCommit: () => source.abort(new Error("esc")),
    }) as FileSystemPort & { _store: Map<string, string> }
    const tool = makeWriteTool(fs)
    await drain(tool.execute({ path: "/work/a.txt", content: "FULL-CONTENT-1234567890" }, ctx))
    // No section ⇒ the abort tore the write: only the leading half landed.
    expect(fs._store.get("/work/a.txt")).toBe("FULL-CONTENT-1234567890".slice(0, 11))
  })

  test("declares interruptBehavior() === 'block'", () => {
    const tool = makeWriteTool(makeTearingFs(() => new AbortController().signal))
    expect(tool.interruptBehavior?.()).toBe("block")
  })

  test("seam ABSENT (unwired host) ⇒ byte-identical: write tears under abort", async () => {
    const source = new AbortController()
    // block tool, but NO criticalSection on ctx (host did not wire it)
    const ctx: ToolContext = { cwd: "/work", signal: source.signal }
    const fs = makeTearingFs(() => source.signal, {
      onCommit: () => source.abort(new Error("esc")),
    }) as FileSystemPort & { _store: Map<string, string> }
    const tool = makeWriteTool(fs)
    await drain(tool.execute({ path: "/work/a.txt", content: "FULL-CONTENT-1234567890" }, ctx))
    expect(fs._store.get("/work/a.txt")).toBe("FULL-CONTENT-1234567890".slice(0, 11))
  })
})

describe("edit: block withholds the ESC across the atomic commit (no half-apply)", () => {
  test("§6.5 abort INSIDE the commit window; the section makes the edit WHOLE", async () => {
    const source = new AbortController()
    const { ctx, router, derivedSignal } = blockCtx(source)
    const fs = makeTearingFs(derivedSignal, {
      seed: { "/work/b.txt": "alpha OLD omega-padding-to-length" },
      onCommit: () => source.abort(new Error("esc")),
    }) as FileSystemPort & { _store: Map<string, string> }
    const tool = makeEditTool(fs)
    await drain(
      tool.execute({ path: "/work/b.txt", old_string: "OLD", new_string: "NEWVALUE" }, ctx),
    )
    expect(fs._store.get("/work/b.txt")).toBe("alpha NEWVALUE omega-padding-to-length")
    expect(derivedSignal().aborted).toBe(true)
    router.dispose()
  })

  test("§6.5 DIFFERENTIAL — legacy cancel path CAN tear the commit", async () => {
    const source = new AbortController()
    const { ctx } = cancelCtx(source)
    const whole = "alpha NEWVALUE omega-padding-to-length"
    const fs = makeTearingFs(() => source.signal, {
      seed: { "/work/b.txt": "alpha OLD omega-padding-to-length" },
      onCommit: () => source.abort(new Error("esc")),
    }) as FileSystemPort & { _store: Map<string, string> }
    const tool = makeEditTool(fs)
    await drain(
      tool.execute({ path: "/work/b.txt", old_string: "OLD", new_string: "NEWVALUE" }, ctx),
    )
    expect(fs._store.get("/work/b.txt")).toBe(whole.slice(0, Math.floor(whole.length / 2)))
  })

  test("declares interruptBehavior() === 'block'", () => {
    const tool = makeEditTool(makeTearingFs(() => new AbortController().signal))
    expect(tool.interruptBehavior?.()).toBe("block")
  })
})

describe("clean (no-abort) runs are byte-identical with the seam wired", () => {
  test("write with seam but no abort ⇒ whole file, no error", async () => {
    const source = new AbortController()
    const { ctx, router, derivedSignal } = blockCtx(source)
    const fs = makeTearingFs(derivedSignal) as FileSystemPort & { _store: Map<string, string> }
    const tool = makeWriteTool(fs)
    await drain(tool.execute({ path: "/work/c.txt", content: "clean-write" }, ctx))
    expect(fs._store.get("/work/c.txt")).toBe("clean-write")
    expect(derivedSignal().aborted).toBe(false)
    router.dispose()
  })
})
