/**
 * SKILL.md frontmatter unit tests (Cluster E / F14, ADR-0040).
 *
 * ≥ 25 cases: valid + invalid frontmatter, edge whitespace, missing fields,
 * unsupported YAML constructs.
 */
import { describe, expect, test } from "bun:test"
import {
  FrontmatterParseError,
  parseSkillMarkdown,
  SkillFrontmatterSchema,
} from "../../src/skill/skill-frontmatter"

const valid = (extra = ""): string =>
  [
    "---",
    "name: my-skill",
    "description: A short description.",
    "userInvocable: true",
    'allowedTools: ["Read", "Bash"]',
    "category: skill",
    "stability: stable",
    "---",
    extra,
  ].join("\n")

describe("parseSkillMarkdown — happy paths", () => {
  test("parses a minimal valid SKILL.md", () => {
    const r = parseSkillMarkdown(valid())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.frontmatter.name).toBe("my-skill")
      expect(r.value.frontmatter.userInvocable).toBe(true)
      expect(r.value.frontmatter.allowedTools).toEqual(["Read", "Bash"])
      expect(r.value.frontmatter.category).toBe("skill")
      expect(r.value.frontmatter.stability).toBe("stable")
    }
  })

  test("preserves the body verbatim (trimmed leading newlines)", () => {
    const r = parseSkillMarkdown(`${valid()}\nBody line 1\nBody line 2\n`)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.body).toBe("Body line 1\nBody line 2\n")
  })

  test("accepts category: extension with userInvocable: false", () => {
    const text = valid()
      .replace("category: skill", "category: extension")
      .replace("userInvocable: true", "userInvocable: false")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.frontmatter.category).toBe("extension")
      expect(r.value.frontmatter.userInvocable).toBe(false)
    }
  })

  test("accepts empty allowedTools list", () => {
    const text = valid().replace('allowedTools: ["Read", "Bash"]', "allowedTools: []")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.frontmatter.allowedTools).toEqual([])
  })

  test("accepts single-quoted strings", () => {
    const text = [
      "---",
      "name: 'my-skill'",
      "description: 'desc'",
      "userInvocable: false",
      "allowedTools: ['Read']",
      "category: skill",
      "stability: experimental",
      "---",
    ].join("\n")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(true)
  })

  test("accepts double-quoted strings with escapes", () => {
    const text = [
      "---",
      'name: "my-skill"',
      'description: "with \\"quotes\\""',
      "userInvocable: false",
      "allowedTools: []",
      "category: skill",
      "stability: deprecated",
      "---",
    ].join("\n")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.frontmatter.description).toBe('with "quotes"')
  })

  test("allows blank lines and # comments in the frontmatter", () => {
    const text = [
      "---",
      "# leading comment",
      "name: my-skill",
      "",
      "description: stuff",
      "userInvocable: false",
      "allowedTools: []",
      "category: skill",
      "stability: stable",
      "---",
    ].join("\n")
    expect(parseSkillMarkdown(text).ok).toBe(true)
  })
})

