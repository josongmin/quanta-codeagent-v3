import { describe, expect, it } from "vitest"
import type { DiffLineData } from "../../types/protocol"
import { groupHunks } from "./diff-hunks"

const u = (content: string): DiffLineData => ({ type: "unchanged", content })
const add = (content: string): DiffLineData => ({ type: "added", content })
const del = (content: string): DiffLineData => ({ type: "removed", content })

describe("groupHunks", () => {
  it("returns [] for empty input (never throws)", () => {
    expect(groupHunks([])).toEqual([])
  })

  it("keeps contextLines of unchanged context visible around a change", () => {
    //          idx: 0    1    2    3       4    5    6
    const lines = [u("a"), u("b"), u("c"), add("d"), u("e"), u("f"), u("g")]
    const hunks = groupHunks(lines, 1)
    // contextLines=1 around the change at idx 3 ⇒ visible window [2,4] = c,d,e.
    // a,b fold (before); f,g fold (after).
    expect(hunks).toHaveLength(3)
    expect(hunks[0]?.collapsed).toBe(true) // a,b
    expect(hunks[1]?.collapsed).toBe(false) // c,d,e
    expect(hunks[2]?.collapsed).toBe(true) // f,g
    expect(hunks[1]?.lines.map((l) => l.content)).toEqual(["c", "d", "e"])
    expect(hunks[0]?.lines.map((l) => l.content)).toEqual(["a", "b"])
  })

  it("folds a long interior unchanged run into a collapsed hunk", () => {
    const lines = [
      add("change1"),
      u("x1"),
      u("x2"),
      u("x3"),
      u("x4"),
      u("x5"),
      u("x6"),
      u("x7"),
      u("x8"),
      del("change2"),
    ]
    const hunks = groupHunks(lines, 2)
    // change1 + 2 ctx visible, change2 + 2 ctx visible, middle folds.
    const collapsed = hunks.filter((h) => h.collapsed)
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]?.lines.every((l) => l.type === "unchanged")).toBe(true)
  })

  it("returns a single collapsed hunk when everything is unchanged", () => {
    const lines = [u("a"), u("b"), u("c")]
    const hunks = groupHunks(lines, 3)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]?.collapsed).toBe(true)
    expect(hunks[0]?.lines).toHaveLength(3)
  })

  it("does not fold when there is no change but the run is short (still 1 collapsed)", () => {
    // all-unchanged ⇒ single collapsed hunk regardless of length (RFC §4.1.2).
    const hunks = groupHunks([u("only")], 3)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]?.collapsed).toBe(true)
  })

  it("with contextLines=0, no unchanged lines stay visible (all fold)", () => {
    const lines = [u("a"), add("b"), u("c")]
    const hunks = groupHunks(lines, 0)
    // only the changed line is visible; a and c fold.
    const visible = hunks.filter((h) => !h.collapsed)
    expect(visible).toHaveLength(1)
    expect(visible[0]?.lines.map((l) => l.content)).toEqual(["b"])
  })

  it("with a huge contextLines, everything around the change stays visible", () => {
    const lines = [u("a"), u("b"), add("c"), u("d"), u("e")]
    const hunks = groupHunks(lines, 100)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]?.collapsed).toBe(false)
    expect(hunks[0]?.lines).toHaveLength(5)
  })

  it("is deterministic: same input ⇒ same split", () => {
    const lines = [u("a"), add("b"), u("c"), u("d"), u("e"), del("f")]
    expect(groupHunks(lines, 1)).toEqual(groupHunks(lines, 1))
  })
})
