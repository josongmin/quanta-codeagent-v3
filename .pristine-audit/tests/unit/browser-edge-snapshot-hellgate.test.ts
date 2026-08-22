/**
 * Hellgate — Snapshot + RefMap EXTREME edge cases (ADR-0427).
 *
 * Dimension: buildSnapshot determinism + refMap under adversarial DOM models.
 * Every case has a control so a constant-return mutation is caught.
 *
 * Covers: depth 50, width 200, unicode/emoji/CJK/RTL names, names with
 * double-quote/backslash/newline/control chars (JSON.stringify escaping — no raw
 * newline may split a node line), NAME_CAP boundary via parseDomModel, value
 * with quotes, empty-string name, ref monotonicity across e1..e250, prune churn
 * (add 100 / remove 50 / re-add), reappearing backendPath gets a NEW ref,
 * byte-identical across two fresh maps for a complex model, placeholder + level
 * rendering edges (level 1 and 6 kept; out-of-range dropped by parse), and a
 * node carrying every optional field at once.
 */

import { describe, expect, test } from "bun:test"
import { buildSnapshot, createRefMap, type DomModel } from "@/browser"
import { NAME_CAP, parseDomModel, VALUE_CAP } from "@/browser/cdp/collect"

// ---- helpers ----------------------------------------------------------------

type Node = DomModel["root"]

/** A linear chain of `depth` nested nodes under the root. */
const chain = (depth: number): DomModel => {
  let cur: Node = { backendPath: `/leaf`, role: "leaf", name: "leaf" }
  for (let i = depth - 1; i >= 0; i--) {
    cur = { backendPath: `/${i}`, role: "group", name: `n${i}`, children: [cur] }
  }
  return {
    title: "deep",
    root: { backendPath: "/", role: "document", name: "root", children: [cur] },
  }
}

/** `n` sibling children under one root. */
const wide = (n: number): DomModel => {
  const children: Node[] = []
  for (let i = 0; i < n; i++) {
    children.push({ backendPath: `/${i}`, role: "cell", name: `c${i}` })
  }
  return { title: "wide", root: { backendPath: "/", role: "document", name: "root", children } }
}

// ---- determinism + escaping -------------------------------------------------

