/**
 * ADR-0457 — codex skill ECOSYSTEM frontmatter + bundled resources hellgate.
 *
 * Proves the ADDITIVE absorption of codex's skill ecosystem completeness (gaps
 * A + B + C) while holding the quanta CORE (strict parser, 7-scope, ReDoS-glob)
 * unchanged. The load-bearing invariants:
 *
 *   A. `argument-hint` (kebab) parsed → Skill.argumentHint → surfaced in listing
 *      as `name <hint>`; strict schema now ACCEPTS it (previously rejected).
 *   B. `metadata.short-description` extracted → Skill.shortDescription → listing
 *      prefers it; strict schema now ACCEPTS the `metadata:` block.
 *   C. bundled-dir presence (agents/scripts/references/assets) detected;
 *      agents/openai.yaml `interface:` parsed; MALFORMED ⇒ graceful skip.
 *   REGRESSION ANCHOR: a plain SKILL.md with NONE of these is byte-identical.
 *
 * Adversarial focus: strict + lenient parse paths must stay consistent, and a
 * malformed bundled resource must NEVER crash discovery.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createSkillTool,
  discoverSkillResources,
  discoverSkills,
  parseFrontmatter,
  parseOpenaiYamlInterface,
  skillCatalogueRow,
} from "../../src/skill"
import { parseSkillMarkdown, SkillFrontmatterSchema } from "../../src/skill/skill-frontmatter"

const tmpDirs: string[] = []
const tmpDir = async (prefix: string): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
afterAll(async () => {
  for (const d of tmpDirs) {
    try {
      await rm(d, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
})

/** Write `<root>/<name>/SKILL.md` and return the skill dir. */
const writeNestedSkill = async (root: string, name: string, md: string): Promise<string> => {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "SKILL.md"), md, "utf8")
  return dir
}

// ── Gap A: argument-hint ──────────────────────────────────────────────────

describe("A. argument-hint (kebab frontmatter)", () => {
  const md = [
    "---",
    "name: rr",
    "description: Ruthless review skill.",
    'argument-hint: "[scope]"',
    "---",
    "# RR body",
  ].join("\n")

  test("lenient parser captures the kebab key", () => {
    const { data } = parseFrontmatter(md)
    expect(data["argument-hint"]).toBe("[scope]")
  })

  test("discovery surfaces Skill.argumentHint", async () => {
    const root = await tmpDir("adr0457-a-")
    await writeNestedSkill(root, "rr", md)
    const skills = await discoverSkills(root)
    expect(skills).toHaveLength(1)
    expect(skills[0]?.argumentHint).toBe("[scope]")
  })

  test("listing renders `name <hint>`", () => {
    const tool = createSkillTool([
      {
        name: "rr",
        description: "Ruthless review skill.",
        body: "",
        sourcePath: "/x/rr/SKILL.md",
        scope: "user",
        argumentHint: "[scope]",
      },
    ])
    expect(tool.description).toContain("- rr [scope]: Ruthless review skill.")
  })

  test("strict schema ACCEPTS argument-hint (previously rejected)", () => {
    const r = parseSkillMarkdown(
      [
        "---",
        "name: rr",
        "description: d",
        "userInvocable: true",
        "allowedTools: []",
        "category: skill",
        "stability: stable",
        'argument-hint: "[scope]"',
        "---",
        "body",
      ].join("\n"),
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.frontmatter["argument-hint"]).toBe("[scope]")
  })
})

// ── Gap B: metadata.short-description ─────────────────────────────────────

