/**
 * Hellgate — parseDomModel fail-closed EXTREME (ADR-0427, Wave 2).
 *
 * The page is attacker-controlled: every output of `Runtime.evaluate` is hostile
 * until proven shape-correct. This battery hammers the trust boundary with
 * adversarial raw payloads (wrong top-level types, malformed JSON, poisoned keys,
 * deep single-bad-node trees, cap overflow with multibyte data). Every deny case
 * is paired with a passing control so a constant-return / always-ok mutation in
 * `parseDomModel` cannot survive.
 *
 * All cases are pure (no I/O, no clock) — the parser is a referentially
 * transparent core over `unknown`.
 */

import { describe, expect, test } from "bun:test"
import { NAME_CAP, parseDomModel, VALUE_CAP } from "@/browser/cdp/collect"

// A minimal valid leaf node (no children) used to compose controls.
const leaf = (over: Record<string, unknown> = {}) => ({
  backendPath: "/0",
  role: "button",
  name: "Go",
  ...over,
})

// A minimal valid model used as the baseline control everywhere.
const validModel = () => ({
  title: "Home",
  root: {
    backendPath: "/",
    role: "document",
    name: "Home",
    children: [leaf()],
  },
})

describe("HELLGATE parse EXTREME — top-level raw type", () => {
  // CONTROL: the canonical valid model must always parse, or a constant-false
  // mutation is masked.
  test("HELL-EX-00: control valid model ⇒ ok", () => {
    const r = parseDomModel(validModel())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.title).toBe("Home")
      expect(r.value.root.role).toBe("document")
      expect(r.value.root.children?.[0]?.name).toBe("Go")
    }
  })

  test("HELL-EX-01: raw null / undefined ⇒ malformed", () => {
    expect(parseDomModel(null).ok).toBe(false)
    expect(parseDomModel(undefined).ok).toBe(false)
    // control: object form still ok
    expect(parseDomModel(validModel()).ok).toBe(true)
  })

  test("HELL-EX-02: raw number / boolean ⇒ malformed", () => {
    expect(parseDomModel(42).ok).toBe(false)
    expect(parseDomModel(0).ok).toBe(false)
    expect(parseDomModel(Number.NaN).ok).toBe(false)
    expect(parseDomModel(true).ok).toBe(false)
    expect(parseDomModel(false).ok).toBe(false)
    expect(parseDomModel(validModel()).ok).toBe(true) // control
  })

  test("HELL-EX-03: raw array (typeof object, but not a model) ⇒ malformed", () => {
    // arrays are `typeof === 'object'` — they must still fail (no title/root).
    expect(parseDomModel([]).ok).toBe(false)
    expect(parseDomModel([validModel()]).ok).toBe(false)
    expect(parseDomModel(validModel()).ok).toBe(true) // control
  })

  test("HELL-EX-04: empty string ⇒ malformed (JSON.parse throws)", () => {
    expect(parseDomModel("").ok).toBe(false)
    // control: a stringified valid model parses identically to the object.
    expect(parseDomModel(JSON.stringify(validModel())).ok).toBe(true)
  })

  test("HELL-EX-05: bad json '{' / truncated ⇒ malformed", () => {
    expect(parseDomModel("{").ok).toBe(false)
    expect(parseDomModel("{ title: ").ok).toBe(false)
    expect(parseDomModel("not json at all").ok).toBe(false)
    expect(parseDomModel(JSON.stringify(validModel())).ok).toBe(true) // control
  })

  test("HELL-EX-06: valid JSON but not an object ⇒ malformed", () => {
    // JSON.parse succeeds, but the parsed value is a primitive / array.
    expect(parseDomModel("123").ok).toBe(false)
    expect(parseDomModel("true").ok).toBe(false)
    expect(parseDomModel("null").ok).toBe(false)
    expect(parseDomModel('"a string"').ok).toBe(false)
    expect(parseDomModel("[1,2,3]").ok).toBe(false)
    expect(parseDomModel(JSON.stringify(validModel())).ok).toBe(true) // control
  })
})

describe("HELLGATE parse EXTREME — title", () => {
  test("HELL-EX-07: missing title ⇒ malformed", () => {
    const { root } = validModel()
    expect(parseDomModel({ root }).ok).toBe(false)
    expect(parseDomModel({ title: "ok", root }).ok).toBe(true) // control
  })

  test("HELL-EX-08: title not a string (number/null/object/bool) ⇒ malformed", () => {
    const { root } = validModel()
    expect(parseDomModel({ title: 7, root }).ok).toBe(false)
    expect(parseDomModel({ title: null, root }).ok).toBe(false)
    expect(parseDomModel({ title: { a: 1 }, root }).ok).toBe(false)
    expect(parseDomModel({ title: true, root }).ok).toBe(false)
    expect(parseDomModel({ title: [], root }).ok).toBe(false)
    expect(parseDomModel({ title: "real", root }).ok).toBe(true) // control
  })
})