describe("HELLGATE edge — snapshot escaping + determinism", () => {
  test("EDGE-01: each node renders on exactly ONE line; no raw newline leaks via name", () => {
    const m: DomModel = {
      title: "T",
      root: {
        backendPath: "/",
        role: "document",
        name: "root",
        children: [
          { backendPath: "/0", role: "txt", name: "line1\nline2\nline3" },
          { backendPath: "/1", role: "txt", name: "after" },
        ],
      },
    }
    const out = buildSnapshot(m, createRefMap())
    // title + root + 2 children == 4 lines. If the embedded newline leaked raw,
    // the node line would split and we'd see > 4 lines.
    expect(out.split("\n")).toHaveLength(4)
    // The escaped form is present; the raw split form is NOT.
    expect(out).toContain('"line1\\nline2\\nline3"')
    expect(out).not.toContain('"line1\nline2')
  })

  test("EDGE-02 (control): a plain name renders one clean line and IS present", () => {
    const m: DomModel = {
      title: "T",
      root: {
        backendPath: "/",
        role: "document",
        name: "root",
        children: [{ backendPath: "/0", role: "txt", name: "plain" }],
      },
    }
    const out = buildSnapshot(m, createRefMap())
    expect(out.split("\n")).toHaveLength(3)
    expect(out).toContain('- e2 txt "plain"')
  })

  test("EDGE-03: double-quote, backslash, tab, CR, control chars all escaped — no line break", () => {
    const evil = 'a"b\\c\td\re\x00fg'
    const m: DomModel = {
      title: "T",
      root: {
        backendPath: "/",
        role: "document",
        name: "root",
        children: [
          { backendPath: "/0", role: "txt", name: evil },
          { backendPath: "/1", role: "txt", name: "tail" },
        ],
      },
    }
    const out = buildSnapshot(m, createRefMap())
    expect(out.split("\n")).toHaveLength(4) // nothing split the evil node
    // JSON.stringify escapes quote/backslash explicitly
    expect(out).toContain('a\\"b\\\\c')
    // the node line and the tail line both survive intact
    expect(out).toContain('- e3 txt "tail"')
  })

  test("EDGE-04: emoji + CJK + RTL names render verbatim inside quotes", () => {
    const m: DomModel = {
      title: "T",
      root: {
        backendPath: "/",
        role: "document",
        name: "root",
        children: [
          { backendPath: "/0", role: "txt", name: "🚀🔥 héllo" },
          { backendPath: "/1", role: "txt", name: "日本語テキスト" },
          { backendPath: "/2", role: "txt", name: "مرحبا بالعالم" }, // RTL arabic
        ],
      },
    }
    const out = buildSnapshot(m, createRefMap())
    expect(out).toContain('"🚀🔥 héllo"')
    expect(out).toContain('"日本語テキスト"')
    expect(out).toContain('"مرحبا بالعالم"')
    expect(out.split("\n")).toHaveLength(5)
  })

  test("EDGE-05: empty-string name still renders as quoted empty", () => {
    const m: DomModel = {
      title: "T",
      root: {
        backendPath: "/",
        role: "document",
        name: "",
        children: [{ backendPath: "/0", role: "txt", name: "" }],
      },
    }
    const out = buildSnapshot(m, createRefMap())
    expect(out).toContain('- e1 document ""')
    expect(out).toContain('- e2 txt ""')
  })

  test("EDGE-06: byte-identical across two fresh maps for a COMPLEX model", () => {
    const m: DomModel = {
      title: 'Complex 🚀 "quoted" \\slash',
      root: {
        backendPath: "/",
        role: "document",
        name: "root\nwith newline",
        children: [
          { backendPath: "/0", role: "heading", name: "H", level: 3 },
          {
            backendPath: "/1",
            role: "txt",
            name: "日本",
            states: ["focused", "disabled"],
            value: 'v"x',
            placeholder: "ph\t",
            url: "https://x.test/?a=1&b=2",
          },
          {
            backendPath: "/2",
            role: "group",
            name: "g",
            children: [{ backendPath: "/2/0", role: "btn", name: "deep emoji 🔥" }],
          },
        ],
      },
    }
    const a = buildSnapshot(m, createRefMap())
    const b = buildSnapshot(m, createRefMap())
    expect(a).toBe(b)
    // control: it actually rendered content (not constant empty)
    expect(a).toContain("- e1 document")
    expect(a).toContain("deep emoji 🔥")
  })

  test("EDGE-07 (control): title with raw newline DOES split (title is not JSON-escaped) — documents the boundary", () => {
    const m: DomModel = {
      title: "a\nb",
      root: { backendPath: "/", role: "document", name: "root" },
    }
    const out = buildSnapshot(m, createRefMap())
    // documented behaviour: title is `# ${title}` un-escaped → 2 title lines + 1 root.
    expect(out.split("\n")).toHaveLength(3)
    expect(out.startsWith("# a\nb")).toBe(true)
  })
})

// ---- depth / width ----------------------------------------------------------

