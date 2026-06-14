/**
 * ★ HELLGATE — T05 web/SDK per-hunk PARTIAL APPLY at the approval RESOLVE
 * boundary (the deferred path `commands.ts#selectedHunks` finally honored).
 *
 * The CLI inline-confirm surface already applies a hunk subset directly via the
 * executor. The out-of-band path (web/SDK) carries the operator's choice as
 * `ApprovalRespondCommand.selectedHunks` → `host.resolveApproval(id,"approve",
 * {selectedHunks})`. Until now that field had NO effect (documented deferral).
 *
 * This pins the REAL resolver (`createRuntimeApprovalProtocolController
 * .resolveApproval`): an approve carrying a PROPER SUBSET of the previewed
 * mutation's hunk ids writes ONLY those hunks to disk (atomic, mode-preserving,
 * staleness-guarded via `@/runner/hunk-apply`) and mints a `deny_and_steer`
 * lease so the whole-call tool does NOT also run. Teeth = fresh-readback of the
 * file: the rejected hunk's line must remain at its ORIGINAL value.
 *
 * RED-on-injection: with `selectedHunks` ignored (pre-T05 wiring) the resolver
 * writes nothing here, so test 1's fresh-readback sees the ORIGINAL line2 and
 * fails. Gate-off (test 2) is the paired control: byte-identical no-write.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createRuntimeApprovalProtocolController,
  RuntimeApprovalRequiredError,
} from "@/host/runtime/internal/context-binding"
import type { ToolAction } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"

type Ctrl = ReturnType<typeof createRuntimeApprovalProtocolController>

const makeCtrl = (): { ctrl: Ctrl; slot: { current: (a: ToolAction) => Promise<boolean> } } => {
  const slot = { current: (async () => true) as (a: ToolAction) => Promise<boolean> }
  const registry = { extractShellCommand: () => null }
  const base = { registry, cwd: process.cwd(), approvalProtocol: { confirmSlot: slot } }
  const ctrl = createRuntimeApprovalProtocolController(
    base as unknown as Parameters<typeof createRuntimeApprovalProtocolController>[0],
  )
  return { ctrl, slot }
}

const BEFORE = ["line1", "line2", "line3", "line4", "line5"].join("\n")
const AFTER = ["line1", "L2X", "line3", "L4X", "line5"].join("\n")

const writeAction = (path: string, content: string): ToolAction => ({
  tool: "write",
  input: { path, content },
  isReadOnly: false,
})

const freshFile = (content: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "t05-web-"))
  const f = join(dir, "main.ts")
  writeFileSync(f, content)
  return f
}

const requestApproval = async (
  ctrl: Ctrl,
  slot: { current: (a: ToolAction) => Promise<boolean> },
  act: ToolAction,
): Promise<string> => {
  try {
    await ctrl.runWithProtocol(async () => {
      await slot.current(act)
    })
  } catch (e) {
    if (e instanceof RuntimeApprovalRequiredError) return e.approval.approvalId
    throw e
  }
  throw new Error("expected RuntimeApprovalRequiredError")
}

const withGate = async (on: boolean, fn: () => Promise<void>): Promise<void> => {
  const prev = process.env.QUANTA_HUNK_APPROVAL
  if (on) process.env.QUANTA_HUNK_APPROVAL = "1"
  else delete process.env.QUANTA_HUNK_APPROVAL
  __resetRuntimeConfig()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.QUANTA_HUNK_APPROVAL
    else process.env.QUANTA_HUNK_APPROVAL = prev
    __resetRuntimeConfig()
  }
}

describe("T05 web per-hunk partial apply at resolveApproval", () => {
  test("1. approve with a PROPER SUBSET writes ONLY the selected hunk (fresh-readback)", async () => {
    await withGate(true, async () => {
      const { ctrl, slot } = makeCtrl()
      const file = freshFile(BEFORE)
      const act = writeAction(file, AFTER)
      const id = await requestApproval(ctrl, slot, act)
      // Operator (web card) accepted only the FIRST hunk (line2). h2 (line4) rejected.
      await ctrl.resolveApproval(id, "approve", { selectedHunks: ["h1"] })
      const disk = readFileSync(file, "utf8").split("\n")
      expect(disk[1]).toBe("L2X") // selected hunk applied
      expect(disk[3]).toBe("line4") // rejected hunk NOT applied — the teeth
      // Whole-call SUPPRESSED: the re-run claims a deny_and_steer lease (not a
      // bare `true` grant), so the original write never re-applies the full AFTER
      // (which would clobber line4 back to L4X). The steer tells the model what
      // landed. This is the universal REJECT_AND_TELL verb (ADR-0076).
      const claimed = await ctrl.onConfirm(act)
      expect(typeof claimed).toBe("object")
      expect((claimed as { decision: string }).decision).toBe("deny_and_steer")
      expect((claimed as { steer: string }).steer).toContain("accepted")
    })
  })

  test("2. gate OFF ⇒ selectedHunks ignored, resolver writes nothing (byte-identical control)", async () => {
    await withGate(false, async () => {
      const { ctrl, slot } = makeCtrl()
      const file = freshFile(BEFORE)
      const act = writeAction(file, AFTER)
      const id = await requestApproval(ctrl, slot, act)
      await ctrl.resolveApproval(id, "approve", { selectedHunks: ["h1"] })
      expect(readFileSync(file, "utf8")).toBe(BEFORE) // untouched by the resolver
    })
  })

  test("3. approve with ALL hunks ⇒ whole-call grant, resolver writes nothing (tool re-runs)", async () => {
    await withGate(true, async () => {
      const { ctrl, slot } = makeCtrl()
      const file = freshFile(BEFORE)
      const id = await requestApproval(ctrl, slot, writeAction(file, AFTER))
      await ctrl.resolveApproval(id, "approve", { selectedHunks: ["h1", "h2"] })
      expect(readFileSync(file, "utf8")).toBe(BEFORE) // whole-call path: tool writes on re-run
    })
  })

  test("4. approve with NONE ⇒ deny, no write", async () => {
    await withGate(true, async () => {
      const { ctrl, slot } = makeCtrl()
      const file = freshFile(BEFORE)
      const id = await requestApproval(ctrl, slot, writeAction(file, AFTER))
      await ctrl.resolveApproval(id, "approve", { selectedHunks: [] })
      expect(readFileSync(file, "utf8")).toBe(BEFORE)
    })
  })

  test("5. STALE — file changed since the preview ⇒ no partial write (safe)", async () => {
    await withGate(true, async () => {
      const { ctrl, slot } = makeCtrl()
      const file = freshFile(BEFORE)
      const id = await requestApproval(ctrl, slot, writeAction(file, AFTER))
      writeFileSync(file, "totally different content now\n") // drift after request
      await ctrl.resolveApproval(id, "approve", { selectedHunks: ["h1"] })
      expect(readFileSync(file, "utf8")).toBe("totally different content now\n")
    })
  })

  test("6. NON-PREVIEWABLE tool (bash) ⇒ no baseline captured ⇒ whole-call grant (true)", async () => {
    await withGate(true, async () => {
      const { ctrl, slot } = makeCtrl()
      const bash: ToolAction = { tool: "bash", input: { command: "echo hi" }, isReadOnly: false }
      const id = await requestApproval(ctrl, slot, bash)
      await ctrl.resolveApproval(id, "approve", { selectedHunks: ["h1"] })
      // selectedHunks is moot: a bash action has no (before,after) ⇒ actionDiff
      // absent ⇒ the approve takes the NORMAL whole-call grant (bare `true`).
      expect(await ctrl.onConfirm(bash)).toBe(true)
    })
  })

  test("7. SINGLE-hunk change ⇒ no baseline (≥2 required) ⇒ whole-call grant", async () => {
    await withGate(true, async () => {
      const { ctrl, slot } = makeCtrl()
      const file = freshFile(BEFORE)
      const oneHunk = ["line1", "ONLY-L2", "line3", "line4", "line5"].join("\n")
      const act = writeAction(file, oneHunk)
      const id = await requestApproval(ctrl, slot, act)
      await ctrl.resolveApproval(id, "approve", { selectedHunks: ["h1"] })
      expect(readFileSync(file, "utf8")).toBe(BEFORE) // resolver wrote nothing
      expect(await ctrl.onConfirm(act)).toBe(true) // whole-call grant
    })
  })
})
