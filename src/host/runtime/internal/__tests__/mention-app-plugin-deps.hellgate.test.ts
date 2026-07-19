/**
 * HELLGATE — `buildAppPluginMentionDeps` (ADR-0336 host wire). Pins the
 * default-OFF byte-identical contract + the ON real-dep build. The resolver
 * itself is covered by `default-resolver-app-plugin.hellgate.test.ts`; this
 * gate covers the HOST side that decides whether the deps flow at all.
 */
import { describe, expect, test } from "bun:test"
import { buildAppPluginMentionDeps } from "../mention-app-plugin-deps"

const CWD = process.cwd()

describe("buildAppPluginMentionDeps — host gate", () => {
  test("OFF (unset) ⇒ empty object, no deps flow (byte-identical)", () => {
    const out = buildAppPluginMentionDeps(CWD, {})
    expect(out).toEqual({})
    expect("plugins" in out).toBe(false)
    expect("apps" in out).toBe(false)
  })

  test("OFF (explicit falsey) ⇒ empty object", () => {
    expect(buildAppPluginMentionDeps(CWD, { QUANTA_MENTION_APP_PLUGIN: "0" })).toEqual({})
    expect(buildAppPluginMentionDeps(CWD, { QUANTA_MENTION_APP_PLUGIN: "" })).toEqual({})
  })

  test("ON ⇒ real PluginRegistryPort + AppCatalogPort (no stub)", () => {
    const out = buildAppPluginMentionDeps(CWD, { QUANTA_MENTION_APP_PLUGIN: "1" }) as {
      plugins?: { list: () => unknown[]; lookup: (id: string) => unknown }
      apps?: { list: () => unknown[] }
    }
    // LOAD-BEARING: ON path yields the two real ports (not undefined) so the
    // resolver's pluginDep/appDep actually flow into the composite.
    expect(typeof out.plugins?.lookup).toBe("function")
    expect(typeof out.apps?.list).toBe("function")
    // the plugin registry is a real (possibly empty) list, never a throw
    expect(Array.isArray(out.plugins?.list())).toBe(true)
    // the built-in app catalog is non-empty (real data, not a stub)
    expect((out.apps?.list().length ?? 0)).toBeGreaterThan(0)
  })

  test("ON with no .quanta/plugins dir ⇒ empty registry, never throws", () => {
    // A cwd with no plugin root must NO-THROW to an empty registry (real
    // 'no plugins found', not a fabricated stub).
    const out = buildAppPluginMentionDeps("/nonexistent-xyz-9x7", {
      QUANTA_MENTION_APP_PLUGIN: "1",
    }) as { plugins?: { list: () => unknown[] } }
    expect(out.plugins?.list()).toEqual([])
  })
})
