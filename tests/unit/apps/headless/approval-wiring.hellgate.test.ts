import { describe, expect, test } from "bun:test"
import {
  buildHeadlessApprovalWiring,
  HEADLESS_INLINE_APPROVAL_GATE,
} from "@/apps/headless/approval-wiring"
import { __testing as approvalTesting } from "@/host/runtime/internal/context-binding"
import type { ToolAction } from "@/permission"

/**
 * Headless inline approval wiring (ADR-0540 W1-A) — hellgate.
 *
 * Problem class pinned: headless auto-approves EVERY approval-needing tool via the
 * DEFERRED protocol — the runtime throws `RuntimeApprovalRequiredError`, aborts the
 * whole turn, then `driveSessionTurn`'s `resolveApproval: () => "approve"` re-runs
 * the turn from scratch (re-paying the full prompt PER approval). W1-A extends the
 * CLI's jun-10 inline-interactive machinery to headless: a mid-turn ask delegates
 * INLINE to an auto-policy surface — same turn, no throw, no re-run.
 *
 * Contract pinned:
 *  1. Gate `QUANTA_INLINE_APPROVAL_RESOLVER` ON ⇒ wiring declares
 *     `approvalProtocol.interactive:true` + a `confirmSlot` whose surface
 *     auto-approves; the REAL runtime controller then resolves a mid-turn ask
 *     INLINE (returns the decision, mints NO pending approval, does NOT throw).
 *  2. Gate OFF ⇒ NO `approvalProtocol`, base `onConfirm` denies — byte-identical
 *     to the pre-W1 headless composition; the controller throws
 *     `RuntimeApprovalRequiredError` + mints a pending approval (deferred).
 *  3. The gate is opt-in / default-OFF: an unset env ⇒ the deferred (OFF) shape.
 *
 * The behavioral tests drive the EXACT production controller
 * (`createRuntimeApprovalProtocolController`) with the wiring's real output — so a
 * regression in `buildHeadlessApprovalWiring` (e.g. ON silently yielding the
 * deferred shape) flips inline↔throw and reddens the test (proven via mutation).
 */

const makeRegistry = (shellFor: (tool: string, input: unknown) => string | null) =>
  ({
    extractShellCommand: (tool: string, input: unknown) => shellFor(tool, input),
  }) as unknown as Parameters<
    typeof approvalTesting.createRuntimeApprovalProtocolController
  >[0]["registry"]

const action = (tool: string, input: unknown = {}): ToolAction => ({
  tool,
  input,
  isReadOnly: false,
})

/** Build the REAL runtime approval controller from a headless wiring's output. */
const controllerFor = (
  wiring: ReturnType<typeof buildHeadlessApprovalWiring>,
): ReturnType<typeof approvalTesting.createRuntimeApprovalProtocolController> => {
  const registry = makeRegistry(() => null)
  const base = {
    registry,
    ...(wiring.approvalProtocol !== undefined ? { approvalProtocol: wiring.approvalProtocol } : {}),
  } as unknown as Parameters<typeof approvalTesting.createRuntimeApprovalProtocolController>[0]
  return approvalTesting.createRuntimeApprovalProtocolController(base)
}

const ON = { [HEADLESS_INLINE_APPROVAL_GATE]: "1" }
const OFF: Record<string, string | undefined> = {}

describe("headless approval wiring — gate-controlled shape", () => {
  test("gate ON ⇒ interactive:true + a confirmSlot surface that auto-approves", async () => {
    const wiring = buildHeadlessApprovalWiring(ON)
    expect(wiring.approvalProtocol?.interactive).toBe(true)
    const surface = wiring.approvalProtocol?.confirmSlot.current
    expect(typeof surface).toBe("function")
    // The surface is the auto-policy: a mid-turn ask approves.
    expect(await surface?.(action("edit"))).toBe(true)
    // Base onConfirm reads the LIVE slot (mirrors CLI) — currently the surface.
    expect(await wiring.onConfirm(action("edit"))).toBe(true)
  })

  test("gate OFF ⇒ NO approvalProtocol + base onConfirm denies (byte-identical deferred)", async () => {
    const wiring = buildHeadlessApprovalWiring(OFF)
    expect(wiring.approvalProtocol).toBeUndefined()
    expect(await wiring.onConfirm(action("edit"))).toBe(false)
  })

  test("gate is opt-in: unset env is treated as OFF (not ON)", () => {
    // Paired control against the ON literal — proves the gate READS the env, is
    // not hardwired. An empty env and a falsy token both yield the deferred shape.
    expect(buildHeadlessApprovalWiring({}).approvalProtocol).toBeUndefined()
    expect(
      buildHeadlessApprovalWiring({ [HEADLESS_INLINE_APPROVAL_GATE]: "0" }).approvalProtocol,
    ).toBeUndefined()
    expect(buildHeadlessApprovalWiring(ON).approvalProtocol).toBeDefined()
  })
})

describe("headless approval wiring — behavioral through the REAL runtime controller", () => {
  test("gate ON ⇒ mid-turn ask resolves INLINE (returns decision, no pending, no throw)", async () => {
    const ctrl = controllerFor(buildHeadlessApprovalWiring(ON))
    const result = await ctrl.runWithProtocol(async () => await ctrl.onConfirm(action("edit")))
    expect(result).toBe(true) // inline auto-approve
    expect(ctrl.__pendingSize()).toBe(0) // NO deferred pending approval minted
  })

  test("gate OFF ⇒ mid-turn ask is DEFERRED (throws RuntimeApprovalRequiredError + mints pending)", async () => {
    const ctrl = controllerFor(buildHeadlessApprovalWiring(OFF))
    let thrown: unknown
    await ctrl.runWithProtocol(async () => {
      try {
        await ctrl.onConfirm(action("edit"))
      } catch (e) {
        thrown = e
      }
    })
    expect((thrown as { name?: string })?.name).toBe("RuntimeApprovalRequiredError")
    expect(ctrl.__pendingSize()).toBe(1) // a pending approval was minted (deferred)
  })

  test("PAIRED CONTROL — same tool, ON inline-approves vs OFF throws (the gate is the only diff)", async () => {
    const onCtrl = controllerFor(buildHeadlessApprovalWiring(ON))
    const onResult = await onCtrl.runWithProtocol(
      async () => await onCtrl.onConfirm(action("bash", { command: "ls" })),
    )
    expect(onResult).toBe(true)

    const offCtrl = controllerFor(buildHeadlessApprovalWiring(OFF))
    await expect(
      offCtrl.runWithProtocol(
        async () => await offCtrl.onConfirm(action("bash", { command: "ls" })),
      ),
    ).rejects.toThrow(/runtime approval required/)
  })
})
