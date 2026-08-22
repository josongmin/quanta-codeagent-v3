/**
 * HELLGATE RED battery for the OwnerRefuter SEAM + its deterministic fake
 * (jul-6, Stream S1). The seam is the engine-adapter port real semantica will
 * implement; the fake is a table-driven, deterministic stand-in for tests.
 *
 * Pinned: table lookup by (file, symbol); an unknown target returns `null`
 * (NO facts — the critic maps that to `inconclusive`, never invents facts);
 * determinism (same query ⇒ same GraphFacts).
 */

import { describe, expect, test } from "bun:test"
import type { EditTarget } from "@/agent/observation/critic"
import { type GraphFacts, makeFakeOwnerRefuter } from "@/agent/observation/critic/refuter"
import type { TaskContext } from "@/agent/observation/port"

const ctx = (): TaskContext => ({ cwd: "/repo", issueText: "x", repoFiles: [] })

const facts = (t: EditTarget, reachable: boolean): GraphFacts => ({
  target: t,
  reachableFromEntrypoints: reachable,
  shadowedByOverride: false,
  staticallyComplete: true,
})

describe("makeFakeOwnerRefuter — deterministic table adapter", () => {
  test("returns the facts registered for a (file, symbol) target", async () => {
    const t: EditTarget = { file: "a.py", symbol: "f" }
    const refuter = makeFakeOwnerRefuter([facts(t, false)])
    const g = await refuter.query(t, ctx())
    expect(g).not.toBeNull()
    expect(g?.reachableFromEntrypoints).toBe(false)
  })

  test("distinguishes symbols within the same file", async () => {
    const f = facts({ file: "a.py", symbol: "f" }, false)
    const g = facts({ file: "a.py", symbol: "g" }, true)
    const refuter = makeFakeOwnerRefuter([f, g])
    expect(
      (await refuter.query({ file: "a.py", symbol: "f" }, ctx()))?.reachableFromEntrypoints,
    ).toBe(false)
    expect(
      (await refuter.query({ file: "a.py", symbol: "g" }, ctx()))?.reachableFromEntrypoints,
    ).toBe(true)
  })

  test("distinguishes file-level (no symbol) from symbol-level targets", async () => {
    const fileLevel = facts({ file: "a.py" }, true)
    const symLevel = facts({ file: "a.py", symbol: "f" }, false)
    const refuter = makeFakeOwnerRefuter([fileLevel, symLevel])
    expect((await refuter.query({ file: "a.py" }, ctx()))?.reachableFromEntrypoints).toBe(true)
    expect(
      (await refuter.query({ file: "a.py", symbol: "f" }, ctx()))?.reachableFromEntrypoints,
    ).toBe(false)
  })

  test("UNKNOWN target ⇒ null (the fake invents no facts)", async () => {
    const refuter = makeFakeOwnerRefuter([facts({ file: "a.py", symbol: "f" }, false)])
    expect(await refuter.query({ file: "z.py", symbol: "q" }, ctx())).toBeNull()
  })

  test("deterministic: same query twice ⇒ identical facts", async () => {
    const t: EditTarget = { file: "a.py", symbol: "f" }
    const refuter = makeFakeOwnerRefuter([facts(t, false)])
    expect(await refuter.query(t, ctx())).toEqual(await refuter.query(t, ctx()))
  })
})
