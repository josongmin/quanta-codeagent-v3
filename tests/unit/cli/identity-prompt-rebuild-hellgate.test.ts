/**
 * Hellgate — ADR-0302 `/identity` mid-session system-prompt rebuild.
 *
 * Closes the last-mile gap from ADR-0291: today `/identity set foo`
 * mutates the surface's active mode cell, but the LLM keeps seeing the
 * OLD system prompt captured once at session bootstrap. The new
 * `SystemPromptRebuilderPort` + `SystemSource` + adapter `onChange`
 * callback chain refreshes the per-turn `AgentConfig.system` on the
 * NEXT turn.
 *
 * Adversarial coverage (10+ cases, ≥10 expects):
 *   1. rebuilder honours the live mode closure (default snapshot).
 *   2. closure change between calls is reflected on rebuild().
 *   3. baseBuilder throws → typed fallback prefix, no re-throw.
 *   4. baseBuilder throws non-Error → string-coerced reason, no throw.
 *   5. baseBuilder fallback never embeds raw \n / \r in the result.
 *   6. SystemSource get returns the seed; set/get round-trips.
 *   7. SystemSource set is idempotent on equal value (re-set of same
 *      string does not corrupt the cell — explicit `===` short-circuit).
 *   8. SystemSource set to a new value replaces the previous read.
 *   9. Adapter with onChange: set("plan") fires onChange exactly once
 *      with `"plan"`.
 *  10. Adapter onChange NOT fired when set() rejects an unknown mode.
 *  11. Adapter built WITHOUT onChange: set() still works AND nothing
 *      else changes (back-compat — byte-identical to ADR-0291).
 *  12. End-to-end composition: rebuilder + systemSource + adapter — a
 *      `set("review")` swaps the live mode and the next `rebuilder.rebuild()`
 *      + `systemSource.set(...)` makes `systemSource.get()` return the
 *      review-flavoured prompt.
 *  13. Adapter onChange that throws does NOT bubble back to the slash
 *      caller — adapter swallows so `/identity` never regresses to a 1
 *      exit because the rebuilder hiccupped.
 *  14. `list()` is the closed `MODE_VARIANT_KEYS` and never includes a
 *      mode the registry would reject — keeps `/identity` help honest.
 */
import { describe, expect, test } from "bun:test"
import {
  MODE_VARIANT_KEYS,
  type ModeVariantKey,
  type SystemPromptVariantRegistry,
} from "@/agent/system-prompt"
import {
  createSystemPromptRebuilder,
  createSystemSource,
  SYSTEM_PROMPT_REBUILD_FALLBACK_PREFIX,
} from "@/runner/assemble"
import { buildIdentityModeAdapter } from "../../../src/apps/cli/repl/ctx-adapters/identity-mode-adapter"

const fakeRegistry: SystemPromptVariantRegistry = {
  variantFor: (mode) => ({ mode, identity: [`identity-for-${mode}`] }),
}

const builder = (mode: ModeVariantKey | undefined, cwd: string): string =>
  `SYS(cwd=${cwd}, mode=${mode ?? "<undef>"})`

describe("ADR-0302 — system-prompt rebuilder", () => {
  test("HELL-0302-01: rebuild() reflects the snapshot mode", () => {
    const r = createSystemPromptRebuilder({
      mode: () => "plan",
      cwd: "/tmp/x",
      baseBuilder: builder,
    })
    expect(r.rebuild()).toBe("SYS(cwd=/tmp/x, mode=plan)")
  })

  test("HELL-0302-02: closure change is observed by next rebuild()", () => {
    let active: ModeVariantKey | undefined = "default"
    const r = createSystemPromptRebuilder({
      mode: () => active,
      cwd: "/tmp/x",
      baseBuilder: builder,
    })
    expect(r.rebuild()).toContain("mode=default")
    active = "audit"
    expect(r.rebuild()).toContain("mode=audit")
  })

  test("HELL-0302-03: baseBuilder throws → typed fallback, no re-throw", () => {
    const r = createSystemPromptRebuilder({
      mode: () => "plan",
      cwd: "/tmp/x",
      baseBuilder: () => {
        throw new Error("kaboom")
      },
    })
    const out = r.rebuild()
    expect(out.startsWith(SYSTEM_PROMPT_REBUILD_FALLBACK_PREFIX)).toBe(true)
    expect(out).toContain("kaboom")
  })

  test("HELL-0302-04: baseBuilder throws non-Error → coerced, no throw", () => {
    const r = createSystemPromptRebuilder({
      mode: () => "plan",
      cwd: "/tmp/x",
      baseBuilder: () => {
        throw "not-an-error-instance"
      },
    })
    const out = r.rebuild()
    expect(out.startsWith(SYSTEM_PROMPT_REBUILD_FALLBACK_PREFIX)).toBe(true)
    expect(out).toContain("not-an-error-instance")
  })

  test("HELL-0302-05: fallback strips newlines from reason (no prefix forgery)", () => {
    const r = createSystemPromptRebuilder({
      mode: () => "plan",
      cwd: "/tmp/x",
      baseBuilder: () => {
        throw new Error("line1\nline2\rline3")
      },
    })
    const out = r.rebuild()
    expect(out).not.toContain("\n")
    expect(out).not.toContain("\r")
  })
})