describe("HELLGATE parse EXTREME — root shape", () => {
  test("HELL-EX-09: missing root ⇒ malformed", () => {
    expect(parseDomModel({ title: "x" }).ok).toBe(false)
    expect(parseDomModel(validModel()).ok).toBe(true) // control
  })

  test("HELL-EX-10: root not an object (string/number/array/null) ⇒ malformed", () => {
    expect(parseDomModel({ title: "x", root: "nope" }).ok).toBe(false)
    expect(parseDomModel({ title: "x", root: 5 }).ok).toBe(false)
    expect(parseDomModel({ title: "x", root: null }).ok).toBe(false)
    expect(parseDomModel({ title: "x", root: [] }).ok).toBe(false)
    expect(parseDomModel(validModel()).ok).toBe(true) // control
  })

  test("HELL-EX-11: root missing backendPath ⇒ malformed", () => {
    expect(parseDomModel({ title: "x", root: { role: "r", name: "n" } }).ok).toBe(false)
    // control: add the field back ⇒ ok
    expect(parseDomModel({ title: "x", root: { backendPath: "/", role: "r", name: "n" } }).ok).toBe(
      true,
    )
  })

  test("HELL-EX-12: root missing role ⇒ malformed", () => {
    expect(parseDomModel({ title: "x", root: { backendPath: "/", name: "n" } }).ok).toBe(false)
    expect(parseDomModel({ title: "x", root: { backendPath: "/", role: "r", name: "n" } }).ok).toBe(
      true,
    ) // control
  })

  test("HELL-EX-13: root missing name ⇒ malformed", () => {
    expect(parseDomModel({ title: "x", root: { backendPath: "/", role: "r" } }).ok).toBe(false)
    expect(parseDomModel({ title: "x", root: { backendPath: "/", role: "r", name: "n" } }).ok).toBe(
      true,
    ) // control
  })

  test("HELL-EX-14: required fields present but wrong type ⇒ malformed", () => {
    // backendPath/role/name each must be a *string*, not merely present.
    expect(parseDomModel({ title: "x", root: { backendPath: 1, role: "r", name: "n" } }).ok).toBe(
      false,
    )
    expect(parseDomModel({ title: "x", root: { backendPath: "/", role: 2, name: "n" } }).ok).toBe(
      false,
    )
    expect(
      parseDomModel({ title: "x", root: { backendPath: "/", role: "r", name: null } }).ok,
    ).toBe(false)
    expect(parseDomModel({ title: "x", root: { backendPath: "/", role: "r", name: "n" } }).ok).toBe(
      true,
    ) // control
  })
})

describe("HELLGATE parse EXTREME — deep tree single bad node", () => {
  // Build a chain of depth N where the deepest node is valid (control) or has a
  // single defect (one required field wrong/absent) that must reject the WHOLE
  // tree, not just the subtree.
  const chain = (depth: number, deepest: Record<string, unknown>): Record<string, unknown> => {
    let node: Record<string, unknown> = deepest
    for (let i = depth - 1; i >= 0; i--) {
      node = { backendPath: `/${i}`, role: "group", name: `lvl${i}`, children: [node] }
    }
    return { title: "deep", root: node }
  }

  test("HELL-EX-15: deep VALID chain (5 levels) ⇒ ok (control)", () => {
    const good = chain(5, { backendPath: "/leaf", role: "button", name: "click" })
    const r = parseDomModel(good)
    expect(r.ok).toBe(true)
    if (r.ok) {
      // descend to confirm the structure survived intact
      let cur = r.value.root
      for (let i = 0; i < 5; i++) {
        expect(cur.children?.length).toBe(1)
        cur = cur.children?.[0] as typeof cur
      }
      expect(cur.name).toBe("click")
    }
  })

  test("HELL-EX-16: ONE bad node 5 levels down ⇒ whole tree rejected", () => {
    // deepest node lacks `name` ⇒ asNode null ⇒ parseChildren null bubbles up.
    const bad = chain(5, { backendPath: "/leaf", role: "button" })
    expect(parseDomModel(bad).ok).toBe(false)
    // sibling control: same depth, valid deepest ⇒ ok
    expect(parseDomModel(chain(5, { backendPath: "/leaf", role: "button", name: "ok" })).ok).toBe(
      true,
    )
  })

  test("HELL-EX-17: bad node deep, wrong-typed field ⇒ whole tree rejected", () => {
    const bad = chain(5, { backendPath: "/leaf", role: 99, name: "x" })
    expect(parseDomModel(bad).ok).toBe(false)
    expect(parseDomModel(chain(5, { backendPath: "/leaf", role: "ok", name: "x" })).ok).toBe(true)
  })
})

