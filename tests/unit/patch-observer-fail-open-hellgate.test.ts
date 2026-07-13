/**
 * HELLGATE — `patch-observer-fail-open` (L4) CRITICAL fail-open contract.
 *
 * The V4A applier forwards each per-op {@link PatchObservation} to TWO
 * INDEPENDENT telemetry sinks — an optional in-process `PatchObserver` and an
 * optional injected `PatchTracePort` (the OTel binding the `apply_patch`
 * composition root wires). The load-bearing invariant (`src/patch/applier.ts`
 * → `wrapObserver`, the two try/catch blocks at the `observer(event)` /
 * `trace.recordPatchOp(event)` calls) is:
 *
 *   A telemetry bug — a THROW from EITHER sink — MUST NOT abort the apply.
 *   The patch still commits (disk is mutated) and the call still returns its
 *   normal success `ApplyResult`. The two sinks are wrapped in SEPARATE
 *   try/catch blocks, so a throw from one does not even stop the OTHER's emit.
 *
 * The sibling hellgate (`patch-v4a-otel-emit-hellgate.test.ts`) proves emission
 * CORRECTNESS + no-leak + absent-sink zero-emit, but it never injects a
 * *throwing* sink, so the fail-open catch blocks were UNTESTED. This file closes
 * that gap.
 *
 * Why the direct `applyPatch(...)` seam (not only `applyPatchTool.execute`):
 * the `wrapObserver` `observer`/`trace` catches are the SSOT of the fail-open
 * contract, and they take injected ports. The tool hard-wires `observer =
 * undefined` and routes the trace port through `recordAttrs`, which has its OWN
 * swallow — so a throwing *span sink* driven through the tool is masked BEFORE
 * `wrapObserver` and cannot exercise (or fail) its catches. To prove — and to
 * be able to RED via in-tree rethrow of — the `wrapObserver` contract, we inject
 * throwing ports directly. A final case ALSO drives the full composition root
 * (`applyPatchTool.execute` + a throwing `setSpanSink`) to prove the end-to-end
 * apply still fails-open through the real wiring.
 *
 * Anti-vacuous: a NON-throwing paired control proves the events are actually
 * DELIVERED on the happy path (the sinks are wired, not dead), so the throwing
 * cases are exercising a live seam rather than a no-op.
 *
 * Source under test: src/patch/applier.ts (`wrapObserver`) + the
 * `apply_patch` composition root in src/tool/apply-patch.ts.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyPatch,
  parsePatch,
  type PatchObservation,
  type PatchObserver,
  type PatchTracePort,
} from "@/patch"
import { __resetSpanSink, setSpanSink } from "@/observability"
import { applyPatchTool, FsJailFileSystemPort } from "@/tool/apply-patch"
import type { ToolContext } from "@/tool/types"

const makeJailRoot = (): string =>
  mkdtempSync(join(tmpdir(), "patch-fail-open-hellgate-"))

/** An `update` patch that turns `alpha\nbeta\ngamma\n` into `alpha\nBETA\ngamma\n`.
 *  Update ops emit per-hunk tier events AND an op event, so both sink branches
 *  fire more than once — a throw on the FIRST call must not stop the commit. */
const UPDATE_PATCH = [
  "*** Begin Patch",
  "*** Update File: edit.dat",
  "@@",
  " alpha",
  "-beta",
  "+BETA",
  " gamma",
  "*** End Patch",
  "",
].join("\n")

const SEED = "alpha\nbeta\ngamma\n"
const EXPECTED = "alpha\nBETA\ngamma\n"

/** Observer that throws on EVERY event. */
const throwingObserver: PatchObserver = () => {
  throw new Error("observer boom — telemetry bug that must NOT abort apply")
}

/** Trace port that throws on EVERY recorded op. */
const throwingTrace: PatchTracePort = {
  recordPatchOp() {
    throw new Error("trace boom — telemetry bug that must NOT abort apply")
  },
}

