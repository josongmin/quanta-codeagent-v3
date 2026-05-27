import { describe, expect, test } from "bun:test"
import { defaultResponsesContinuationStore } from "@/llm"

describe("ResponsesContinuationStore", () => {
  test("route-level resume disable persists across clear(route) and resets on clearAll()", () => {
    const store = defaultResponsesContinuationStore()

    expect(store.canResume("lane-1")).toBe(true)
    store.markResumeUnsupported("lane-1")
    expect(store.canResume("lane-1")).toBe(false)

    store.clear("lane-1")
    expect(store.canResume("lane-1")).toBe(false)

    store.clearAll()
    expect(store.canResume("lane-1")).toBe(true)
  })
})