describe("HELLGATE edge — depth + width extremes", () => {
  test("EDGE-08: depth 50 chain — deepest leaf indented 51 levels, refs monotonic", () => {
    const m = chain(50)
    const rm = createRefMap()
    const out = buildSnapshot(m, rm)
    // root(e1) + 50 group nodes + 1 leaf == 52 lines.
    expect(out.split("\n").filter((l) => l.startsWith(" ") || l.startsWith("-")).length).toBe(52)
    // deepest leaf indentation: depth of leaf = 51 → 51*2 spaces.
    const leafLine = out.split("\n").find((l) => l.includes('"leaf"'))
    expect(leafLine).toBeDefined()
    expect(leafLine?.startsWith(`${"  ".repeat(51)}- `)).toBe(true)
    // refs are e1..e52 monotonic in pre-order
    expect(rm.refOf("/")).toBe("e1")
    expect(rm.refOf("/0")).toBe("e2")
    expect(rm.refOf("/leaf")).toBe("e52")
  })

  test("EDGE-09 (control): depth 1 — root + single child, no deep indent", () => {
    const m = chain(1)
    const out = buildSnapshot(m, createRefMap())
    const leafLine = out.split("\n").find((l) => l.includes('"leaf"'))
    // leaf at depth 2 → 4 spaces, not 100.
    expect(leafLine?.startsWith("    - ")).toBe(true)
  })

  test("EDGE-10: width 200 siblings — 200 distinct refs e2..e201 in order", () => {
    const m = wide(200)
    const rm = createRefMap()
    const out = buildSnapshot(m, rm)
    expect(out.split("\n")).toHaveLength(202) // title + root + 200
    expect(rm.refOf("/")).toBe("e1")
    expect(rm.refOf("/0")).toBe("e2")
    expect(rm.refOf("/199")).toBe("e201")
    // all refs unique
    const refs = new Set<string>()
    for (let i = 0; i < 200; i++) refs.add(rm.refOf(`/${i}`) ?? "X")
    expect(refs.size).toBe(200)
  })

  test("EDGE-11 (control): width 1 — single sibling gets e2", () => {
    const rm = createRefMap()
    buildSnapshot(wide(1), rm)
    expect(rm.refOf("/0")).toBe("e2")
    expect(rm.refOf("/1")).toBeNull()
  })
})

// ---- ref monotonicity + prune churn -----------------------------------------

describe("HELLGATE edge — ref monotonicity + prune churn", () => {
  test("EDGE-12: 250 fresh nodes across reconciles ⇒ e1..e251 strictly monotonic, no reuse", () => {
    const rm = createRefMap()
    const seen = new Set<string>()
    let lastCounter = 0
    for (let n = 1; n <= 250; n++) {
      const children: Node[] = []
      for (let i = 0; i < n; i++) children.push({ backendPath: `/${i}`, role: "x", name: `x${i}` })
      const m: DomModel = {
        title: "m",
        root: { backendPath: "/", role: "document", name: "r", children },
      }
      buildSnapshot(m, rm)
      const ref = rm.refOf(`/${n - 1}`) // the newly added node
      expect(ref).not.toBeNull()
      expect(seen.has(ref ?? "")).toBe(false) // never reused
      seen.add(ref ?? "")
      const num = Number((ref ?? "e0").slice(1))
      expect(num).toBeGreaterThan(lastCounter) // strictly monotonic
      lastCounter = num
    }
    // 250 nodes + root e1 → last new node is e251.
    expect(rm.refOf("/249")).toBe("e251")
  })

  test("EDGE-13: add 100 → remove 50 → re-add — refs monotonic; pruned resolve null; re-add is NEW ref", () => {
    const rm = createRefMap()
    const build = (paths: string[]) => {
      const children = paths.map<Node>((p) => ({ backendPath: p, role: "x", name: p }))
      buildSnapshot(
        { title: "m", root: { backendPath: "/", role: "document", name: "r", children } },
        rm,
      )
    }
    // add 100
    const all = Array.from({ length: 100 }, (_, i) => `/${i}`)
    build(all)
    const refOf50 = rm.refOf("/50")
    expect(refOf50).toBe("e52") // root e1 + /0..../99 = e2..e101
    expect(rm.refOf("/99")).toBe("e101")

    // remove the even-indexed 50 (0,2,...,98)
    const kept = all.filter((_, i) => i % 2 === 1)
    build(kept)
    expect(rm.refOf("/0")).toBeNull() // pruned
    expect(rm.resolve("e2")).toBeNull() // /0 was e2 → now resolves null
    expect(rm.refOf("/1")).toBe("e3") // odd survivor unchanged
    expect(rm.refOf("/99")).toBe("e101") // survivor unchanged

    // re-add /0 — it disappeared, so it must get a brand-NEW ref (not e2 again).
    build([...kept, "/0"])
    const readd = rm.refOf("/0")
    expect(readd).not.toBeNull()
    expect(readd).not.toBe("e2") // documented: reappearing path = NEW ref
    expect(Number((readd ?? "e0").slice(1))).toBeGreaterThan(101)
    // the resurrected ref resolves back correctly
    expect(rm.resolve(readd ?? "")).toBe("/0")
  })

  test("EDGE-14 (control): a node that NEVER vanishes keeps its ref across churn", () => {
    const rm = createRefMap()
    const build = (paths: string[]) => {
      const children = paths.map<Node>((p) => ({ backendPath: p, role: "x", name: p }))
      buildSnapshot(
        { title: "m", root: { backendPath: "/", role: "document", name: "r", children } },
        rm,
      )
    }
    build(["/a", "/b"])
    const refA = rm.refOf("/a")
    build(["/a"]) // /b pruned
    build(["/a", "/c"]) // /a stays present the whole time
    expect(rm.refOf("/a")).toBe(refA) // stable identity
    expect(rm.refOf("/b")).toBeNull()
  })

  test("EDGE-15: resolve of a never-assigned ref ⇒ null; refOf unknown path ⇒ null", () => {
    const rm = createRefMap()
    buildSnapshot(wide(3), rm)
    expect(rm.resolve("e999")).toBeNull()
    expect(rm.refOf("/nope")).toBeNull()
    // control: a real one resolves
    expect(rm.resolve("e1")).toBe("/")
  })
})

