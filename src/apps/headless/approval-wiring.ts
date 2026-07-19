/**
 * Headless approval wiring — ADR-0540 W1-A (인라인 승인 resolver를 headless로 확장).
 *
 * `QUANTA_INLINE_APPROVAL_RESOLVER` (opt-in, default-OFF):
 *   - OFF ⇒ 오늘의 deferred 경로 byte-identical: base `onConfirm: async () => false`,
 *     `approvalProtocol` 미설정. 승인 필요 tool은 runtime이 throw →
 *     `index.ts`의 `driveSessionTurn({ resolveApproval: async () => "approve" })`가
 *     turn을 재실행해 승인(= full prompt 재지불).
 *   - ON ⇒ CLI(jun-10 HITL restructure)와 **동일한 인라인 머신러리 재사용**: 라이브
 *     operator가 없는 headless는 auto-policy surface를 `confirmSlot`에 심고
 *     `interactive: true`로 선언한다. gate에서의 mid-turn ask가 그 surface(auto-
 *     approve)에 INLINE 위임 → 같은 turn 계속(throw/abort/re-run 없음).
 *     `approval-protocol.ts`·CLI 컴포지션은 무수정 — overlay 경로만 사용.
 *
 * web-daemon은 의도적으로 제외: inline WS round-trip은 `transportDispatchQueue`
 * 직렬화로 데드락(ADR-0540 §W1-B — daemon-ownership으로 별도 처리). headless는
 * operator도 네트워크 왕복도 없어 surface가 동기적으로 즉시 결정하므로 안전하다.
 */
import type { AgentConfig } from "@/agent"
import type { ToolAction } from "@/permission"
import { gateOn } from "@/shared"

/** ADR-0540 W1-A gate — opt-in, default-OFF. `[[knob-config-systems-inventory]]`. */
export const HEADLESS_INLINE_APPROVAL_GATE = "QUANTA_INLINE_APPROVAL_RESOLVER"

type SurfaceConfirm = NonNullable<AgentConfig["onConfirm"]>

export interface HeadlessApprovalWiring {
  /** base `onConfirm` — gate OFF: deny (deferred). gate ON: reads the live
   *  `confirmSlot` (the runtime swaps it to its controller mid-turn; the gate +
   *  sandbox-escalation read through this), mirroring the CLI composition. */
  readonly onConfirm: SurfaceConfirm
  /** Present when a delivery mode ARMS the runtime approval protocol — the INLINE
   *  gate (`interactive: true`, same-turn auto-resolve) OR the jul-18 WIRE-DEFER
   *  mode (`interactive: false`, mint+throw ⇒ a wire round-trip). Passed on the
   *  runtime bootstrap overlay (`overlay.approvalProtocol`); shape matches
   *  `RuntimeApprovalProtocolConfig`. `confirmSlot.current` MUST stay mutable —
   *  `runWithProtocol` reassigns it. Absent ⇒ the OFF deferred-deny composition. */
  readonly approvalProtocol?: {
    readonly confirmSlot: { current: SurfaceConfirm }
    readonly interactive: boolean
  }
}

/** gate OFF — byte-identical to the pre-W1 headless composition (deny at the base
 *  `onConfirm`; the auto-approve happens in `index.ts`'s deferred `resolveApproval`
 *  re-run). No `approvalProtocol` ⇒ the runtime keeps the deferred throw protocol. */
const deferredWiring = (): HeadlessApprovalWiring => ({ onConfirm: async () => false })

/** jul-18 (02 serve --stdio) — WIRE-DEFER: arm the approval-protocol overlay in
 *  the DEFERRED (non-interactive) posture. The base `onConfirm` is a deny (it is
 *  NEVER reached: with `interactive:false` `runOnConfirm` mints a pending approval
 *  and throws `RuntimeApprovalRequiredError` BEFORE consulting the slot). The
 *  `confirmSlot.current` is that same reference so `runWithProtocol` pushes NO
 *  surface confirm — the throw path stays clean (a WIRE client, not an inline
 *  operator, resolves the ask via `approval.respond`). This is the third mode
 *  the ADR-0540 W1-A doc named ("wire-defer") but left unimplemented; it differs
 *  from OFF-deny by ARMING the overlay (⇒ kernel `awaiting_approval` +
 *  `approval.requested` wire event) and from inline by staying NON-interactive
 *  (⇒ no same-turn auto-resolve). */
const wireDeferWiring = (): HeadlessApprovalWiring => {
  // The base `onConfirm` the AgentConfig carries MUST route through the SAME
  // `confirmSlot` the runtime swaps (`runWithProtocol` sets `slot.current` to the
  // runtime approval controller's throwing onConfirm at scope entry) — exactly
  // like the inline path. Otherwise the agent would call this deny directly and
  // NEVER reach `runOnConfirm`'s deferred mint+throw. With `interactive:false`
  // the controller mints a pending approval + throws (the wire round-trip); the
  // pre-swap slot value below is a fail-closed deny that is never reached.
  const preSwapDeny: SurfaceConfirm = async () => false
  const confirmSlot = { current: preSwapDeny }
  const onConfirm: SurfaceConfirm = async (action: ToolAction) => await confirmSlot.current(action)
  return { onConfirm, approvalProtocol: { confirmSlot, interactive: false } }
}

export const buildHeadlessApprovalWiring = (
  env: Record<string, string | undefined>,
  opts?: { readonly wireDefer?: boolean },
): HeadlessApprovalWiring => {
  // An explicit surface delivery contract WINS over the ambient inline gate.
  // `serve --stdio` has a real wire operator (`connect({onApproval})`), so an
  // inherited QUANTA_INLINE_APPROVAL_RESOLVER must never silently bypass that
  // operator and auto-approve. Unattended serve callers already have the
  // explicit permission modes (`bypass` / `acceptEdits`) for that posture.
  if (opts?.wireDefer === true) return wireDeferWiring()
  // No external operator: the inline auto-approve gate is an explicit opt-in
  // for ordinary headless execution and resolves the ask in-turn.
  if (gateOn(env, HEADLESS_INLINE_APPROVAL_GATE)) {
    // Auto-policy surface: headless has no operator, so a mid-turn ask auto-approves
    // INLINE (same turn) — the inline analogue of the deferred `resolveApproval`.
    const surfaceOnConfirm: SurfaceConfirm = async () => true
    const confirmSlot = { current: surfaceOnConfirm }
    const onConfirm: SurfaceConfirm = async (action: ToolAction) =>
      await confirmSlot.current(action)
    return { onConfirm, approvalProtocol: { confirmSlot, interactive: true } }
  }
  // Default OFF — deferred deny (byte-identical to the pre-jul-18 composition).
  return deferredWiring()
}
