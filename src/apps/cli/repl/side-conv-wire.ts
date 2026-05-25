/**
 * `buildSideConversationPort` — CLI-side adapter that produces a
 * {@link SideConversationPort} from session-time deps. The factory is the
 * SOLE place in the CLI surface where `SessionDeps` and `assembleConfig`
 * meet the side-chat runner — once a port is built, the slash-surface layer
 * (`slash-surface.ts`) holds only the typed port and never sees
 * engine-internals.
 *
 * Design (ADR-0304):
 *
 *   - `deps` + `assembleConfig` are CAPTURED at construction (closure-only).
 *     They are not surfaced on the {@link SideConversationPort} type.
 *   - `defaultTools` / `defaultMaxTurns` are surface-resolved defaults
 *     (typically derived from the `QUANTA_SIDE_*` env knobs by the composer).
 *     A per-call override on {@link SideConversationStartArgs} wins; absent
 *     ⇒ the default is forwarded to `runSideChat` (which still hard-clamps
 *     to `SIDE_CHAT_MAX_TURNS_CAP` and intersects the allowlist with
 *     `SIDE_CHAT_FORBIDDEN`).
 *   - Per-call `signal` and `messages` are passed THROUGH the port at start
 *     time — the slash surface owns those values (live transcript + abort
 *     controller) and the port has no business binding them at composition.
 */

import type { Message } from "@/llm"
import {
  type RunOnceInput,
  runSideChat,
  type SideChatResult,
  type SideConversationPort,
  type SideConversationStartArgs,
} from "@/runner"
import type { SessionDeps } from "../internal"

export interface BuildSideConversationPortArgs {
  readonly deps: SessionDeps
  readonly assembleConfig: RunOnceInput["assembleConfig"]
  readonly defaultTools?: readonly string[]
  readonly defaultMaxTurns?: number
}

export const buildSideConversationPort = (
  args: BuildSideConversationPortArgs,
): SideConversationPort => ({
  start: async (req: SideConversationStartArgs): Promise<SideChatResult> => {
    const maxTurns = req.maxTurns ?? args.defaultMaxTurns
    const tools = req.tools ?? args.defaultTools
    const mainHistory: readonly Message[] = req.messages
    return runSideChat({
      deps: args.deps,
      assembleConfig: args.assembleConfig,
      prompt: req.question,
      mainHistory,
      signal: req.signal,
      ...(req.inherit !== undefined ? { contextInheritance: req.inherit } : {}),
      ...(tools !== undefined ? { toolAllowlist: tools } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    })
  },
})
