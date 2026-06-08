// Hellgate — [F6] apply_patch MUST declare an interrupt guard + wrap its
// multi-file commit in the optional critical section, at PARITY with edit/write.
//
// The audited defect: `applyPatchTool` declared `isReadOnly` / `isConcurrencySafe`
// / `hitlTier` but — UNLIKE `edit` / `write` (see src/tool/edit/index.ts:449 +
// `commitEdit`) — had NO `interruptBehavior` and NO critical-section around its
// commit, even though it writes MULTIPLE files. An in-flight ESC mid-commit can
// tear a half-applied patch, and the dispatch abort-router (which reads
// `tool.interruptBehavior?.() ?? "cancel"`) had no way to learn that this tool
// needs the abort WITHHELD across its atomic window.
//
// SOTA++ fix (parity with edit/write):
//   1. `applyPatchTool.interruptBehavior() === "block"`.
//   2. `execute()` wraps the `applyPatch` commit in
//      `ctx.criticalSection?.begin()` … `.end()` (in a `finally`), and the
//      withheld abort is re-delivered at `end()` exactly like `commitEdit`.
//   3. Default-OFF / byte-identical: when `ctx.criticalSection` is ABSENT
//      (the seam unwired), `begin?.()` is undefined ⇒ no section is opened and
//      the apply path is unchanged.
//
// The spy proves `begin()` is called BEFORE the first filesystem write the
// patch performs, and `end()` runs in `finally` (even when the apply throws).

import { describe, expect, test } from "bun:test"
import { type CriticalSectionSeam, makeInterruptRouter, type ToolContext, type ToolResult } from "@/tool"
import { applyPatchTool } from "@/tool/apply-patch"

const wrapPatch = (...body: string[]): string =>
  ["*** Begin Patch", ...body, "*** End Patch"].join("\n")

type Ctx = ToolContext & { criticalSection?: CriticalSectionSeam }

const ctx = (over: Partial<Ctx> = {}): Ctx => ({
  cwd: "/jail",
  signal: new AbortController().signal,
  ...over,
})

