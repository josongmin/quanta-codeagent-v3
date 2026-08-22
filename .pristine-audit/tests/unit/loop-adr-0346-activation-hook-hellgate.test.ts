/**
 * ADR-0346 — Loop activation-hook hellgate.
 *
 * `resolvePluginActivationForTurn` (the loop-side helper invoked from
 * `prepareTurnContext`) is the trigger that turns ADR-0340's dangling
 * `cfg.activatePlugins?` slot into an actual per-turn behavior. The
 * invariants under test:
 *
 *   1. Absent `cfg.activatePlugins` ⇒ ZERO work, canonical-empty
 *      `resolvedSkills`. The slot reference is the single switch.
 *   2. Empty / missing user text ⇒ activator NOT called (the loop's
 *      mention-injection path uses the same "last user-role text"
 *      derivation; we mirror that gate so non-user-tail turns do nothing).
 *   3. Activator present + no mentions parsed ⇒ activator NOT called.
 *   4. Activator present + mentions parsed ⇒ activator IS called with
 *      mentions + opts.turnId; returned `resolvedSkills` propagate.
 *   5. Activator throws ⇒ swallow, canonical-empty (no break-the-turn).
 *   6. `parseMentions` throws (mocked via patch) ⇒ swallow.
 *   7. Union semantics — when ADR-0346 returns plugin skills, callers
 *      union via `unionActiveSkills(existing, resolved)`; existing wins
 *      on collision, plugin appends fresh names.
 *   8. `turnId` propagates through `opts` parameter verbatim.
 *
 * Test surface is the helper itself (unit-level). The loop.ts wiring is a
 * straight 4-line call site (parse + union into the build call) and is
 * exercised by the smoke battery; isolating the helper here keeps this
 * battery fast and free of streaming-loop machinery.
 */

import { describe, expect, test } from "bun:test"
import { resolvePluginActivationForTurn } from "@/agent/loop-activation-hook"
import type { ParsedMention } from "@/agent/mention-injection"
import type { AggregatedActivation } from "@/agent/plugin-activation-handler"
import { unionActiveSkills } from "@/agent/plugin-skill-extension"

// Helper: a typed activator that records its calls so tests can assert
// what the hook handed downstream. The activator's return is a thunk so
// each test can shape its own `AggregatedActivation`.
type ActivatorCalls = Array<{
  readonly mentions: readonly ParsedMention[]
  readonly opts: { readonly turnId?: string } | undefined
}>

const makeActivator = (
  ret: AggregatedActivation | (() => AggregatedActivation),
): {
  activator: (
    mentions: readonly ParsedMention[],
    opts?: { readonly turnId?: string },
  ) => Promise<AggregatedActivation>
  calls: ActivatorCalls
} => {
  const calls: ActivatorCalls = []
  const activator = async (
    mentions: readonly ParsedMention[],
    opts?: { readonly turnId?: string },
  ): Promise<AggregatedActivation> => {
    calls.push({ mentions, opts })
    return typeof ret === "function" ? ret() : ret
  }
  return { activator, calls }
}

