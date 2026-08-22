import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import {
  createSessionScopedSignal,
  withSessionScopedSignal,
} from "@/runner/batch/eval/session-signal"

describe("session-scoped signal isolation", () => {
  test("outer abort CASCADES to the inner session signal", () => {
    const outer = new AbortController()
    const session = createSessionScopedSignal(outer.signal)
    expect(session.signal.aborted).toBe(false)
    outer.abort("session-level kill")
    expect(session.signal.aborted).toBe(true)
    expect(session.signal.reason).toBe("session-level kill")
  })

  test("inner abort() does NOT abort the outer (the isolation invariant)", () => {
    const outer = new AbortController()
    const session = createSessionScopedSignal(outer.signal)
    session.abort("per-attempt timeout")
    expect(session.signal.aborted).toBe(true)
    // The whole point: a per-attempt abort must not kill the session.
    expect(outer.signal.aborted).toBe(false)
  })

  test("after inner abort(), a later outer abort does not re-fire onto the (detached) inner", () => {
    const outer = new AbortController()
    const session = createSessionScopedSignal(outer.signal)
    session.abort("first")
    expect(session.signal.reason).toBe("first")
    outer.abort("later session kill")
    // listener was removed on inner abort ⇒ inner reason stays the first one.
    expect(session.signal.reason).toBe("first")
    expect(outer.signal.aborted).toBe(true)
  })

  test("an ALREADY-aborted outer yields an inner born aborted (cascade reason preserved)", () => {
    const outer = new AbortController()
    outer.abort("pre-aborted")
    const session = createSessionScopedSignal(outer.signal)
    expect(session.signal.aborted).toBe(true)
    expect(session.signal.reason).toBe("pre-aborted")
  })

  test("withSessionScopedSignal replaces config.signal and threads into prewarm/lspPrewarm warmSignal", () => {
    const outer = new AbortController()
    const session = createSessionScopedSignal(outer.signal)
    const original = new AbortController().signal
    const config = {
      signal: original,
      prewarm: { enabled: true, warmSignal: original },
      lspPrewarm: { enabled: true, warmSignal: original },
    } as unknown as AgentConfig

    const scoped = withSessionScopedSignal(config, session.signal)

    expect(scoped.signal).toBe(session.signal)
    expect(scoped.signal).not.toBe(original)
    // Prewarm/lspPrewarm warm signals follow the session scope, other fields kept.
    expect((scoped.prewarm as { warmSignal: AbortSignal }).warmSignal).toBe(session.signal)
    expect((scoped.prewarm as { enabled: boolean }).enabled).toBe(true)
    expect((scoped.lspPrewarm as { warmSignal: AbortSignal }).warmSignal).toBe(session.signal)
    expect((scoped.lspPrewarm as { enabled: boolean }).enabled).toBe(true)
  })

  test("withSessionScopedSignal leaves prewarm/lspPrewarm absent when the config had none", () => {
    const session = createSessionScopedSignal(new AbortController().signal)
    const config = { signal: new AbortController().signal } as unknown as AgentConfig
    const scoped = withSessionScopedSignal(config, session.signal)
    expect(scoped.signal).toBe(session.signal)
    expect("prewarm" in scoped).toBe(false)
    expect("lspPrewarm" in scoped).toBe(false)
  })
})
