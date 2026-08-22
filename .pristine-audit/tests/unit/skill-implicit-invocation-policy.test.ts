/**
 * §2.3 — skill `policy.allow_implicit_invocation` flag.
 *
 * SOTA mechanism (codex `agents/openai.yaml` `policy.allow_implicit_invocation`):
 * when FALSE, the skill is NOT injected into the model context by default, but
 * can still be invoked explicitly via `$skill`. Defaults to true.
 *
 * Two halves:
 *  - PARSE: `parseOpenaiYamlPolicy` reads the `policy:` block; the discovered
 *    flag lands on `Skill.allowImplicitInvocation`.
 *  - GATE: `implicitlyInvocableSkills(skills)` is the pure host filter — gated by
 *    `QUANTA_SKILL_IMPLICIT_POLICY`. Default-OFF ⇒ returns ALL skills
 *    (byte-identical: the policy flag has no effect until the host opts in). The
 *    EXPLICIT invocation surface is NEVER narrowed — this filters only the
 *    implicit-injection inventory.
 */
import { describe, expect, test } from "bun:test"
import { implicitlyInvocableSkills } from "../../src/skill/activation"
import { parseOpenaiYamlPolicy } from "../../src/skill/skill-resources"
import type { Skill } from "../../src/skill/types"

const skill = (name: string, allow?: boolean): Skill => ({
  name,
  description: "d",
  body: "b",
  sourcePath: `/s/${name}/SKILL.md`,
  ...(allow !== undefined ? { allowImplicitInvocation: allow } : {}),
})

describe("§2.3 parseOpenaiYamlPolicy", () => {
  test("reads allow_implicit_invocation: false", () => {
    expect(parseOpenaiYamlPolicy("policy:\n  allow_implicit_invocation: false\n")).toBe(false)
  })

  test("reads allow_implicit_invocation: true", () => {
    expect(parseOpenaiYamlPolicy("policy:\n  allow_implicit_invocation: true\n")).toBe(true)
  })

  test("reads the flag even with an interface block before it", () => {
    const yaml = `interface:\n  display_name: "X"\npolicy:\n  allow_implicit_invocation: false\n`
    expect(parseOpenaiYamlPolicy(yaml)).toBe(false)
  })

  test("undefined when no policy block (default = implicit allowed)", () => {
    expect(parseOpenaiYamlPolicy('interface:\n  display_name: "X"\n')).toBeUndefined()
  })

  test("undefined when policy block has no recognised key", () => {
    expect(parseOpenaiYamlPolicy("policy:\n  some_other_key: true\n")).toBeUndefined()
  })

  test("does NOT read a flag indented under interface (block scoping)", () => {
    const yaml = `interface:\n  allow_implicit_invocation: false\n`
    expect(parseOpenaiYamlPolicy(yaml)).toBeUndefined()
  })

  test("quoted boolean is honored", () => {
    expect(parseOpenaiYamlPolicy('policy:\n  allow_implicit_invocation: "false"\n')).toBe(false)
  })
})

describe("§2.3 implicitlyInvocableSkills — default-OFF byte-identity", () => {
  const SKILLS = [skill("a", false), skill("b", true), skill("c"), skill("d", false)]

  const OFF = {} as Record<string, string | undefined>
  const ON = { QUANTA_SKILL_IMPLICIT_POLICY: "1" }

  test("BYTE-IDENTITY: gate OFF ⇒ returns ALL skills unchanged (policy ignored)", () => {
    const out = implicitlyInvocableSkills(SKILLS, OFF)
    expect(out).toEqual(SKILLS)
    expect(out.map((s) => s.name)).toEqual(["a", "b", "c", "d"])
  })

  test("gate ON ⇒ skills with allow_implicit_invocation:false are EXCLUDED", () => {
    // 'a' and 'd' opted OUT of implicit invocation; 'b' (true) + 'c' (absent⇒
    // default-allowed) remain.
    expect(implicitlyInvocableSkills(SKILLS, ON).map((s) => s.name)).toEqual(["b", "c"])
  })

  test("gate ON ⇒ absent flag defaults to ALLOWED (codex default = true)", () => {
    expect(implicitlyInvocableSkills([skill("only")], ON).map((s) => s.name)).toEqual(["only"])
  })

  test("NO-THROW: empty input ⇒ empty output (both gate states)", () => {
    expect(implicitlyInvocableSkills([], OFF)).toEqual([])
    expect(implicitlyInvocableSkills([], ON)).toEqual([])
  })
})
