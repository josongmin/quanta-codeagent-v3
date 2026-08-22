/**
 * Hellgate — Windsurf-style `{{ variable }}` template-literal expander
 * (ADR-0252, sibling to ADR-0203 `!macro`).
 *
 * 15 cases pinning the expander grammar / lookup / coercion / boundary
 * contract. Cases:
 *
 *  - HELL-TL-01  simple `{{ name }}` → context value
 *  - HELL-TL-02  multiple variables one line independently resolved
 *  - HELL-TL-03  no `{{...}}` ⇒ byte-identical input
 *  - HELL-TL-04  unknown variable ⇒ `ok:false, { kind: "unknown-variable" }`
 *  - HELL-TL-05  `\{\{` escape → literal `{{`
 *  - HELL-TL-06  dotted path `{{ a.b.c }}` nested lookup
 *  - HELL-TL-07  missing dotted-path leaf ⇒ unknown-variable
 *  - HELL-TL-08  numeric value → String(n) (incl. zero)
 *  - HELL-TL-09  boolean → "true" / "false"
 *  - HELL-TL-10  whitespace inside braces trimmed
 *  - HELL-TL-11  ONE-PASS — `{{ a }}` expanding to `{{ b }}` is NOT re-expanded
 *  - HELL-TL-12  unmatched `{{` without `}}` → literal passthrough
 *  - HELL-TL-13  10 000-substitution perf sanity
 *  - HELL-TL-14  default-OFF — `!macro` surface byte-identical without expander
 *  - HELL-TL-15  empty template → "" with ok:true
 */

import { describe, expect, test } from "bun:test"
import { buildMacroRegistry, expandStep } from "@/skill/playbook"
import {
  createDefaultTemplateExpander,
  type ExpandContext,
} from "@/skill/playbook/template-literal"