describe("parseSkillMarkdown — invalid frontmatter shape", () => {
  test("missing opening fence", () => {
    const r = parseSkillMarkdown("name: x\n")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(FrontmatterParseError)
      expect(r.error.line).toBe(1)
    }
  })

  test("missing closing fence", () => {
    const text = "---\nname: my-skill\nstill: open\n"
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/unterminated frontmatter/)
  })

  test("malformed key line", () => {
    const text = ["---", "this is not a key value", "---"].join("\n")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.line).toBe(2)
  })

  test("duplicate key", () => {
    const text = [
      "---",
      "name: a",
      "name: b",
      "description: x",
      "userInvocable: true",
      "allowedTools: []",
      "category: skill",
      "stability: stable",
      "---",
    ].join("\n")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/duplicate key/)
  })

  test("indented continuation line rejected", () => {
    const text = [
      "---",
      "name: my-skill",
      "  not-allowed: x",
      "description: d",
      "userInvocable: true",
      "allowedTools: []",
      "category: skill",
      "stability: stable",
      "---",
    ].join("\n")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/indented continuation/)
  })

  test("dangling escape in double-quoted value", () => {
    const text = [
      "---",
      'name: "my-skill\\',
      "description: d",
      "userInvocable: true",
      "allowedTools: []",
      "category: skill",
      "stability: stable",
      "---",
    ].join("\n")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(false)
  })

  test("unknown escape sequence", () => {
    const text = [
      "---",
      'name: "ok\\zname"',
      "description: d",
      "userInvocable: true",
      "allowedTools: []",
      "category: skill",
      "stability: stable",
      "---",
    ].join("\n")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(false)
  })

  test("numeric value rejected (no numeric scalars)", () => {
    const text = [
      "---",
      "name: ok",
      "description: 42",
      "userInvocable: true",
      "allowedTools: []",
      "category: skill",
      "stability: stable",
      "---",
    ].join("\n")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/numeric scalars/)
  })

  test("null rejected", () => {
    const text = [
      "---",
      "name: null",
      "description: x",
      "userInvocable: true",
      "allowedTools: []",
      "category: skill",
      "stability: stable",
      "---",
    ].join("\n")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(false)
  })

  test("flow map rejected", () => {
    const text = [
      "---",
      "name: x",
      "description: {a: 1}",
      "userInvocable: true",
      "allowedTools: []",
      "category: skill",
      "stability: stable",
      "---",
    ].join("\n")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(false)
  })

  test("anchor rejected", () => {
    const text = [
      "---",
      "name: x",
      "description: &anchor value",
      "userInvocable: true",
      "allowedTools: []",
      "category: skill",
      "stability: stable",
      "---",
    ].join("\n")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(false)
  })

  test("'yes' is NOT a boolean", () => {
    const text = [
      "---",
      "name: x",
      "description: d",
      "userInvocable: yes",
      "allowedTools: []",
      "category: skill",
      "stability: stable",
      "---",
    ].join("\n")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(false)
  })

  test("Capitalised 'True' rejected", () => {
    const text = [
      "---",
      "name: x",
      "description: d",
      "userInvocable: True",
      "allowedTools: []",
      "category: skill",
      "stability: stable",
      "---",
    ].join("\n")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(false)
  })

  test("unterminated flow list", () => {
    const text = [
      "---",
      "name: x",
      "description: d",
      "userInvocable: false",
      'allowedTools: ["a", "b"',
      "category: skill",
      "stability: stable",
      "---",
    ].join("\n")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(false)
  })

  test("unterminated single-quote string", () => {
    const text = [
      "---",
      "name: 'unterminated",
      "description: d",
      "userInvocable: false",
      "allowedTools: []",
      "category: skill",
      "stability: stable",
      "---",
    ].join("\n")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(false)
  })

  test("empty allowedTools element rejected", () => {
    const text = [
      "---",
      "name: x",
      "description: d",
      "userInvocable: false",
      'allowedTools: ["a", ""]',
      "category: skill",
      "stability: stable",
      "---",
    ].join("\n")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(false)
  })
})

describe("parseSkillMarkdown — invalid frontmatter values", () => {
  test("bad name casing", () => {
    const text = valid().replace("name: my-skill", "name: BadCase")
    expect(parseSkillMarkdown(text).ok).toBe(false)
  })

  test("missing required field", () => {
    const text = [
      "---",
      "name: ok",
      "description: d",
      "userInvocable: true",
      "allowedTools: []",
      "category: skill",
      // stability missing
      "---",
    ].join("\n")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(false)
  })

  test("invalid category value", () => {
    const text = valid().replace("category: skill", "category: workflow")
    expect(parseSkillMarkdown(text).ok).toBe(false)
  })

  test("invalid stability value", () => {
    const text = valid().replace("stability: stable", "stability: alpha")
    expect(parseSkillMarkdown(text).ok).toBe(false)
  })

  test("description must be non-empty", () => {
    const text = valid().replace("description: A short description.", 'description: ""')
    expect(parseSkillMarkdown(text).ok).toBe(false)
  })

  test("strict mode rejects unknown frontmatter key", () => {
    const text = valid().replace("---\nname:", "---\nfoo: bar\nname:")
    const r = parseSkillMarkdown(text)
    expect(r.ok).toBe(false)
  })
})

describe("SkillFrontmatterSchema (direct Zod)", () => {
  test("accepts a fully-populated object", () => {
    const r = SkillFrontmatterSchema.safeParse({
      name: "my-skill",
      description: "x",
      userInvocable: true,
      allowedTools: ["Read"],
      category: "skill",
      stability: "stable",
    })
    expect(r.success).toBe(true)
  })

  test("rejects extra key (strict)", () => {
    const r = SkillFrontmatterSchema.safeParse({
      name: "my-skill",
      description: "x",
      userInvocable: true,
      allowedTools: [],
      category: "skill",
      stability: "stable",
      extra: 1,
    })
    expect(r.success).toBe(false)
  })
})
