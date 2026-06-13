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
      const verdict = await runCommandHooks(gate, deps, toCommandHookEvent(event))
      if (verdict.deny !== null) return { deny: verdict.deny.reason }
      // updatedInput only meaningful on the tool-gating event.
      if (type === TOOL_GATING_EVENT && "updatedInput" in verdict) {
        return { updatedInput: verdict.updatedInput }
      }
      return undefined
    })
  }
  return bus
}