describe("patch-observer-fail-open — throwing telemetry sinks never abort apply (disk mutates + success)", () => {
  test("observer THROWS on every event ⇒ apply still commits (disk mutated) + returns success", async () => {
    const jail = makeJailRoot()
    try {
      writeFileSync(join(jail, "edit.dat"), SEED)
      const port = new FsJailFileSystemPort({ jailRoot: jail })
      const patch = parsePatch(UPDATE_PATCH)

      // Throwing observer, NO trace. Must not propagate.
      const result = await applyPatch(patch, port, throwingObserver, undefined)

      // Real on-disk effect observed — the patch landed despite the throw.
      expect(readFileSync(join(jail, "edit.dat"), "utf8")).toBe(EXPECTED)
      // The success ApplyResult is returned unchanged.
      expect(result.filesUpdated).toContain("edit.dat")
    } finally {
      rmSync(jail, { recursive: true, force: true })
    }
  })

  test("OTel trace port THROWS on every op ⇒ apply still commits (disk mutated) + returns success", async () => {
    const jail = makeJailRoot()
    try {
      writeFileSync(join(jail, "edit.dat"), SEED)
      const port = new FsJailFileSystemPort({ jailRoot: jail })
      const patch = parsePatch(UPDATE_PATCH)

      // NO observer, throwing trace. Must not propagate.
      const result = await applyPatch(patch, port, undefined, throwingTrace)

      expect(readFileSync(join(jail, "edit.dat"), "utf8")).toBe(EXPECTED)
      expect(result.filesUpdated).toContain("edit.dat")
    } finally {
      rmSync(jail, { recursive: true, force: true })
    }
  })

  test("BOTH observer AND trace THROW ⇒ apply still commits (disk mutated) + returns success", async () => {
    const jail = makeJailRoot()
    try {
      writeFileSync(join(jail, "edit.dat"), SEED)
      const port = new FsJailFileSystemPort({ jailRoot: jail })
      const patch = parsePatch(UPDATE_PATCH)

      const result = await applyPatch(patch, port, throwingObserver, throwingTrace)

      expect(readFileSync(join(jail, "edit.dat"), "utf8")).toBe(EXPECTED)
      expect(result.filesUpdated).toContain("edit.dat")
    } finally {
      rmSync(jail, { recursive: true, force: true })
    }
  })

  test("PAIRED CONTROL — independence: observer throws does NOT stop the trace emit (and vice versa)", async () => {
    // Proves the two sinks are in SEPARATE try/catch blocks: a throw from one
    // must not prevent the OTHER from receiving its events. If they shared one
    // catch, the sink registered second after a first-sink throw would receive
    // ZERO events.
    const jailA = makeJailRoot()
    const jailB = makeJailRoot()
    try {
      // (a) observer throws, trace is a RECORDER — the recorder must still see events.
      writeFileSync(join(jailA, "edit.dat"), SEED)
      const traceSeen: PatchObservation[] = []
      const recordingTrace: PatchTracePort = {
        recordPatchOp: (e) => {
          traceSeen.push(e)
        },
      }
      await applyPatch(parsePatch(UPDATE_PATCH), new FsJailFileSystemPort({ jailRoot: jailA }), throwingObserver, recordingTrace)
      expect(readFileSync(join(jailA, "edit.dat"), "utf8")).toBe(EXPECTED)
      // The trace saw its events even though the observer (called FIRST) threw.
      expect(traceSeen.some((e) => e.op === "update")).toBe(true)

      // (b) trace throws, observer is a RECORDER — the recorder must still see events.
      writeFileSync(join(jailB, "edit.dat"), SEED)
      const obsSeen: PatchObservation[] = []
      const recordingObserver: PatchObserver = (e) => {
        obsSeen.push(e)
      }
      await applyPatch(parsePatch(UPDATE_PATCH), new FsJailFileSystemPort({ jailRoot: jailB }), recordingObserver, throwingTrace)
      expect(readFileSync(join(jailB, "edit.dat"), "utf8")).toBe(EXPECTED)
      expect(obsSeen.some((e) => e.op === "update")).toBe(true)
    } finally {
      rmSync(jailA, { recursive: true, force: true })
      rmSync(jailB, { recursive: true, force: true })
    }
  })

  test("ANTI-VACUOUS — non-throwing sinks actually RECEIVE events on the happy path", async () => {
    // Guards against the fail-open cases passing merely because the sinks are
    // never invoked: here both sinks are live recorders and MUST observe the op.
    const jail = makeJailRoot()
    try {
      writeFileSync(join(jail, "edit.dat"), SEED)
      const obsSeen: PatchObservation[] = []
      const traceSeen: PatchObservation[] = []
      const result = await applyPatch(
        parsePatch(UPDATE_PATCH),
        new FsJailFileSystemPort({ jailRoot: jail }),
        (e) => {
          obsSeen.push(e)
        },
        {
          recordPatchOp: (e) => {
            traceSeen.push(e)
          },
        },
      )
      expect(readFileSync(join(jail, "edit.dat"), "utf8")).toBe(EXPECTED)
      expect(result.filesUpdated).toContain("edit.dat")
      // Both sinks were genuinely driven — the fail-open cases above therefore
      // exercise a LIVE seam, not a dead no-op.
      expect(obsSeen.some((e) => e.op === "update")).toBe(true)
      expect(traceSeen.some((e) => e.op === "update")).toBe(true)
    } finally {
      rmSync(jail, { recursive: true, force: true })
    }
  })
})