describe("ADR-0302 — SystemSource cell", () => {
  test("HELL-0302-06: createSystemSource seeds + round-trips set/get", () => {
    const s = createSystemSource("init")
    expect(s.get()).toBe("init")
    s.set("new")
    expect(s.get()).toBe("new")
  })

  test("HELL-0302-07: set is idempotent on equal value", () => {
    const s = createSystemSource("x")
    s.set("x")
    expect(s.get()).toBe("x")
    s.set("x")
    expect(s.get()).toBe("x")
  })

  test("HELL-0302-08: set to a different value replaces the read", () => {
    const s = createSystemSource("a")
    s.set("b")
    expect(s.get()).toBe("b")
    s.set("c")
    expect(s.get()).toBe("c")
  })
})

describe("ADR-0302 — identity-mode adapter onChange", () => {
  test("HELL-0302-09: set('plan') fires onChange('plan') exactly once", () => {
    const calls: ModeVariantKey[] = []
    const a = buildIdentityModeAdapter({
      registry: fakeRegistry,
      onChange: (m) => calls.push(m),
    })
    const res = a.set("plan")
    expect(res).toBe("ok")
    expect(calls).toEqual(["plan"])
    expect(a.get()).toBe("plan")
  })

  test("HELL-0302-10: onChange NOT fired when set() rejects unknown mode", () => {
    const calls: ModeVariantKey[] = []
    const a = buildIdentityModeAdapter({
      registry: fakeRegistry,
      defaultMode: "default",
      onChange: (m) => calls.push(m),
    })
    const res = a.set("ghost-mode")
    expect(res).not.toBe("ok")
    expect(calls).toEqual([])
    expect(a.get()).toBe("default")
  })

  test("HELL-0302-11: adapter built WITHOUT onChange is byte-identical to ADR-0291", () => {
    const a = buildIdentityModeAdapter({ registry: fakeRegistry })
    expect(a.get()).toBe("default")
    expect(a.set("plan")).toBe("ok")
    expect(a.get()).toBe("plan")
    expect(a.list()).toEqual(MODE_VARIANT_KEYS)
    const bad = a.set("zzz")
    expect(bad).not.toBe("ok")
  })

  test("HELL-0302-12: end-to-end — set('review') → rebuilder → systemSource get reflects new prompt", () => {
    const source = createSystemSource("INITIAL")
    let active: ModeVariantKey = "default"
    const rebuilder = createSystemPromptRebuilder({
      mode: () => active,
      cwd: "/tmp/cwd",
      baseBuilder: builder,
    })
    const adapter = buildIdentityModeAdapter({
      registry: fakeRegistry,
      onChange: (m) => {
        active = m
        source.set(rebuilder.rebuild())
      },
    })
    // Before the swap, the source still holds the bootstrap-time string.
    expect(source.get()).toBe("INITIAL")
    expect(adapter.set("review")).toBe("ok")
    // After the swap, the source mirrors the NEW prompt.
    expect(source.get()).toBe("SYS(cwd=/tmp/cwd, mode=review)")
    // And another swap takes effect identically.
    expect(adapter.set("audit")).toBe("ok")
    expect(source.get()).toBe("SYS(cwd=/tmp/cwd, mode=audit)")
  })

  test("HELL-0302-13: onChange that throws does NOT bubble to the caller", () => {
    const a = buildIdentityModeAdapter({
      registry: fakeRegistry,
      onChange: () => {
        throw new Error("rebuilder exploded")
      },
    })
    // The set MUST still report "ok" and the cell MUST still update.
    expect(() => a.set("plan")).not.toThrow()
    expect(a.set("audit")).toBe("ok")
    expect(a.get()).toBe("audit")
  })

  test("HELL-0302-14: list() == closed MODE_VARIANT_KEYS (help honest)", () => {
    const a = buildIdentityModeAdapter({ registry: fakeRegistry })
    const list = a.list()
    expect(list).toEqual(MODE_VARIANT_KEYS)
    // Every key in list() MUST be acceptable to set().
    for (const k of list) {
      expect(a.set(k)).toBe("ok")
    }
  })

  test("HELL-0302-15: onChange fires once per accepted swap even on idempotent set", () => {
    const calls: ModeVariantKey[] = []
    const a = buildIdentityModeAdapter({
      registry: fakeRegistry,
      onChange: (m) => calls.push(m),
    })
    // Two distinct swaps + one idempotent re-set of the SAME mode.
    expect(a.set("plan")).toBe("ok")
    expect(a.set("plan")).toBe("ok")
    expect(a.set("audit")).toBe("ok")
    // The adapter does NOT short-circuit on same value (cheap path); each
    // accepted set fires onChange. The SystemSource itself is what short-
    // circuits the downstream allocate. That separation is intentional —
    // it lets the surface decide whether to skip the rebuild or not.
    expect(calls).toEqual(["plan", "plan", "audit"])
  })
})
