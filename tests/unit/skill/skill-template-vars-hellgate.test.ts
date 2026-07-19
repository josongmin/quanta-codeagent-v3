/**
 * Hellgate — ADR-0252 Windsurf `{{ name }}` template-literal substitution
 * WIRED into the `Skill` tool render path (`QUANTA_SKILL_TEMPLATE_VARS`).
 *
 * This pins the *wiring* the pure-expander hellgate
 * (`tests/unit/skill/playbook/template-literal-hellgate.test.ts`) does NOT:
 * that the expander is actually reachable from a real consumer, that the gate
 * governs it, that OFF is byte-identical, and that an unknown variable
 * short-circuits to a typed error rather than a guess.
 *
 *  - HELL-STV-01  ON + `key=value` args ⇒ `{{ name }}` in body → the value
 *  - HELL-STV-02  OFF ⇒ `{{ name }}` emitted VERBATIM (byte-identical), even
 *                 with matching args present (the whole gap: default is literal)
 *  - HELL-STV-03  no `args` ⇒ body verbatim regardless of gate (opt-out)
 *  - HELL-STV-04  unknown variable ⇒ tool result `ok:false`, typed error text,
 *                 NO guessed value, NO partial body leaked
 *  - HELL-STV-05  runs ALONGSIDE `$ARGUMENTS`/`$N` — a body using BOTH `{{ x }}`
 *                 and `$1` resolves each from its own surface
 *  - HELL-STV-06  parseKeyValueArgs: only real `key=value` idents bind; bare
 *                 positionals are ignored (left for the `$N` pass)
 *  - HELL-STV-07  RED-ON-INJECTION — if the wire silently swallowed the error
 *                 (returned the raw body on unknown var) the assertion flips
 *  - HELL-STV-08  dotted-path `{{ a.b }}` is unknown here (flat key=value ctx)
 *                 ⇒ short-circuit (proves we did not invent a nested context)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  createSkillTool,
  expandSkillTemplateVars,
  parseKeyValueArgs,
} from "@/../src/skill/skill-tool"
import type { Skill } from "@/../src/skill/types"
import { __resetRuntimeConfig } from "@/shared"
import type { ToolContext, ToolEvent } from "@/tool"

const skill = (body: string): Skill =>
  ({ name: "demo", description: "d", body }) as unknown as Skill

const ctx = (): ToolContext => ({ signal: new AbortController().signal }) as ToolContext

const run = async (body: string, input: unknown): Promise<{ ok: boolean; output: string }> => {
  const tool = createSkillTool([skill(body)])
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, ctx())) last = ev
  if (last?.type !== "result") throw new Error("no result")
  return { ok: last.result.ok, output: last.result.output }
}

const ENV = "QUANTA_SKILL_TEMPLATE_VARS"

describe("skill template-vars wiring hellgate (ADR-0252)", () => {
  beforeEach(() => {
    delete process.env[ENV]
    __resetRuntimeConfig()
  })
  afterEach(() => {
    delete process.env[ENV]
    __resetRuntimeConfig()
  })

  const on = () => {
    process.env[ENV] = "1"
    __resetRuntimeConfig()
  }
  const off = () => {
    delete process.env[ENV]
    __resetRuntimeConfig()
  }

  test("HELL-STV-01: ON + key=value ⇒ {{ name }} expands to the value", async () => {
    on()
    const { ok, output } = await run("deploy to {{ env }} now", { name: "demo", args: "env=prod" })
    expect(ok).toBe(true)
    expect(output).toContain("deploy to prod now")
    expect(output).not.toContain("{{ env }}")
  })

  test("HELL-STV-02: OFF ⇒ {{ name }} verbatim (byte-identical) even with matching args", async () => {
    off()
    const body = "deploy to {{ env }} now"
    const { ok, output } = await run(body, { name: "demo", args: "env=prod" })
    expect(ok).toBe(true)
    // The literal template survives untouched — this is the pre-wire behaviour.
    expect(output).toContain("deploy to {{ env }} now")
    expect(output).not.toContain("deploy to prod now")
  })

  test("HELL-STV-03: no args ⇒ body verbatim regardless of gate (opt-out)", async () => {
    on()
    const body = "literal {{ env }} stays"
    const { ok, output } = await run(body, { name: "demo" })
    expect(ok).toBe(true)
    expect(output).toContain("literal {{ env }} stays")
  })

  test("HELL-STV-04: unknown variable ⇒ ok:false typed error, no guess, no body leak", async () => {
    on()
    const { ok, output } = await run("ship {{ missing }} please", {
      name: "demo",
      args: "env=prod",
    })
    expect(ok).toBe(false)
    expect(output).toContain("template error")
    expect(output).toContain("missing")
    // The typed short-circuit — NOT a guessed value, NOT the half-rendered body.
    expect(output).not.toContain("ship  please")
    expect(output).not.toContain("ship {{ missing }} please")
  })

  test("HELL-STV-05: {{ x }} and $N coexist, each reading the shared token stream", async () => {
    on()
    // Named pass: `{{ env }}` → `prod` (the value of `env=prod`).
    // Positional pass counts ALL whitespace tokens, so `$2` is the SECOND
    // token `alpha` (`$1` is the literal token `env=prod`). Both surfaces run
    // over the same args but with independent grammars — this pins that they
    // do NOT clobber each other.
    const { ok, output } = await run("env={{ env }} pos=$2", {
      name: "demo",
      args: "env=prod alpha",
    })
    expect(ok).toBe(true)
    expect(output).toContain("env=prod pos=alpha")
  })

  test("HELL-STV-06: parseKeyValueArgs binds only real key=value idents", () => {
    const c = parseKeyValueArgs("env=prod bare 1bad=x k=a=b =nope")
    expect(c.env).toBe("prod")
    // `x=a=b` → value keeps the rest after first `=`.
    expect(c.k).toBe("a=b")
    expect(Object.keys(c).sort()).toEqual(["env", "k"])
    // bare positional / invalid ident / empty key are NOT bound.
    expect("bare" in c).toBe(false)
    expect("1bad" in c).toBe(false)
  })

  test("HELL-STV-07: RED-ON-INJECTION — swallowing the unknown-var error flips this", async () => {
    on()
    const { ok } = await run("{{ nope }}", { name: "demo", args: "env=prod" })
    // If a future edit made the wire fall back to the raw body (silent guess),
    // `ok` would become true — this catches that regression.
    expect(ok).toBe(false)
  })

  test("HELL-STV-08: dotted path is unknown against a flat key=value ctx (no invented nesting)", async () => {
    on()
    const { ok, output } = await run("{{ a.b }}", { name: "demo", args: "a=prod" })
    expect(ok).toBe(false)
    expect(output).toContain("a.b")
  })

  test("expandSkillTemplateVars: pure helper resolves + short-circuits", () => {
    const okr = expandSkillTemplateVars("hi {{ who }}", "who=world")
    expect(okr.ok).toBe(true)
    if (okr.ok) expect(okr.text).toBe("hi world")
    const bad = expandSkillTemplateVars("hi {{ who }}", "other=x")
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.kind).toBe("unknown-variable")
  })

  test("HELL-STV-09: the {{ }} pass is one-pass — a value containing $1 is NOT re-scanned by it", () => {
    // Ordering hazard pin: the expander emits the literal value verbatim; only
    // the SEPARATE downstream `$N` pass owns `$1`. The two surfaces never fight.
    const r = expandSkillTemplateVars("x={{ v }}", "v=$1")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toBe("x=$1")
  })

  test("HELL-STV-10: `k=` binds a PRESENT empty string, distinct from a missing var", () => {
    // Coercion honesty: an explicitly empty value is a value, not `unknown`.
    const present = expandSkillTemplateVars("[{{ a }}]", "a=")
    expect(present.ok).toBe(true)
    if (present.ok) expect(present.text).toBe("[]")
    const missing = expandSkillTemplateVars("[{{ a }}]", "b=x")
    expect(missing.ok).toBe(false)
  })

  test("HELL-STV-11: parseKeyValueArgs never throws on adversarial input", () => {
    for (const a of ["", "   ", "===", "a=", "=b", "a==b", "\t\n a=1 \t", "k=v=w=x"]) {
      expect(() => parseKeyValueArgs(a)).not.toThrow()
    }
  })
})