describe("template-literal hellgate (ADR-0252)", () => {
  const expander = createDefaultTemplateExpander()

  test("HELL-TL-01: simple `{{ name }}` resolves to context value", () => {
    const r = expander.expand("hello {{ name }}!", { name: "world" })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.text).toBe("hello world!")
  })

  test("HELL-TL-02: multiple variables in one template each resolve independently", () => {
    const r = expander.expand("deploy {{ artifact }} to {{ env }}", {
      artifact: "api-v3",
      env: "prod",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.text).toBe("deploy api-v3 to prod")

    // No-arg adjacency: each substitution carries its own braces.
    const r2 = expander.expand("{{ a }}{{ b }}{{ a }}", { a: "X", b: "Y" })
    expect(r2.ok).toBe(true)
    if (!r2.ok) throw new Error("unreachable")
    expect(r2.text).toBe("XYX")
  })

  test("HELL-TL-03: template without any `{{...}}` returns byte-identical input", () => {
    const raw = "plain prose with no substitution\n- bullet\n- another"
    const r = expander.expand(raw, { unused: "value" })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.text).toBe(raw)
  })

  test("HELL-TL-04: unknown variable surfaces typed unknown-variable error with position", () => {
    const r = expander.expand("hello {{ nope }} there", { name: "world" })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("unknown-variable")
    if (r.error.kind !== "unknown-variable") throw new Error("unreachable")
    expect(r.error.name).toBe("nope")
    // 1-based position of the opening `{{`
    expect(r.error.position).toBe(7)
  })

  test("HELL-TL-05: `\\{\\{` escape emits literal `{{` (not a substitution)", () => {
    const r = expander.expand("show literal \\{\\{ name }} stays raw", {
      name: "world",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.text).toBe("show literal {{ name }} stays raw")

    // Escape at start of input
    const r2 = expander.expand("\\{\\{ x }}", { x: "v" })
    expect(r2.ok).toBe(true)
    if (!r2.ok) throw new Error("unreachable")
    expect(r2.text).toBe("{{ x }}")
  })

  test("HELL-TL-06: dotted path `{{ a.b.c }}` resolves through nested context", () => {
    const ctx: ExpandContext = {
      deploy: {
        env: "prod",
        target: {
          region: "us-east-1",
        },
      },
    }
    const r = expander.expand("ship to {{ deploy.env }} in {{ deploy.target.region }}", ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.text).toBe("ship to prod in us-east-1")
  })

  test("HELL-TL-07: missing dotted-path leaf surfaces unknown-variable", () => {
    const ctx: ExpandContext = { deploy: { env: "prod" } }
    const r = expander.expand("{{ deploy.region }}", ctx)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("unknown-variable")
    if (r.error.kind !== "unknown-variable") throw new Error("unreachable")
    expect(r.error.name).toBe("deploy.region")

    // Bare object lookup (`{{ deploy }}` without dotted path) is also unknown
    // — we refuse to silently JSON.stringify objects.
    const r2 = expander.expand("{{ deploy }}", ctx)
    expect(r2.ok).toBe(false)
    if (r2.ok) throw new Error("unreachable")
    expect(r2.error.kind).toBe("unknown-variable")
  })

  test("HELL-TL-08: numeric value coerces to String(n) including zero", () => {
    const r = expander.expand("count={{ n }}, zero={{ z }}", { n: 42, z: 0 })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.text).toBe("count=42, zero=0")

    const r2 = expander.expand("{{ pi }}", { pi: 3.14 })
    expect(r2.ok).toBe(true)
    if (!r2.ok) throw new Error("unreachable")
    expect(r2.text).toBe("3.14")
  })

  test('HELL-TL-09: boolean coerces to `"true"` / `"false"`', () => {
    const r = expander.expand("dry={{ dry }}, force={{ force }}", {
      dry: true,
      force: false,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.text).toBe("dry=true, force=false")
  })

  test("HELL-TL-10: whitespace inside braces is trimmed before lookup", () => {
    const r = expander.expand("a={{   name   }} b={{name}} c={{\tname\t}}", {
      name: "X",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.text).toBe("a=X b=X c=X")
  })

  test("HELL-TL-11: ONE-PASS — expansion result is NOT re-scanned for `{{}}`", () => {
    // `a` expands to `{{ b }}` — those braces must remain literal output.
    const r = expander.expand("step: {{ a }}", { a: "{{ b }}", b: "RESOLVED" })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.text).toBe("step: {{ b }}")
  })

  test("HELL-TL-12: unmatched `{{` without closing `}}` passes through literally", () => {
    const r = expander.expand("here is {{ name with no close", {
      name: "ignored",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.text).toBe("here is {{ name with no close")

    // Bare `}}` without prior opener is also literal
    const r2 = expander.expand("end }} marker", {})
    expect(r2.ok).toBe(true)
    if (!r2.ok) throw new Error("unreachable")
    expect(r2.text).toBe("end }} marker")
  })

  test("HELL-TL-13: 10 000-substitution perf sanity (~50ms budget)", () => {
    const parts: string[] = []
    for (let i = 0; i < 10_000; i++) parts.push("{{ x }}")
    const template = parts.join("|")
    const t0 = performance.now()
    const r = expander.expand(template, { x: "Q" })
    const dt = performance.now() - t0
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.text.length).toBe(10_000 + 9_999) // 10k "Q" + 9999 "|"
    expect(r.text.startsWith("Q|Q|")).toBe(true)
    // Loose sanity ceiling — the slice must not regress to seconds.
    expect(dt).toBeLessThan(500)
  })

  test("HELL-TL-14: default-OFF — `!macro` surface (ADR-0203) is byte-identical without template expander", () => {
    // The macro expander is the ADR-0203 surface; it must NOT see `{{}}`
    // grammar. A template body containing `{{ name }}` left to the macro
    // expander stays verbatim — the template expander is the ONLY thing
    // that knows the new grammar, and it is not invoked here.
    const registry = buildMacroRegistry([{ name: "abort", expansion: "STOP" }])
    const exp = expandStep("On {{ env }} error, !abort the rollout.", registry)
    expect(exp.text).toBe("On {{ env }} error, STOP the rollout.")
    expect(exp.resolved).toEqual(["abort"])
    expect(exp.missing).toEqual([])
  })

  test("HELL-TL-15: empty template produces empty string with ok:true", () => {
    const r = expander.expand("", { unused: "x" })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.text).toBe("")
  })
})