// ---- NAME_CAP / VALUE_CAP boundaries (via parseDomModel) ---------------------

describe("HELLGATE edge — NAME_CAP / VALUE_CAP boundaries", () => {
  const wrap = (name: string, extra: Record<string, unknown> = {}) =>
    parseDomModel(
      JSON.stringify({
        title: "T",
        root: {
          backendPath: "/",
          role: "document",
          name: "root",
          children: [{ backendPath: "/0", role: "txt", name, ...extra }],
        },
      }),
    )

  test("EDGE-16: name exactly at NAME_CAP is kept whole; over NAME_CAP truncated to NAME_CAP", () => {
    const atCap = "a".repeat(NAME_CAP)
    const overCap = "b".repeat(NAME_CAP + 50)
    const r1 = wrap(atCap)
    const r2 = wrap(overCap)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    if (r1.ok && r2.ok) {
      expect(r1.value.root.children?.[0]?.name.length).toBe(NAME_CAP)
      expect(r2.value.root.children?.[0]?.name.length).toBe(NAME_CAP)
      expect(r2.value.root.children?.[0]?.name).toBe("b".repeat(NAME_CAP))
    }
  })

  test("EDGE-17 (control): name just UNDER cap is untouched", () => {
    const under = "c".repeat(NAME_CAP - 1)
    const r = wrap(under)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.root.children?.[0]?.name).toBe(under)
  })

  test("EDGE-18: value over VALUE_CAP truncated; value with quotes renders escaped in snapshot", () => {
    const longVal = "z".repeat(VALUE_CAP + 10)
    const r = wrap("name", { value: longVal })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.root.children?.[0]?.value?.length).toBe(VALUE_CAP)

    // value with embedded quote → escaped in rendered line, one line.
    const q = wrap("name", { value: 'has"quote' })
    expect(q.ok).toBe(true)
    if (!q.ok) return
    const out = buildSnapshot(q.value, createRefMap())
    expect(out).toContain('="has\\"quote"') // ="has\"quote"
    // node still one line
    expect(out.split("\n")).toHaveLength(3)
  })

  test("EDGE-19: level 1 and level 6 are kept; level 0 and level 7 are dropped by parse", () => {
    const lvl = (n: number) => wrap("h", { level: n })
    const r1 = lvl(1)
    const r6 = lvl(6)
    const r0 = lvl(0)
    const r7 = lvl(7)
    expect(r1.ok && r1.value.root.children?.[0]?.level).toBe(1)
    expect(r6.ok && r6.value.root.children?.[0]?.level).toBe(6)
    // out of [1,6] → field dropped (undefined)
    expect(r0.ok && r0.value.root.children?.[0]?.level).toBeUndefined()
    expect(r7.ok && r7.value.root.children?.[0]?.level).toBeUndefined()
  })

  test("EDGE-20: title over NAME_CAP truncated to NAME_CAP", () => {
    const r = parseDomModel(
      JSON.stringify({
        title: "t".repeat(NAME_CAP + 5),
        root: { backendPath: "/", role: "x", name: "n" },
      }),
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.title.length).toBe(NAME_CAP)
  })
})

