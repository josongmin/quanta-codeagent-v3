import { describe, expect, it } from "bun:test"
import { forwardLocalizeConsumers } from "@/runner/batch/eval/forward-localize-trace"

/**
 * T3 forward-localize consumer trace — surfaces consumers a backward localize
 * missed, from the prior candidate's edited symbols.
 */

const PATCH = [
  "diff --git a/pkg/producer.py b/pkg/producer.py",
  "--- a/pkg/producer.py",
  "+++ b/pkg/producer.py",
  "@@ -10,3 +10,3 @@ def make_client(config):",
  "-    return legacy_shape(config)",
  "+    return new_shape(config)",
].join("\n")

const refsFor =
  (map: Record<string, readonly string[]>) =>
  (symbol: string): readonly string[] =>
    map[symbol] ?? []

describe("forwardLocalizeConsumers", () => {
  it("surfaces a consumer file the backward localize missed", () => {
    const out = forwardLocalizeConsumers({
      patch: PATCH,
      findReferences: refsFor({
        make_client: ["pkg/base/client.py", "pkg/producer.py", "tests/test_client.py"],
      }),
      alreadyLocalized: ["pkg/producer.py"],
    })
    // producer.py (already localized) + the test file are excluded; only the
    // consumer base client survives.
    expect(out).toEqual(["pkg/base/client.py"])
  })

  it("excludes the producer's own files and all test files", () => {
    const out = forwardLocalizeConsumers({
      patch: PATCH,
      findReferences: refsFor({
        make_client: ["pkg/producer.py", "tests/test_client.py", "pkg/x/tests/test_y.py"],
      }),
      alreadyLocalized: ["pkg/producer.py"],
    })
    expect(out).toEqual([])
  })

  it("empty patch (no edited symbols) ⇒ no consumers", () => {
    expect(
      forwardLocalizeConsumers({
        patch: "",
        findReferences: refsFor({ make_client: ["pkg/base/client.py"] }),
        alreadyLocalized: [],
      }),
    ).toEqual([])
  })

  it("is bounded by maxFiles and dedups", () => {
    const out = forwardLocalizeConsumers({
      patch: PATCH,
      findReferences: refsFor({
        make_client: ["a.py", "b.py", "a.py", "c.py", "d.py"],
      }),
      alreadyLocalized: [],
      maxFiles: 2,
    })
    expect(out).toEqual(["a.py", "b.py"])
  })

  it("does not re-emit a consumer that was already localized on the prior pass", () => {
    const out = forwardLocalizeConsumers({
      patch: PATCH,
      findReferences: refsFor({
        make_client: ["pkg/base/client.py", "pkg/next_consumer.py"],
      }),
      alreadyLocalized: ["pkg/producer.py", "pkg/base/client.py"],
    })
    expect(out).toEqual(["pkg/next_consumer.py"])
  })
})