describe("B. metadata.short-description (nested block)", () => {
  const md = [
    "---",
    "name: rr2",
    "description: A very long escalation review skill description that is far too verbose for a compact listing row and should not be shown.",
    'argument-hint: "[scope]"',
    "metadata:",
    "  short-description: Urgent review, repair, prevention",
    "---",
    "# RR2",
  ].join("\n")

  test("lenient parser captures metadata.short-description as dotted key", () => {
    const { data } = parseFrontmatter(md)
    expect(data["metadata.short-description"]).toBe("Urgent review, repair, prevention")
  })

  test("discovery surfaces Skill.shortDescription", async () => {
    const root = await tmpDir("adr0457-b-")
    await writeNestedSkill(root, "rr2", md)
    const skills = await discoverSkills(root)
    expect(skills[0]?.shortDescription).toBe("Urgent review, repair, prevention")
  })

  test("listing PREFERS shortDescription over the long description", () => {
    const tool = createSkillTool([
      {
        name: "rr2",
        description: "WAY too long to ever show in a compact listing row.",
        body: "",
        sourcePath: "/x/rr2/SKILL.md",
        scope: "user",
        argumentHint: "[scope]",
        shortDescription: "Urgent review, repair, prevention",
      },
    ])
    expect(tool.description).toContain("- rr2 [scope]: Urgent review, repair, prevention")
    expect(tool.description).not.toContain("WAY too long")
  })

  test("strict schema ACCEPTS the metadata: block (previously rejected)", () => {
    const r = parseSkillMarkdown(
      [
        "---",
        "name: rr2",
        "description: d",
        "userInvocable: true",
        "allowedTools: []",
        "category: skill",
        "stability: stable",
        "metadata:",
        "  short-description: Urgent review",
        "---",
        "body",
      ].join("\n"),
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.frontmatter.metadata).toEqual({ "short-description": "Urgent review" })
    }
  })

  test("strict parser still REJECTS a genuinely-empty top-level scalar", () => {
    const r = parseSkillMarkdown(
      [
        "---",
        "name: x",
        "description:",
        "userInvocable: true",
        "allowedTools: []",
        "category: skill",
        "stability: stable",
        "---",
      ].join("\n"),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain("empty value")
  })

  test("strict parser rejects a non-string nested child (list value)", () => {
    const r = parseSkillMarkdown(
      [
        "---",
        "name: x",
        "description: d",
        "userInvocable: true",
        "allowedTools: []",
        "category: skill",
        "stability: stable",
        "metadata:",
        '  bad: ["a", "b"]',
        "---",
      ].join("\n"),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain("must be a string scalar")
  })
})

// ── Gap C: bundled resources ──────────────────────────────────────────────

describe("C. bundled resources (agents/scripts/references/assets)", () => {
  const okYaml = [
    "interface:",
    '  display_name: "rr"',
    '  short_description: "Ruthless review protocol"',
    '  default_prompt: "Use $rr to review the scope."',
    '  icon_small: "./assets/small.png"',
    '  brand_color: "#3B82F6"',
    "dependencies:",
    "  tools:",
    '    - type: "mcp"',
    "policy:",
    "  allow_implicit_invocation: true",
  ].join("\n")

  test("parseOpenaiYamlInterface maps the interface block (camelCase)", () => {
    const iface = parseOpenaiYamlInterface(okYaml)
    expect(iface).toEqual({
      displayName: "rr",
      shortDescription: "Ruthless review protocol",
      defaultPrompt: "Use $rr to review the scope.",
      iconSmall: "./assets/small.png",
      brandColor: "#3B82F6",
    })
  })

  test("interface parser ignores non-interface top-level blocks", () => {
    const iface = parseOpenaiYamlInterface(
      ["policy:", "  allow_implicit_invocation: false", 'other: "x"'].join("\n"),
    )
    expect(iface).toBeUndefined()
  })

  test("discovery records dir presence + file lists + parsed agentsYaml", async () => {
    const root = await tmpDir("adr0457-c-")
    const dir = await writeNestedSkill(
      root,
      "rr",
      ["---", "name: rr", "description: d", "---", "body"].join("\n"),
    )
    await mkdir(join(dir, "agents"), { recursive: true })
    await writeFile(join(dir, "agents", "openai.yaml"), okYaml, "utf8")
    await mkdir(join(dir, "scripts"), { recursive: true })
    await writeFile(join(dir, "scripts", "run.sh"), "#!/bin/sh\n", "utf8")
    await writeFile(join(dir, "scripts", "build.sh"), "#!/bin/sh\n", "utf8")
    await mkdir(join(dir, "references"), { recursive: true })
    await writeFile(join(dir, "references", "spec.md"), "# spec\n", "utf8")

    const skills = await discoverSkills(root)
    const r = skills[0]?.resources
    expect(r?.agentsYaml?.displayName).toBe("rr")
    expect(r?.scripts).toEqual(["build.sh", "run.sh"]) // sorted
    expect(r?.references).toEqual(["spec.md"])
    expect(r?.assets).toBeUndefined() // dir absent ⇒ omitted
  })

  test("references/assets are NOT loaded into the skill body (presence only)", async () => {
    const root = await tmpDir("adr0457-c2-")
    const dir = await writeNestedSkill(
      root,
      "rr",
      ["---", "name: rr", "description: d", "---", "the body"].join("\n"),
    )
    await mkdir(join(dir, "references"), { recursive: true })
    await writeFile(join(dir, "references", "huge.md"), "SECRET-REFERENCE-CONTENT", "utf8")
    const skills = await discoverSkills(root)
    expect(skills[0]?.body).toBe("the body")
    expect(skills[0]?.body).not.toContain("SECRET-REFERENCE-CONTENT")
    expect(skills[0]?.resources?.references).toEqual(["huge.md"])
  })

  test("MALFORMED agents/openai.yaml ⇒ graceful skip, discovery never crashes", async () => {
    const root = await tmpDir("adr0457-c3-")
    const dir = await writeNestedSkill(
      root,
      "rr",
      ["---", "name: rr", "description: d", "---", "body"].join("\n"),
    )
    await mkdir(join(dir, "agents"), { recursive: true })
    // Binary garbage / no interface block at all.
    await writeFile(join(dir, "agents", "openai.yaml"), "\x00 not yaml : : [", "utf8")
    const skills = await discoverSkills(root)
    expect(skills).toHaveLength(1) // skill itself survives
    expect(skills[0]?.resources?.agentsYaml).toBeUndefined() // resource omitted
  })

  test("discoverSkillResources returns undefined when no subdirs exist", async () => {
    const root = await tmpDir("adr0457-c4-")
    const dir = await writeNestedSkill(
      root,
      "plain",
      ["---", "name: plain", "description: d", "---", "body"].join("\n"),
    )
    const res = await discoverSkillResources(join(dir, "SKILL.md"))
    expect(res).toBeUndefined()
  })
})

// ── Regression anchor: byte-identical for a plain SKILL.md ─────────────────

describe("REGRESSION — plain SKILL.md is byte-identical (no new fields)", () => {
  const plain = ["---", "name: plain", "description: A plain skill.", "---", "Body line."].join(
    "\n",
  )

  test("lenient parse yields no new keys", () => {
    const { data } = parseFrontmatter(plain)
    expect(data["argument-hint"]).toBeUndefined()
    expect(data["metadata.short-description"]).toBeUndefined()
  })

  test("discovered skill has none of the new fields set", async () => {
    const root = await tmpDir("adr0457-reg-")
    await writeNestedSkill(root, "plain", plain)
    const skills = await discoverSkills(root)
    const s = skills[0]
    expect(s?.argumentHint).toBeUndefined()
    expect(s?.shortDescription).toBeUndefined()
    expect(s?.resources).toBeUndefined()
  })

  test("listing row is exactly the pre-0457 shape", () => {
    expect(
      skillCatalogueRow({
        name: "plain",
        description: "A plain skill.",
        body: "",
        sourcePath: "/x/plain/SKILL.md",
        scope: "user",
      }),
    ).toBe("- plain: A plain skill.")
  })

  test("strict schema still accepts the minimal canonical frontmatter", () => {
    const ok = SkillFrontmatterSchema.safeParse({
      name: "plain",
      description: "A plain skill.",
      userInvocable: true,
      allowedTools: [],
      category: "skill",
      stability: "stable",
    })
    expect(ok.success).toBe(true)
  })
})

// ── Cross-path consistency: strict + lenient agree on codex SKILL.md ───────

describe("strict + lenient parse paths stay CONSISTENT on a codex SKILL.md", () => {
  // NOTE: the strict parser (quanta CORE) supports FLOW lists only, not block
  // lists — that predates ADR-0457 and is intentionally unchanged. So the
  // strict-compatible form uses `allowedTools: ["Read"]`. Discovery (lenient)
  // accepts both; this fixture deliberately uses the strict-compatible flow
  // form so BOTH paths can parse the SAME text and be compared.
  const codex = [
    "---",
    "name: rr2",
    "description: Escalation review-and-repair skill.",
    'argument-hint: "[scope]"',
    "userInvocable: true",
    'allowedTools: ["Read"]',
    "metadata:",
    "  short-description: Urgent Semantica review, repair, and prevention",
    "category: skill",
    "stability: stable",
    "---",
    "# RR2",
  ].join("\n")

  test("strict path accepts it and exposes argument-hint + metadata", () => {
    const r = parseSkillMarkdown(codex)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.frontmatter["argument-hint"]).toBe("[scope]")
      expect(r.value.frontmatter.metadata).toEqual({
        "short-description": "Urgent Semantica review, repair, and prevention",
      })
    }
  })

  test("lenient path exposes the SAME hint + short-description values", () => {
    const { data } = parseFrontmatter(codex)
    expect(data["argument-hint"]).toBe("[scope]")
    expect(data["metadata.short-description"]).toBe(
      "Urgent Semantica review, repair, and prevention",
    )
  })
})
