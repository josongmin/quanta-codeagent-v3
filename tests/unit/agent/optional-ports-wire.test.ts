import { describe, expect, test } from "bun:test"
import { defaultRoleModelResolver } from "@/llm/role-model-override"
import { wireOptionalAgentPorts } from "@/agent/optional-ports"

const base = () => ({
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
