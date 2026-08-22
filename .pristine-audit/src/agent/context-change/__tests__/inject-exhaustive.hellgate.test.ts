/**
 * T05 / audit C-7 — `buildOne`'s switch over the typed-event union must be
 * EXHAUSTIVE.
 *
 * Before this ticket the switch had no `default` and no `never` guard, so
 * `tag`/`body` were declared uninitialized. Adding a new event kind to the
 * union and forgetting to render it would silently build
 * `embedUntrusted(undefined, undefined)` — invalid prompt data, with no
 * compile error.
 *
 * The fix adds `default: { const _exhaustive: never = event; throw … }`. That
 * makes the OMISSION a COMPILE error (a new union arm makes `event` not
 * `never`). This battery is the runtime backstop: a forged event whose `kind`
 * is outside the union throws a typed, named error rather than emitting a
 * corrupt message.
 */

import { describe, expect, test } from "bun:test"
import { buildPersistentInjectionMessages } from "@/agent/context-change/inject"
import type { ContextEvent } from "@/agent/context-change/types"

describe("buildPersistentInjectionMessages — exhaustiveness backstop (C-7)", () => {
  test("an unknown event kind throws (no undefined tag/body silently emitted)", () => {
    // A structurally-forged event whose kind is OUTSIDE the closed union. The
    // exhaustive default must reject it loudly instead of building
    // embedUntrusted(undefined, undefined).
    const forged = { kind: "totally_new_kind", at: 1 } as unknown as ContextEvent
    expect(() => buildPersistentInjectionMessages([forged])).toThrow(
      /Unknown .*kind|totally_new_kind/i,
    )
  })

  test("all 8 current kinds still render exactly one message each (no regression)", () => {
    const events: ContextEvent[] = [
      { kind: "context_update", field: "cwd", prev: "a", next: "b", at: 1 },
      { kind: "mode_change", prev: "plan", next: "edit", at: 2 },
      { kind: "repo_rules_change", addedPaths: ["x"], removedPaths: [], at: 3 },
      { kind: "skill_activation", skillId: "s", trigger: "manual", at: 4 },
      { kind: "reasoning_echo", signature: "sig", redacted: false, at: 5 },
      {
        kind: "compaction_event",
        trigger: "auto",
        reason: "token_pressure",
        tokensBefore: 10,
        tokensAfter: 5,
        messagesRemoved: 2,
        at: 6,
      },
      { kind: "plugin_activation", pluginId: "p", trigger: "mention", capabilities: [], at: 7 },
      {
        kind: "app_activation",
        appId: "app",
        surface: "cli",
        trigger: "mention",
        at: 8,
      },
    ] as unknown as ContextEvent[]
    const msgs = buildPersistentInjectionMessages(events)
    expect(msgs).toHaveLength(8)
    for (const m of msgs) {
      expect(m.role).toBe("user")
      // Each body rendered — no `undefined` leaked into the envelope.
      const text = Array.isArray(m.content)
        ? (m.content[0] as { text?: string }).text
        : String(m.content)
      expect(text).not.toContain("undefined")
    }
  })
})