describe("ADR-0346 — resolvePluginActivationForTurn invariants", () => {
  test("(1) absent activatePlugins ⇒ zero work, empty resolvedSkills (legacy passthrough)", async () => {
    const out = await resolvePluginActivationForTurn({}, "anything plugin://foo", "t1")
    expect(out.resolvedSkills).toEqual([])
  })

  test("(2a) activator present + undefined user text ⇒ activator NOT called", async () => {
    const { activator, calls } = makeActivator({ handles: [], resolvedSkills: [] })
    const out = await resolvePluginActivationForTurn(
      { activatePlugins: activator },
      undefined,
      "t1",
    )
    expect(calls.length).toBe(0)
    expect(out.resolvedSkills).toEqual([])
  })

  test("(2b) activator present + empty user text ⇒ activator NOT called", async () => {
    const { activator, calls } = makeActivator({ handles: [], resolvedSkills: [] })
    const out = await resolvePluginActivationForTurn({ activatePlugins: activator }, "", "t1")
    expect(calls.length).toBe(0)
    expect(out.resolvedSkills).toEqual([])
  })

  test("(3) activator present + user text but ZERO mentions parsed ⇒ activator NOT called", async () => {
    const { activator, calls } = makeActivator({ handles: [], resolvedSkills: [] })
    // No `@` / `plugin://` / `#` etc. — parseMentions returns empty.
    const out = await resolvePluginActivationForTurn(
      { activatePlugins: activator },
      "just plain prose with no mention syntax at all",
      "t42",
    )
    expect(calls.length).toBe(0)
    expect(out.resolvedSkills).toEqual([])
  })

  test("(4) activator present + plugin mention ⇒ called with mentions + opts.turnId; resolvedSkills propagate", async () => {
    const { activator, calls } = makeActivator({
      handles: [],
      resolvedSkills: [
        { name: "plugin-skill-a", description: "from plugin foo" },
        { name: "plugin-skill-b", description: "from plugin foo" },
      ],
    })
    const out = await resolvePluginActivationForTurn(
      { activatePlugins: activator },
      "please use plugin://foo to help",
      "t7",
    )
    expect(calls.length).toBe(1)
    expect(calls[0]?.opts).toEqual({ turnId: "t7" })
    // Mentions came from parseMentions — should contain at least one entry.
    expect((calls[0]?.mentions.length ?? 0) > 0).toBe(true)
    expect(out.resolvedSkills).toEqual([
      { name: "plugin-skill-a", description: "from plugin foo" },
      { name: "plugin-skill-b", description: "from plugin foo" },
    ])
  })

  test("(5) activator throws ⇒ swallow, empty resolvedSkills (NO-THROW invariant)", async () => {
    const activator = async (): Promise<AggregatedActivation> => {
      throw new Error("plugin spawn failed")
    }
    const out = await resolvePluginActivationForTurn(
      { activatePlugins: activator },
      "trigger via plugin://x mention",
      "t1",
    )
    expect(out.resolvedSkills).toEqual([])
  })

  test("(6) activator returns malformed shape (no resolvedSkills array) ⇒ defensive empty", async () => {
    const activator = async (): Promise<AggregatedActivation> =>
      // intentionally wrong: missing resolvedSkills array (parser would crash
      // if we trusted the shape blindly). Cast through unknown to avoid
      // a TS guard at the call site.
      ({ handles: [] }) as unknown as AggregatedActivation
    const out = await resolvePluginActivationForTurn(
      { activatePlugins: activator },
      "via plugin://x",
      "t1",
    )
    expect(out.resolvedSkills).toEqual([])
  })

  test("(7) union semantics — existing entries win on name collision, plugin appends fresh", () => {
    // This isn't a direct call on the hook (the hook returns resolvedSkills
    // only; the loop sites the union). We assert the contract the loop
    // depends on so a refactor that changes union order would land here.
    const existing = [
      { name: "alpha", description: "caller-owned" },
      { name: "beta", description: "caller-owned" },
    ]
    const plugin = [
      { name: "alpha", description: "plugin-owned-COLLISION" }, // collides — caller wins
      { name: "gamma", description: "plugin-owned" }, // fresh — appended
    ]
    const merged = unionActiveSkills(existing, plugin)
    expect(merged.map((s) => s.name)).toEqual(["alpha", "beta", "gamma"])
    // Caller wins on collision — alpha's description is the caller's.
    expect(merged.find((s) => s.name === "alpha")?.description).toBe("caller-owned")
    // Plugin-fresh entry carries the plugin's description.
    expect(merged.find((s) => s.name === "gamma")?.description).toBe("plugin-owned")
  })

  test("(8) turnId propagation — when undefined, opts is undefined too (NOT `{ turnId: undefined }`)", async () => {
    const { activator, calls } = makeActivator({ handles: [], resolvedSkills: [] })
    await resolvePluginActivationForTurn(
      { activatePlugins: activator },
      "plugin://x trigger",
      undefined,
    )
    expect(calls.length).toBe(1)
    // Hook MUST omit the field when turnId is undefined so callers using
    // `exactOptionalPropertyTypes` style don't see a stray `turnId: undefined`.
    expect(calls[0]?.opts).toBeUndefined()
  })

  test("(9) byte-identical empty constant — repeated absent-activator calls share the SAME resolvedSkills array reference", async () => {
    // Defence-in-depth: the canonical-empty sentinel is frozen and shared
    // so callers that compare references (legacy passthrough invariant)
    // don't see allocation churn on the default-OFF path.
    const a = await resolvePluginActivationForTurn({}, "anything", "t1")
    const b = await resolvePluginActivationForTurn({}, "different", "t2")
    expect(a.resolvedSkills).toBe(b.resolvedSkills)
    expect(Object.isFrozen(a.resolvedSkills)).toBe(true)
  })
})