describe("HELLGATE parse EXTREME — children shape", () => {
  const withChildren = (children: unknown) => ({
    title: "x",
    root: { backendPath: "/", role: "document", name: "n", children },
  })

  test("HELL-EX-18: children not an array (string/number/object) ⇒ treated as no children, ok", () => {
    // parseChildren returns [] for non-arrays (fail-open-to-empty, fail-closed
    // on bad elements). So a non-array `children` is tolerated as "no children".
    for (const c of ["str", 7, { a: 1 }, true]) {
      const r = parseDomModel(withChildren(c))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value.root.children).toBeUndefined()
    }
    // control: a real array of valid kids is preserved
    const r = parseDomModel(withChildren([leaf()]))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.root.children?.length).toBe(1)
  })

  test("HELL-EX-19: one child null in the array ⇒ whole tree rejected", () => {
    expect(parseDomModel(withChildren([leaf(), null])).ok).toBe(false)
    expect(parseDomModel(withChildren([null, leaf()])).ok).toBe(false)
    // control: drop the null ⇒ ok
    expect(parseDomModel(withChildren([leaf(), leaf({ backendPath: "/1" })])).ok).toBe(true)
  })

  test("HELL-EX-20: one child a primitive / array in the array ⇒ rejected", () => {
    expect(parseDomModel(withChildren([leaf(), 5])).ok).toBe(false)
    expect(parseDomModel(withChildren([leaf(), "str"])).ok).toBe(false)
    expect(parseDomModel(withChildren([leaf(), []])).ok).toBe(false)
    expect(parseDomModel(withChildren([leaf()])).ok).toBe(true) // control
  })

  test("HELL-EX-21: empty children array ⇒ ok, children stripped", () => {
    const r = parseDomModel(withChildren([]))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.root.children).toBeUndefined()
  })
})

describe("HELLGATE parse EXTREME — caps incl. multibyte", () => {
  test("HELL-EX-22: name/value/placeholder over caps truncated", () => {
    const hugeName = "a".repeat(NAME_CAP + 500)
    const hugeVal = "b".repeat(VALUE_CAP + 500)
    const m = {
      title: "t".repeat(NAME_CAP + 500),
      root: {
        backendPath: "/",
        role: "textbox",
        name: hugeName,
        value: hugeVal,
        placeholder: "p".repeat(NAME_CAP + 500),
      },
    }
    const r = parseDomModel(m)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.title.length).toBe(NAME_CAP)
      expect(r.value.root.name.length).toBe(NAME_CAP)
      expect(r.value.root.value?.length).toBe(VALUE_CAP)
      expect(r.value.root.placeholder?.length).toBe(NAME_CAP)
    }
    // control: short strings pass through untouched
    const small = parseDomModel({
      title: "hi",
      root: { backendPath: "/", role: "textbox", name: "nm", value: "vv", placeholder: "ph" },
    })
    expect(small.ok).toBe(true)
    if (small.ok) {
      expect(small.value.root.name).toBe("nm")
      expect(small.value.root.value).toBe("vv")
      expect(small.value.root.placeholder).toBe("ph")
    }
  })

  test("HELL-EX-23: 300 emoji ⇒ capped by code units, .length <= cap", () => {
    // "😀" is 2 UTF-16 code units, so 300 of them = 600 .length. cap() slices by
    // .length, so the result must be <= the cap (no overflow past the boundary).
    const emoji = "😀".repeat(300)
    expect(emoji.length).toBeGreaterThan(NAME_CAP) // sanity: input overflows
    const m = {
      title: emoji,
      root: { backendPath: "/", role: "textbox", name: emoji, value: emoji, placeholder: emoji },
    }
    const r = parseDomModel(m)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.title.length).toBeLessThanOrEqual(NAME_CAP)
      expect(r.value.root.name.length).toBeLessThanOrEqual(NAME_CAP)
      expect(r.value.root.value?.length).toBeLessThanOrEqual(VALUE_CAP)
      expect(r.value.root.placeholder?.length).toBeLessThanOrEqual(NAME_CAP)
    }
  })
})

