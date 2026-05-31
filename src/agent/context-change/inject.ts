/**
 * Persistent-injection message builder — converts {@link ContextEvent}s
 * into user-role {@link Message}s suitable for splicing into the per-turn
 * `messages[]` slice (between `baseMessages` and the trailing
 * `<system-reminder>` block).
 *
 * ADR-0319 — distinct from the ephemeral `<system-reminder>` tail in
 *   `src/agent/prompt.ts` which only echoes CURRENT state ("Working
 *   directory: X"). This builder produces a HISTORIC diff envelope
 *   (`<context-update field="cwd" prev="A" next="B">`) so the model sees
 *   "what changed" — not just "what is now".
 *
 * Security:
 *   - ALL rendered fragments funnel through {@link embedUntrusted} with the
 *     tag-name appropriate to the variant. A repo-supplied path containing
 *     `</context-update>` cannot terminate the wrapper.
 *   - The wrapper tag is purpose-specific (`context-update`, `mode-change`,
 *     `repo-rules-change`, `skill-activation`, `reasoning-echo`) so a forged
 *     opener that copy-pastes one tag does not collide with the harness's
 *     own `<system-reminder>` boundary.
 *
 * Output contract:
 *   - Empty `events` ⇒ `[]` (NOT a single empty message).
 *   - 1 message per event (no batching) so the model reads the diffs in
 *     order; the typed history store snapshot ordering is preserved by the
 *     caller (we do not re-sort).
 *   - `role: "user"` — fixed; these are out-of-band harness messages, never
 *     assistant turns.
 *   - `content` carries a single `TextBlock`; no images / tool_use / etc.
 *   - The TextBlock's `text` ends with a trailing newline before the closer
 *     thanks to {@link embedUntrusted}'s shape.
 */

import type { Message } from "@/llm"
import { embedUntrusted } from "../untrusted"
import type { ContextEvent } from "./types"

/** Format a single value for inclusion in the envelope. Strings render as
 *  themselves; objects / arrays / null / undefined render via JSON.stringify
 *  with the deterministic 2-arg form (no indentation — keeps the envelope
 *  compact and replay-stable). NaN / Infinity / BigInt fall through to a
 *  `String(value)` last-resort so the function NEVER throws. */
const formatValue = (v: unknown): string => {
  if (typeof v === "string") return v
  if (v === null) return "null"
  if (v === undefined) return ""
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** Build a single message from one event. Each variant has its own tag so
 *  the model reads the envelope as a typed signal (not "another reminder"). */
const buildOne = (event: ContextEvent): Message => {
  const turnSuffix = event.turnId !== undefined ? ` turnId="${event.turnId}"` : ""

  let tag: string
  let body: string
  switch (event.kind) {
    case "context_update":
      tag = "context-update"
      body = [
        `field: ${event.field}`,
        `prev: ${formatValue(event.prev)}`,
        `next: ${formatValue(event.next)}`,
        `at: ${event.at}${turnSuffix}`,
      ].join("\n")
      break
    case "mode_change":
      tag = "mode-change"
      body = [
        `prev: ${event.prev}`,
        `next: ${event.next}`,
        ...(event.reason !== undefined ? [`reason: ${event.reason}`] : []),
        `at: ${event.at}${turnSuffix}`,
      ].join("\n")
      break
    case "repo_rules_change":
      tag = "repo-rules-change"
      body = [
        `added: ${event.addedPaths.join(", ")}`,
        `removed: ${event.removedPaths.join(", ")}`,
        `at: ${event.at}${turnSuffix}`,
      ].join("\n")
      break
    case "skill_activation":
      tag = "skill-activation"
      body = [
        `skill: ${event.skillId}`,
        `trigger: ${event.trigger}`,
        `at: ${event.at}${turnSuffix}`,
      ].join("\n")
      break
    case "reasoning_echo":
      tag = "reasoning-echo"
      body = [
        `signature: ${event.signature}`,
        `redacted: ${event.redacted}`,
        ...(event.tokenCount !== undefined ? [`tokenCount: ${event.tokenCount}`] : []),
        `at: ${event.at}${turnSuffix}`,
      ].join("\n")
      break
    // ADR-0324 — 6th variant added to the closed-set union. Rendered
    // with the same envelope shape so the model reads "compaction
    // occurred" as a typed signal (mirrors Codex
    // `ResponseItem::Compaction`).
    case "compaction_event":
      tag = "compaction-event"
      body = [
        `trigger: ${event.trigger}`,
        `reason: ${event.reason}`,
        `tokensBefore: ${event.tokensBefore}`,
        `tokensAfter: ${event.tokensAfter}`,
        `messagesRemoved: ${event.messagesRemoved}`,
        `at: ${event.at}${turnSuffix}`,
      ].join("\n")
      break
    // ADR-0335 — 7th variant. A Codex `.codex-plugin/plugin.json`-style
    // plugin manifest was enabled this turn. `capabilities` renders as
    // a comma-separated list (empty ⇒ literal "(none)" so the absence
    // is unambiguous in the prompt).
    case "plugin_activation":
      tag = "plugin-activation"
      body = [
        `plugin: ${event.pluginId}`,
        `trigger: ${event.trigger}`,
        `capabilities: ${event.capabilities.length > 0 ? event.capabilities.join(", ") : "(none)"}`,
        `at: ${event.at}${turnSuffix}`,
      ].join("\n")
      break
    // ADR-0335 — 8th variant. An "app" mention resolved; the `surface`
    // field labels which quanta environment the app is bound to
    // (CLI / Web-Tauri / CLI-embedded browser) per `memory/surface-model`.
    case "app_activation":
      tag = "app-activation"
      body = [
        `app: ${event.appId}`,
        `surface: ${event.surface}`,
        `trigger: ${event.trigger}`,
        `at: ${event.at}${turnSuffix}`,
      ].join("\n")
      break
    // Audit C-7 — exhaustiveness guard. Adding a new kind to the
    // `TypedHistoryEvent` union without a matching `case` above makes `event`
    // here NOT `never`, so this assignment is a COMPILE error until the new
    // arm is rendered. The throw is the runtime backstop for a forged event
    // whose `kind` is outside the union — it can never emit
    // `embedUntrusted(undefined, undefined)`.
    default: {
      const _exhaustive: never = event
      throw new Error(
        `buildOne: unknown ContextEvent kind: ${(_exhaustive as { kind?: unknown }).kind ?? "(missing)"}`,
      )
    }
  }

  return {
    role: "user",
    content: [{ type: "text", text: embedUntrusted(tag, body) }],
  }
}

/** Build a persistent-injection message list from a typed-event stream.
 *
 *  Pure function: no clock read, no I/O. The caller is responsible for
 *  windowing the event list (e.g. "since previous turn") via
 *  {@link TypedHistoryEventStorePort.since} before passing it in.
 *
 *  Order is preserved (input order = output order).
 */
export const buildPersistentInjectionMessages = (events: readonly ContextEvent[]): Message[] => {
  if (events.length === 0) return []
  return events.map(buildOne)
}
