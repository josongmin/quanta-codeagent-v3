/** RFC-02 B3 — generated-file filter (RED rail first).
 *
 *  ATTRIBUTE-ONLY: a file is hidden iff the REPOSITORY declares it generated via
 *  `.gitattributes linguist-generated` (`set` / `true`). There is NO filename,
 *  extension, path, size, or content heuristic — that would be the forbidden
 *  answer-key rule (`no-answer-key-regex-heuristics`).
 *
 *  Anti-vacuity + red-on-injection:
 *    • NUL-triplet parsing survives spaces, tabs, NEWLINES and a leading `-` in
 *      the path (never line-split);
 *    • a `dist/` file WITHOUT the attribute is NOT hidden even with the filter on
 *      (proves we read the declaration, not the name);
 *    • a check-attr PROCESS failure fails CLOSED (typed unavailable), never a
 *      silent "show all" / "hide all".
 */

import { describe, expect, test } from "bun:test"
import type { CheckAttrResult, GeneratedAttributePort } from "@/git"
import { applyGeneratedFilter, parseCheckAttrZ, partitionGenerated } from "@/git"

const ATTR = "linguist-generated"

/** Build a raw `git check-attr -z` stdout: `<path>\0<attr>\0<value>\0` triplets. */
const zOut = (rows: [path: string, value: string][]): string =>
  rows.map(([p, v]) => `${p}\0${ATTR}\0${v}\0`).join("")

const fakePort = (result: CheckAttrResult): GeneratedAttributePort & { calls: string[][] } => {
  const calls: string[][] = []
  return {
    calls,
    async checkAttr(_attr: string, paths: readonly string[]): Promise<CheckAttrResult> {
      calls.push([...paths])
      return result
    },
  }
}

describe("parseCheckAttrZ — NUL triplets, hostile filenames", () => {
  test("parses spaces / tabs / NEWLINES / leading-dash paths (never line-split)", () => {
    const hostile = "a b/with space.js"
    const tabbed = "c\td/tab.js"
    const newlined = "e/multi\nline.js"
    const dashed = "-leading-dash.js"
    const raw = zOut([
      [hostile, "set"],
      [tabbed, "true"],
      [newlined, "unspecified"],
      [dashed, "unset"],
    ])
    const map = parseCheckAttrZ(raw, ATTR)
    expect(map.get(hostile)).toBe("set")
    expect(map.get(tabbed)).toBe("true")
    expect(map.get(newlined)).toBe("unspecified")
    expect(map.get(dashed)).toBe("unset")
    expect(map.size).toBe(4)
  })

  test("ignores a malformed trailing (incomplete) triplet", () => {
    const raw = `${zOut([["ok.js", "set"]])}dangling\0${ATTR}` // missing value + terminator
    const map = parseCheckAttrZ(raw, ATTR)
    expect(map.get("ok.js")).toBe("set")
    expect(map.has("dangling")).toBe(false)
  })
})

describe("partitionGenerated — attribute-only exclusion", () => {
  test("excludes ONLY set/true; retains unspecified/unset/false/absent; preserves order", () => {
    const paths = ["gen1.js", "keep.ts", "gen2.js", "unset.ts", "false.ts", "absent.ts"]
    const map = new Map<string, string>([
      ["gen1.js", "set"],
      ["keep.ts", "unspecified"],
      ["gen2.js", "true"],
      ["unset.ts", "unset"],
      ["false.ts", "false"],
      // absent.ts: no entry at all
    ])
    const { kept, excluded } = partitionGenerated(paths, map)
    expect(excluded).toEqual(["gen1.js", "gen2.js"])
    // Order preserved exactly as input; nothing sorted.
    expect(kept).toEqual(["keep.ts", "unset.ts", "false.ts", "absent.ts"])
  })
})

describe("applyGeneratedFilter — end to end over the port", () => {
  test("declared-generated hidden; undeclared dist/ file SURVIVES (red-on-injection)", async () => {
    const paths = ["dist/bundle.js", "dist/other.js", "src/app.ts"]
    const port = fakePort({
      ok: true,
      stdout: zOut([
        ["dist/bundle.js", "true"], // declared generated
        ["dist/other.js", "unspecified"], // dist/ but NOT declared ⇒ must survive
        ["src/app.ts", "unspecified"],
      ]),
    })
    const res = await applyGeneratedFilter(paths, port)
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error("expected ok")
    expect(res.excluded).toEqual(["dist/bundle.js"])
    expect(res.kept).toEqual(["dist/other.js", "src/app.ts"])
    expect(port.calls[0]).toEqual(paths)
  })

  test("check-attr PROCESS failure ⇒ fail-closed (ok:false), never show/hide all", async () => {
    const res = await applyGeneratedFilter(
      ["a.ts"],
      fakePort({ ok: false, message: "fatal: not a git repository" }),
    )
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.message).toMatch(/not a git repository/)
  })

  test("empty path set ⇒ no port call, empty partition", async () => {
    const port = fakePort({ ok: true, stdout: "" })
    const res = await applyGeneratedFilter([], port)
    expect(res).toEqual({ ok: true, kept: [], excluded: [] })
    expect(port.calls.length).toBe(0)
  })
})