describe("HELLGATE parse EXTREME — optional level + states", () => {
  const withRoot = (over: Record<string, unknown>) => ({
    title: "x",
    root: { backendPath: "/", role: "heading", name: "h", ...over },
  })

  test("HELL-EX-24: level out of range (0/7/-1/'2'/null/bool) dropped; 1..6 kept", () => {
    // NOTE: 1.5 is intentionally excluded here — see HELL-EX-24b (real bug).
    for (const bad of [0, 7, -1, "2", null, true]) {
      const r = parseDomModel(withRoot({ level: bad }))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value.root.level).toBeUndefined()
    }
    // control: an in-range integer level survives
    for (const good of [1, 3, 6]) {
      const r = parseDomModel(withRoot({ level: good }))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value.root.level).toBe(good)
    }
  })

  // BUG: parseDomModel keeps a FRACTIONAL level (1.5) — the impl at
  // src/browser/cdp/collect.ts:78 range-checks `o.level >= 1 && o.level <= 6`
  // but never asserts integrality (Number.isInteger). Heading/aria levels are
  // integers H1..H6, so an attacker-supplied 1.5 (or 2.999) leaks through and
  // becomes a non-integer DomNode.level. Fail-closed parsing should drop it.
  test("HELL-EX-24b: fractional level (1.5) should be dropped", () => {
    const r = parseDomModel(withRoot({ level: 1.5 }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.root.level).toBeUndefined()
  })

  test("HELL-EX-25: states not array ⇒ dropped; array with non-strings filtered", () => {
    // non-array states ⇒ undefined
    const a = parseDomModel(withRoot({ states: "checked" }))
    expect(a.ok).toBe(true)
    if (a.ok) expect(a.value.root.states).toBeUndefined()

    // array with mixed types ⇒ only strings kept
    const b = parseDomModel(withRoot({ states: ["disabled", 5, null, "checked", {}] }))
    expect(b.ok).toBe(true)
    if (b.ok) expect(b.value.root.states).toEqual(["disabled", "checked"])

    // all-non-string array ⇒ undefined (no empty array leaks through)
    const c = parseDomModel(withRoot({ states: [1, 2, null] }))
    expect(c.ok).toBe(true)
    if (c.ok) expect(c.value.root.states).toBeUndefined()

    // control: clean string array preserved
    const d = parseDomModel(withRoot({ states: ["focused"] }))
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.value.root.states).toEqual(["focused"])
  })
})

describe("HELLGATE parse EXTREME — prototype pollution", () => {
  test("HELL-EX-26: __proto__/constructor keys via JSON string ⇒ no pollution", () => {
    // A JSON literal with a __proto__ key. JSON.parse does NOT walk the proto
    // chain — but assert the global Object proto stays clean regardless.
    const payload = `{
      "title": "x",
      "__proto__": { "polluted": "yes" },
      "constructor": { "prototype": { "polluted2": "yes" } },
      "root": {
        "backendPath": "/", "role": "r", "name": "n",
        "__proto__": { "polluted3": "yes" }
      }
    }`
    const r = parseDomModel(payload)
    expect(r.ok).toBe(true)
    // The load-bearing assertion: nothing leaked onto Object.prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted3).toBeUndefined()
  })

  test("HELL-EX-27: __proto__/constructor own-keys via object input ⇒ no pollution", () => {
    const root: Record<string, unknown> = {
      backendPath: "/",
      role: "r",
      name: "n",
    }
    // own enumerable poison keys (not the inherited slots)
    Object.defineProperty(root, "polluteOwn", { value: 1, enumerable: true })
    const model: Record<string, unknown> = {
      title: "x",
      root,
    }
    Object.defineProperty(model, "constructor", {
      value: { prototype: { polluted4: "yes" } },
      enumerable: true,
    })
    const r = parseDomModel(model)
    expect(r.ok).toBe(true)
    expect(({} as Record<string, unknown>).polluted4).toBeUndefined()
    // the poison own-key must NOT have been copied into the output node
    if (r.ok) expect((r.value.root as Record<string, unknown>).polluteOwn).toBeUndefined()
  })
})

describe("HELLGATE parse EXTREME — string vs object input parity", () => {
  test("HELL-EX-28: string JSON and object input parse identically", () => {
    const m = {
      title: "Parity",
      root: {
        backendPath: "/",
        role: "document",
        name: "Parity",
        children: [leaf({ value: "x".repeat(VALUE_CAP + 10), level: 3, states: ["disabled"] })],
      },
    }
    const fromObj = parseDomModel(m)
    const fromStr = parseDomModel(JSON.stringify(m))
    expect(fromObj.ok).toBe(true)
    expect(fromStr.ok).toBe(true)
    if (fromObj.ok && fromStr.ok) {
      // structural equality between the two ingestion paths
      expect(fromStr.value).toEqual(fromObj.value)
      expect(fromStr.value.root.children?.[0]?.value?.length).toBe(VALUE_CAP)
    }
  })

  test("HELL-EX-29: same malformed input rejected via both paths", () => {
    const bad = { title: 5, root: { backendPath: "/", role: "r", name: "n" } }
    expect(parseDomModel(bad).ok).toBe(false)
    expect(parseDomModel(JSON.stringify(bad)).ok).toBe(false)
    // control parity
    const good = validModel()
    expect(parseDomModel(good).ok).toBe(true)
    expect(parseDomModel(JSON.stringify(good)).ok).toBe(true)
  })
})
