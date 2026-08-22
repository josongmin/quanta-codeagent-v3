/**
 * HookBus integration for command hooks (ADR-0454).
 *
 * `installCommandHooks` registers ONE {@link HookBus} handler per modeled event
 * that adapts the bus's {@link HookEvent} into a {@link CommandHookEvent}, runs
 * the armed/permitted command hooks via {@link runCommandHooks}, and maps the
 * {@link CommandHookVerdict} back onto the {@link HookEmitResult} channels
 * (`deny` / `updatedInput`) the bus already understands.
 *
 * DEFAULT-OFF — when the gate is NOT armed, `installCommandHooks` registers NO
 * handlers at all (early return), so the bus is byte-identical to a bus with no
 * command hooks. A host that never calls this function is also byte-identical.
 */

import type { HookBus, HookEvent } from "../hooks"
import { mapClaudeEvent } from "./gate"
import { type CommandHookEvent, runCommandHooks } from "./runner"
import type { CommandHookDeps, CommandHookGate } from "./types"

/** Events for which a command hook can vote `deny` / `updatedInput`. Only
 *  `pre_tool_use` honors `updatedInput`; `user_prompt_submit` honors `deny`;
 *  the observer events run the command but ignore its verdict. */
const TOOL_GATING_EVENT = "pre_tool_use"

/** Events whose command-hook verdict can BLOCK the action (`deny`). If the hook
 *  runner throws for one of these (exec-adapter EMFILE/OOM/bug), the security
 *  intent is fail-CLOSED — we must translate the throw into a `deny` here rather
 *  than let it propagate to `HookBus.runHandler`, whose catch-and-continue would
 *  fail-OPEN and pass the guarded tool through as if no hook were configured. */
const DENY_CAPABLE_EVENTS: ReadonlySet<HookEvent["type"]> = new Set([
  "pre_tool_use",
  "user_prompt_submit",
])

/** Adapt a HookBus {@link HookEvent} into the runner's {@link CommandHookEvent}.
 *  Pulls the tool name (for matcher gating) from tool-shaped events. */
const toCommandHookEvent = (event: HookEvent): CommandHookEvent => {
  if (
    event.type === "pre_tool_use" ||
    event.type === "post_tool_use" ||
    event.type === "post_tool_use_failure" ||
    // T04 (UC4) — permission_request is tool-shaped (it carries the tool `name`
    // the gate is deciding on), so a `matcher` must select against it too.
    event.type === "permission_request"
  ) {
    return { type: event.type, toolName: event.name, payload: event }
  }
  return { type: event.type, payload: event }
}

type CommandHookVerdict = Awaited<ReturnType<typeof runCommandHooks>>
type CommandHookRun =
  | { readonly ok: true; readonly verdict: CommandHookVerdict }
  | { readonly ok: false; readonly error: unknown }

const runCommandHookSafely = async (
  gate: CommandHookGate,
  deps: CommandHookDeps,
  event: HookEvent,
): Promise<CommandHookRun> => {
  try {
    return { ok: true, verdict: await runCommandHooks(gate, deps, toCommandHookEvent(event)) }
  } catch (error) {
    return { ok: false, error }
  }
}

const projectHookResult = (type: HookEvent["type"], result: CommandHookRun): unknown => {
  if (!result.ok) {
    if (!DENY_CAPABLE_EVENTS.has(type)) return undefined
    const reason = result.error instanceof Error ? result.error.message : String(result.error)
    return { deny: `command-hook execution failed (fail-closed): ${reason}` }
  }
  if (result.verdict.deny !== null) return { deny: result.verdict.deny.reason }
  if (type === TOOL_GATING_EVENT && "updatedInput" in result.verdict) {
    return { updatedInput: result.verdict.updatedInput }
  }
  // RFC09-1 (A-GAP-2) — an append-context producer forwards its `promptHook`
  // onto the SAME `HookEmitResult.promptHook` accumulator the in-process path
  // fills (hooks.ts `accumulatePromptHook`). ZERO new inject site. Available on
  // every event the runner runs (not just the tool-gating one) so a
  // `session_start` / `user_prompt_submit` command hook can inject context.
  //
  // TRUST BOUNDARY (defense-in-depth): this adapter bridges an UNTRUSTED spawned
  // command into the TRUSTED HookBus prompt channel. The runner already emits
  // `injectBeforeUser`-only, but we re-clamp HERE at the boundary so a future
  // runner regression can NEVER hand `injectAfterSystem` (raw system-prompt
  // authority) to the bus. Only the user-side channel crosses.
  const before = result.verdict.promptHook?.injectBeforeUser
  if (typeof before === "string" && before.length > 0) {
    return { promptHook: { injectBeforeUser: before } }
  }
  return undefined
}

/**
 * Register command-hook handlers on `bus`. No-op (registers nothing) when the
 * gate is not armed — preserving the default-OFF byte-identical contract.
 *
 * Returns the bus for chaining.
 */
export const installCommandHooks = (
  bus: HookBus,
  gate: CommandHookGate,
  deps: CommandHookDeps,
): HookBus => {
  if (!gate.armed) return bus

  // The set of quanta event types any binding maps to — register only those so
  // unrelated events keep their fast no-handler path.
  const eventTypes = new Set<HookEvent["type"]>()
  for (const b of gate.bindings) {
    const mapped = mapClaudeEvent(b.event)
    if (mapped !== undefined) eventTypes.add(mapped)
  }

  for (const type of eventTypes) {
    bus.on(type, async (event) => {
      const result = await runCommandHookSafely(gate, deps, event)
      return projectHookResult(type, result)
    })
  }
  return bus
}
