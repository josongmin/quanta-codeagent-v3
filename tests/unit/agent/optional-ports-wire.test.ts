import { describe, expect, spyOn, test } from "bun:test"
import { __resetCloseoutCriticWarning, wireOptionalAgentPorts } from "@/agent/optional-ports"
import type { AgentConfig } from "@/agent/types"
import { defaultRoleModelResolver } from "@/llm/role-model-override"
import { logger } from "@/shared"

const base = (): Partial<AgentConfig> & Pick<AgentConfig, "llm" | "signal"> => ({
  llm: {
    model: "test-model",
    async *stream() {},
  },
  signal: new AbortController().signal,
})

describe("wireOptionalAgentPorts", () => {
  test("default-OFF leaves optional ports absent", () => {
    const wired = wireOptionalAgentPorts(base(), {})

    expect(wired.roleModelResolver).toBeUndefined()
    expect(wired.fastApplyFallback).toBeUndefined()
    expect(wired.effortClassifier).toBeUndefined()
  })

  test("QUANTA_FAST_APPLY=on injects a session-scoped role resolver and fast-apply fallback", () => {
    const wired = wireOptionalAgentPorts(base(), { QUANTA_FAST_APPLY: "on" })

    expect(wired.roleModelResolver).toBeDefined()
    expect(wired.fastApplyFallback).toBeDefined()
    expect(wired.effortClassifier).toBeUndefined()
  })

  test("pre-wired roleModelResolver is preserved verbatim", () => {
    const resolver = defaultRoleModelResolver({ executor: "executor-fast" })
    const wired = wireOptionalAgentPorts(
      {
        ...base(),
        roleModelResolver: resolver,
      },
      { QUANTA_FAST_APPLY: "on" },
    )

    expect(wired.roleModelResolver).toBe(resolver)
    expect(wired.roleModelResolver?.resolve("executor", "fallback-model")).toBe("executor-fast")
  })

  test("QUANTA_EFFORT_AUTO=on injects only the classifier", () => {
    const wired = wireOptionalAgentPorts(base(), { QUANTA_EFFORT_AUTO: "on" })

    expect(wired.roleModelResolver).toBeUndefined()
    expect(wired.fastApplyFallback).toBeUndefined()
    expect(wired.effortClassifier).toBeDefined()
  })
})

describe("closeout-critic wire — knob on but no reviewer (config.subagent absent)", () => {
  test("knob ON + no subagent ⇒ fail-open (no critic port) + warns AT MOST once across repeated wires", () => {
    __resetCloseoutCriticWarning()
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      // base() carries no `subagent`, so no reviewer can be materialized.
      const a = wireOptionalAgentPorts(base(), { QUANTA_CLOSEOUT_CRITIC: "1" })
      const b = wireOptionalAgentPorts(base(), { QUANTA_CLOSEOUT_CRITIC: "1" })
      // Fail-open: no critic port is injected (byte-identical completion path).
      expect(a.closeoutCritic?.critic).toBeUndefined()
      expect(b.closeoutCritic?.critic).toBeUndefined()
      // Visible but NOT spammy — the process-scoped guard collapses the repeat.
      const closeoutWarns = warn.mock.calls.filter((c) =>
        String(c[0]).includes("closeout critic will not run"),
      )
      expect(closeoutWarns).toHaveLength(1)
    } finally {
      warn.mockRestore()
      __resetCloseoutCriticWarning()
    }
  })

  test("wire ORDER: a subagent tool gate that CREATES subagent ⇒ critic still materializes (no false drop/warn)", () => {
    // Regression for the wire-order bug: `wireCloseoutCritic` must run AFTER the
    // subagent tool gates. `QUANTA_SUBAGENT_FOLLOWUP=on` creates `next.subagent`;
    // the critic's reviewer is materialized FROM `config.subagent`. If the critic
    // wired BEFORE the gate (the bug), the critic was silently dropped + a false
    // "no subagent" warning fired even though subagent ends up present.
    __resetCloseoutCriticWarning()
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      const out = wireOptionalAgentPorts(base(), {
        QUANTA_CLOSEOUT_CRITIC: "1",
        QUANTA_SUBAGENT_FOLLOWUP: "on",
      })
      // The followup gate created subagent...
      expect(out.subagent).toBeDefined()
      // ...so the critic MUST materialize (not dropped by stale ordering).
      expect(out.closeoutCritic?.critic).toBeDefined()
      // ...and NO false "no subagent" warning fired.
      const closeoutWarns = warn.mock.calls.filter((c) =>
        String(c[0]).includes("closeout critic will not run"),
      )
      expect(closeoutWarns).toHaveLength(0)
    } finally {
      warn.mockRestore()
      __resetCloseoutCriticWarning()
    }
  })

  test("knob OFF ⇒ NO warning, no critic (byte-identical default)", () => {
    __resetCloseoutCriticWarning()
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      const wired = wireOptionalAgentPorts(base(), {})
      expect(wired.closeoutCritic?.critic).toBeUndefined()
      const closeoutWarns = warn.mock.calls.filter((c) => String(c[0]).includes("closeout critic"))
      expect(closeoutWarns).toHaveLength(0)
    } finally {
      warn.mockRestore()
      __resetCloseoutCriticWarning()
    }
  })
})