describe("patch-observer-fail-open — end-to-end through the apply_patch composition root", () => {
  test("applyPatchTool.execute with a THROWING span sink ⇒ apply commits (disk mutated) + outcome ok", async () => {
    // Drives the REAL wiring: `applyPatchTool.execute` injects `PATCH_TRACE`
    // (the OTel-bound port) which routes through `recordAttrs` onto the active
    // span sink. A sink whose `onStart`/`onEnd` throw is a telemetry bug at the
    // OUTERMOST layer; the apply must still fail-open end-to-end.
    //
    // SCOPE (honest — do NOT read this as a wrapObserver localizer): a throwing
    // span sink is swallowed by `recordAttrs` (spans.ts) BEFORE control returns
    // to `wrapObserver`, so this case is guarded by TWO independent swallows in
    // series (recordAttrs + wrapObserver) and reds only if BOTH break — it is a
    // composition-root smoke proving the outer telemetry layer is also fail-open,
    // NOT a single-point regression detector for `wrapObserver`. The wrapObserver
    // catches themselves are localized (red-on-injection) by the direct-injection
    // unit cases above, which rethrow one catch at a time.
    const jail = makeJailRoot()
    try {
      writeFileSync(join(jail, "edit.dat"), SEED)
      __resetSpanSink()
      setSpanSink({
        onStart: () => {
          throw new Error("sink.onStart boom")
        },
        onEnd: () => {
          throw new Error("sink.onEnd boom")
        },
      })
      const ctx = {
        cwd: jail,
        signal: new AbortController().signal,
      } as unknown as ToolContext

      let outcomeOk: boolean | undefined
      try {
        for await (const event of applyPatchTool.execute({ patch: UPDATE_PATCH }, ctx)) {
          if (event.type === "result") outcomeOk = event.result.ok
        }
      } finally {
        __resetSpanSink()
      }

      // Real on-disk effect + a successful result event despite the throwing sink.
      expect(readFileSync(join(jail, "edit.dat"), "utf8")).toBe(EXPECTED)
      expect(outcomeOk).toBe(true)
    } finally {
      __resetSpanSink()
      rmSync(jail, { recursive: true, force: true })
    }
  })
})
