/**
 * `SideConversationPort` — surface-agnostic seam for the `/side` slash command.
 *
 * The CLI's slash-surface layer USED to capture `(SessionDeps, assembleConfig,
 * messages, signal)` into a factory and hand the resulting state to
 * `/side`. That coupled the slash adapter to engine-internals (`SessionDeps`,
 * `assembleConfig`). After ADR-0304 the slash layer instead consumes ONLY this
 * typed port whose `.start(...)` is wired ONCE at surface composition time —
 * the host/runtime compat owner captures the `SessionDeps` + `assembleConfig`
 * pair internally; the slash never sees them.
 *
 * Slice contract:
 *
 *   - Lives in `@/runner` (the surface-agnostic L2 orchestration slice). Any
 *     surface (CLI / Web / Tauri) MAY build a port impl from its own
 *     deps/config wiring; `@/runner` itself never imports `apps/**`.
 *   - The PORT itself owns NO engine-internal references. Specifically: it
 *     does NOT carry `SessionDeps`, `OrchestrateDeps`, or `assembleConfig`.
 *     Those are CAPTURED at construction (closure-only) by the adapter
 *     factory. The slash layer only ever sees `port.start(args)`.
 *   - FROZEN once shipped — do NOT add closure-captured fields. Keep the
 *     shape "plain data args + start callback".
 */

import type { Message } from "@/llm"
import type { SideChatContextInheritance, SideChatResult } from "./orchestrate"

/**
 * Per-request arguments to {@link SideConversationPort.start}.
 *
 *  - `question` — the standalone prompt to ask in the isolated agent loop.
 *  - `messages` — READ-ONLY snapshot of the live main-session transcript at
 *    call time. Consumed only when `inherit === "last-turn"`; the side-chat
 *    body NEVER mutates it.
 *  - `inherit` — context-inheritance mode (`none | system | last-turn`).
 *    Forwarded to `runSideChat` as-is; absent ⇒ runner default `"system"`.
 *  - `tools` — per-call override of the tool allowlist. Forbidden (mutating)
 *    tools are still physically absent from the side-chat registry — names
 *    that resolve to them are silently dropped by the runner.
 *  - `maxTurns` — per-call max-turn override. Runner additionally clamps to
 *    `SIDE_CHAT_MAX_TURNS_CAP`.
 *  - `signal` — abort signal threaded straight into `runAgent`.
 */
export interface SideConversationStartArgs {
  readonly question: string
  readonly inherit?: SideChatContextInheritance
  readonly tools?: readonly string[]
  readonly maxTurns?: number
  readonly signal: AbortSignal
  /** READ-ONLY transcript snapshot at call time (for last-turn inherit mode). */
  readonly messages: readonly Message[]
}

/**
 * The seam the slash-surface depends on. Surface-agnostic — implementations
 * MAY live anywhere (e.g. `src/host/runtime/session-host.ts`). The port
 * value carries NO engine-internal type references; impls are free to capture
 * any deps they need in closure scope.
 */
export interface SideConversationPort {
  readonly start: (args: SideConversationStartArgs) => Promise<SideChatResult>
}
