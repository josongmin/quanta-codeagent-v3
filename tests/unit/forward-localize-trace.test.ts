import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  forwardLocalizeConsumers,
  traceForwardLocalizeOwners,
} from "@/runner/batch/eval/forward-localize-trace"

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

describe("traceForwardLocalizeOwners — real rg consumer resolution (IO wrapper)", () => {
  const writeIn = async (root: string, rel: string, body: string): Promise<void> => {
    const abs = join(root, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, body)
  }

  it("resolves a real consumer file from the sandbox via rg, excluding producer + test files", async () => {
    const root = await mkdtemp(join(tmpdir(), "fwdloc-"))
    try {
      // producer (edited; excluded via alreadyLocalized), a genuine consumer, and a
      // test that also calls the symbol (must be filtered as a non-fix site).
      await writeIn(
        root,
        "pkg/producer.py",
        "def make_client(config):\n    return new_shape(config)\n",
      )
      await writeIn(
        root,
        "pkg/base/client.py",
        "from pkg.producer import make_client\n\nclient = make_client(default_config)\n",
      )
      await writeIn(
        root,
        "pkg/tests/test_client.py",
        "from pkg.producer import make_client\n\ndef test_make_client():\n    assert make_client(None)\n",
      )
      const out = await traceForwardLocalizeOwners({
        patch: PATCH,
        sandbox: root,
        timeoutMs: 15_000,
        alreadyLocalized: ["pkg/producer.py"],
      })
      expect(out).toEqual(["pkg/base/client.py"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("whitespace-only patch ⇒ [] (no rg invoked)", async () => {
    const out = await traceForwardLocalizeOwners({
      patch: "   \n  ",
      sandbox: tmpdir(),
      timeoutMs: 15_000,
    })
    expect(out).toEqual([])
  })
})