const run = async (input: unknown, c: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of applyPatchTool.execute(input as never, c)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("[F6] apply_patch interrupt guard + critical-section parity", () => {
  test("declares interruptBehavior() === 'block' (parity with edit/write)", () => {
    expect(applyPatchTool.interruptBehavior).toBeDefined()
    expect(applyPatchTool.interruptBehavior?.()).toBe("block")
  })

  test("the patch write is bracketed by the section: target ABSENT at begin(), PRESENT at end()", async () => {
    // Drive the REAL FsJailFileSystemPort against a temp jail dir so a write
    // actually lands, and probe the target with a real `existsSync` INSIDE
    // begin() and end(). This is the load-bearing ordering proof: the commit is
    // absent when the section opens and present when it closes ⇒ it ran strictly
    // INSIDE the window. (The prior `order.includes("write")` check was vacuous —
    // "write" was never recorded, so it was a constant `false`.)
    const os = await import("node:os")
    const path = await import("node:path")
    const fsp = await import("node:fs/promises")
    const fssync = await import("node:fs")
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "f6-cs-"))
    const target = path.join(dir, "f6-add.txt")
    let beginCalls = 0
    let endCalls = 0
    let existedAtBegin: boolean | undefined
    let existedAtEnd: boolean | undefined
    const c = ctx({
      cwd: dir,
      criticalSection: {
        begin() {
          beginCalls++
          existedAtBegin = fssync.existsSync(target)
          return {
            end() {
              endCalls++
              existedAtEnd = fssync.existsSync(target)
            },
          }
        },
      },
    })
    try {
      const patch = wrapPatch("*** Add File: f6-add.txt", "+hello")
      const res = await run({ patch }, c)
      expect(res.ok).toBe(true)
      expect(beginCalls).toBe(1)
      expect(endCalls).toBe(1)
      // THE TEETH: a regression that wrote BEFORE begin() makes existedAtBegin
      // true; one that wrote AFTER end() makes existedAtEnd false. Both fail.
      expect(existedAtBegin).toBe(false)
      expect(existedAtEnd).toBe(true)
      expect(await fsp.readFile(target, "utf8")).toBe("hello")
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test("end() runs in finally even when the commit THROWS (no leaked open section)", async () => {
    let begun = 0
    let ended = 0
    const c = ctx({
      cwd: "/nonexistent-jail-does-not-exist-xyz",
      criticalSection: {
        begin() {
          begun++
          return {
            end() {
              ended++
            },
          }
        },
      },
    })
    // A patch whose target anchor cannot be found ⇒ applyPatch throws inside the
    // critical section. The section MUST still be ended (finally), and the error
    // must propagate (no silent swallow).
    const patch = wrapPatch(
      "*** Update File: missing.txt",
      "@@",
      " anchor-not-present",
      "-x",
      "+y",
    )
    let threw = false
    try {
      await run({ patch }, c)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(begun).toBe(1)
    // THE TEETH: end() ran in finally despite the throw.
    expect(ended).toBe(1)
  })

  test("default-OFF / byte-identical: absent criticalSection ⇒ apply still succeeds, no section opened", async () => {
    const os = await import("node:os")
    const path = await import("node:path")
    const fsp = await import("node:fs/promises")
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "f6-off-"))
    try {
      const patch = wrapPatch("*** Add File: off.txt", "+content")
      const res = await run({ patch }, ctx({ cwd: dir })) // NO criticalSection
      expect(res.ok).toBe(true)
      const written = await fsp.readFile(path.join(dir, "off.txt"), "utf8")
      expect(written).toBe("content")
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test("withheld abort: the REAL interrupt router DEFERS a mid-commit source abort, delivers it to derived ONLY at end()", async () => {
    // Exercise the GENUINE seam (makeInterruptRouter), not a fake whose end()
    // trivially observes an abort it set itself. The upstream `source` aborts
    // WHILE the section withholds; the derived signal (threaded into ctx.signal)
    // must stay un-aborted across the commit window and fire exactly at end().
    const os = await import("node:os")
    const path = await import("node:path")
    const fsp = await import("node:fs/promises")
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "f6-abort-"))
    const source = new AbortController() // upstream turn signal
    const derived = new AbortController() // suppressible; threaded into ctx.signal
    let honored: "end" | "watchdog" | undefined
    const router = makeInterruptRouter({
      source: source.signal,
      derived,
      now: () => 0,
      maxMs: 1_000_000, // watchdog far away ⇒ end() is the deliverer, never the cap
      scheduler: { schedule: () => () => {} }, // inert timer — cb never fires
      observer: { onHonored: (r) => { honored = r } },
    })
    // Fire the upstream abort INSIDE the open window by wrapping the real seam:
    // begin() opens the withhold window (openDepth→1), then source aborts.
    let derivedAbortedWhileOpen: boolean | undefined
    const seam: CriticalSectionSeam = {
      begin() {
        const handle = router.seam.begin()
        source.abort() // interrupt arrives mid-commit; the window must withhold it
        derivedAbortedWhileOpen = derived.signal.aborted
        return { end: () => handle.end() }
      },
    }
    try {
      const c = ctx({ cwd: dir, signal: derived.signal, criticalSection: seam })
      const patch = wrapPatch("*** Add File: abort.txt", "+x")
      const res = await run({ patch }, c)
      // The commit COMPLETED despite the in-flight abort ("block" deferred it).
      expect(res.ok).toBe(true)
      expect(await fsp.readFile(path.join(dir, "abort.txt"), "utf8")).toBe("x")
      // THE TEETH: withheld for the whole window, then delivered exactly at end().
      expect(derivedAbortedWhileOpen).toBe(false)
      expect(derived.signal.aborted).toBe(true)
      expect(honored).toBe("end")
    } finally {
      router.dispose()
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
})