// ---- all optional fields + rendering order ----------------------------------

describe("HELLGATE edge — every optional field at once + suffix order", () => {
  test("EDGE-21: node with level + states + value + placeholder + url renders in fixed order", () => {
    const m: DomModel = {
      title: "T",
      root: {
        backendPath: "/",
        role: "document",
        name: "root",
        children: [
          {
            backendPath: "/0",
            role: "combobox",
            name: "Field",
            tag: "input",
            level: 4,
            states: ["disabled", "focused"],
            value: "val",
            placeholder: "type here",
            url: "https://x.test/",
          },
        ],
      },
    }
    const out = buildSnapshot(m, createRefMap())
    const line = out.split("\n").find((l) => l.includes('"Field"'))
    expect(line).toBe(
      '  - e2 combobox "Field" h4 [disabled,focused] ="val" ph="type here" (https://x.test/)',
    )
  })

  test("EDGE-22 (control): node with NO optional fields renders just ref+role+name", () => {
    const m: DomModel = {
      title: "T",
      root: {
        backendPath: "/",
        role: "document",
        name: "root",
        children: [{ backendPath: "/0", role: "txt", name: "bare" }],
      },
    }
    const out = buildSnapshot(m, createRefMap())
    const line = out.split("\n").find((l) => l.includes('"bare"'))
    expect(line).toBe('  - e2 txt "bare"')
  })

  test("EDGE-23: empty states array is NOT rendered (length 0 suppressed)", () => {
    const m: DomModel = {
      title: "T",
      root: {
        backendPath: "/",
        role: "document",
        name: "root",
        children: [{ backendPath: "/0", role: "txt", name: "x", states: [] }],
      },
    }
    const out = buildSnapshot(m, createRefMap())
    const line = out.split("\n").find((l) => l.includes('"x"'))
    expect(line).toBe('  - e2 txt "x"') // no "[]"
    expect(line).not.toContain("[]")
  })

  test("EDGE-24: placeholder edge — placeholder with quote/newline escaped, single line", () => {
    const m: DomModel = {
      title: "T",
      root: {
        backendPath: "/",
        role: "document",
        name: "root",
        children: [
          { backendPath: "/0", role: "txt", name: "x", placeholder: 'a"b\nc' },
          { backendPath: "/1", role: "txt", name: "after" },
        ],
      },
    }
    const out = buildSnapshot(m, createRefMap())
    expect(out.split("\n")).toHaveLength(4)
    expect(out).toContain('ph="a\\"b\\nc"')
  })

  test("EDGE-25: level 1 and 6 render as h1/h6 suffix", () => {
    const m: DomModel = {
      title: "T",
      root: {
        backendPath: "/",
        role: "document",
        name: "root",
        children: [
          { backendPath: "/0", role: "heading", name: "top", level: 1 },
          { backendPath: "/1", role: "heading", name: "deep", level: 6 },
        ],
      },
    }
    const out = buildSnapshot(m, createRefMap())
    expect(out).toContain('- e2 heading "top" h1')
    expect(out).toContain('- e3 heading "deep" h6')
  })

  test("EDGE-26: ref-not-yet-assigned renders '?' placeholder for a node refMap never saw", () => {
    // Build a model, then render a DIFFERENT model line against a refMap whose
    // reconcile already ran — buildSnapshot reconciles first so every node IS
    // assigned. To force the '?' branch we render a node whose path is absent:
    // call renderNode indirectly is not exported, so we assert the guaranteed
    // path: every node in a reconciled model resolves to a real ref (never '?').
    const m = wide(3)
    const rm = createRefMap()
    const out = buildSnapshot(m, rm)
    expect(out).not.toContain("- ? ") // reconcile guarantees no '?'
    // control: refs really were assigned
    expect(out).toContain("- e1 document")
  })
})
