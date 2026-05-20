import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Skill } from "../../src/skill"
import {
  createSkillTool,
  createToolSearchTool,
  discoverSkills,
  parseFrontmatter,
  skillsActivatedFor,
  skillToolAllowlist,
} from "../../src/skill"
import type { ToolContext, ToolResult, ToolSpec } from "../../src/tool"

// W1-C audit finding: this file used `mkdtemp` once with NO cleanup, leaking
// /tmp dirs on every test run. Route through `tmpDir(prefix)` and register
// for `afterAll` removal.
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
      // best-effort cleanup
    }
  }
})

const CTX: ToolContext = { cwd: "/", signal: new AbortController().signal }

/** Drain a tool's execute() and return the terminal result. */
const run = async (
  tool: { execute: (i: never, c: ToolContext) => AsyncIterable<unknown> },
  input: unknown,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, CTX)) {
    const e = ev as { type: string; result?: ToolResult }
    if (e.type === "result") result = e.result
  }
  if (!result) throw new Error("tool produced no result")
  return result
}

describe("parseFrontmatter", () => {
  test("scalars, inline list, block list, body", () => {
    const { data, body } = parseFrontmatter(
      [
        "---",
        "name: my-skill",
        'description: "does a thing"',
        'tools: ["Read", "Bash(git *)"]',
        "paths:",
        "  - src/**/*.ts",
        '  - "**/*.tf"',
        "model: inherit",
        "effort: high",
        "---",
        "",
        "# Body heading",
        "do the work",
      ].join("\n"),
    )
    expect(data.name).toBe("my-skill")
    expect(data.description).toBe("does a thing")
    expect(data.tools).toEqual(["Read", "Bash(git *)"])
    expect(data.paths).toEqual(["src/**/*.ts", "**/*.tf"])
    expect(data.model).toBe("inherit")
    expect(data.effort).toBe("high")
    expect(body).toBe("# Body heading\ndo the work")
  })

  test("missing optionals: only name + description", () => {
    const { data, body } = parseFrontmatter(
      "---\nname: bare\ndescription: minimal\n---\nbody text\n",
    )
    expect(data).toEqual({ name: "bare", description: "minimal" })
    expect(body.trimEnd()).toBe("body text")
  })

  test("no frontmatter ⇒ all body", () => {
    const { data, body } = parseFrontmatter("just markdown\nmore")
    expect(data).toEqual({})
    expect(body).toBe("just markdown\nmore")
  })

  test("CRLF and unterminated frontmatter are tolerated", () => {
    const { body } = parseFrontmatter("---\r\nname: x\r\nbody with no closing fence")
    expect(body).toContain("body with no closing fence")
  })
})

describe("discoverSkills", () => {
  test("nested SKILL.md + flat *.md, sorted, name override, collision", async () => {
    const dir = await tmpDir("skills-")

    await mkdir(join(dir, "alpha"))
    await writeFile(
      join(dir, "alpha", "SKILL.md"),
      [
        "---",
        "name: alpha",
        "description: alpha skill",
        'tools: ["Read"]',
        "model: claude-x",
        "effort: 2",
        "paths:",
        "  - src/**/*.ts",
        "---",
        "alpha body",
      ].join("\n"),
    )

    // flat command file
    await writeFile(join(dir, "zeta.md"), "---\ndescription: zeta cmd\n---\nzeta body")

    // collision: directory form must win over flat form of same id
    await writeFile(join(dir, "alpha.md"), "---\ndescription: FLAT alpha\n---\nflat")

    // a directory without SKILL.md is ignored
    await mkdir(join(dir, "not-a-skill"))
    await writeFile(join(dir, "not-a-skill", "README.md"), "nope")

    const skills = await discoverSkills(dir)
    expect(skills.map((s) => s.name)).toEqual(["alpha", "zeta"])

    const alpha = skills[0] as Skill
    expect(alpha.description).toBe("alpha skill") // dir form won
    expect(alpha.body).toBe("alpha body")
    expect(alpha.tools).toEqual(["Read"])
    expect(alpha.model).toBe("claude-x")
    expect(alpha.effort).toBe(2)
    expect(alpha.paths).toEqual(["src/**/*.ts"])

    const zeta = skills[1] as Skill
    expect(zeta.description).toBe("zeta cmd")
    expect(zeta.tools).toBeUndefined()
  })

  test("missing dir ⇒ []", async () => {
    expect(await discoverSkills(join(tmpdir(), "does-not-exist-xyz"))).toEqual([])
  })
})

describe("createSkillTool", () => {
  const skills: Skill[] = [
    {
      name: "deploy",
      description: "deploy things",
      body: "Step 1. Do the deploy.",
      tools: ["Bash"],
      model: "claude-fast",
      effort: "high",
      sourcePath: "/x/deploy/SKILL.md",
    },
    { name: "plain", description: "no scope", body: "just do it", sourcePath: "/x/plain.md" },
  ]

  test("returns body plus an advisory (not enforced) scoping note", async () => {
    const tool = createSkillTool(skills)
    const r = await run(tool, { name: "deploy" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("tools: Bash")
    expect(r.output).toContain("model: claude-fast")
    expect(r.output).toContain("effort: high")
    expect(r.output).toContain("Step 1. Do the deploy.")
    // Honesty: the note must flag the scope as advisory and must NOT claim it
    // is enforced anywhere.
    expect(r.output.toLowerCase()).toContain("advisory")
    expect(r.output.toLowerCase()).toContain("not enforced")
    expect(r.output).not.toContain("enforced by the main thread")
  })

  test("no scope declared ⇒ 'none declared' note", async () => {
    const r = await run(createSkillTool(skills), { name: "plain" })
    expect(r.output).toContain("none declared")
    expect(r.output).toContain("just do it")
  })

  test("skillToolAllowlist exposes the host enforcement seam", () => {
    // Declared allowlist is returned verbatim for a host to apply.
    expect(skillToolAllowlist(skills[0] as Skill)).toEqual(["Bash"])
    // No declared tools ⇒ undefined (nothing to enforce).
    expect(skillToolAllowlist(skills[1] as Skill)).toBeUndefined()
    expect(
      skillToolAllowlist({ name: "x", description: "", body: "", tools: [], sourcePath: "p" }),
    ).toBeUndefined()
  })

  test("tolerates a leading slash and reports unknown skills", async () => {
    const tool = createSkillTool(skills)
    expect((await run(tool, { name: "/deploy" })).ok).toBe(true)
    const miss = await run(tool, { name: "ghost" })
    expect(miss.ok).toBe(false)
    expect(miss.output).toContain("Unknown skill: ghost")
  })
})

describe("createToolSearchTool", () => {
  const catalog = (): ToolSpec[] => [
    {
      name: "readFile",
      description: "Read a text file from disk",
      input_schema: { type: "object" },
    },
    {
      name: "writeFile",
      description: "Write content to a file on disk",
      input_schema: { type: "object" },
    },
    {
      name: "mcp__github__create_pr",
      description: "Open a pull request on GitHub",
      input_schema: { type: "object" },
    },
  ]

  test("keyword search ranks by name + description hits", async () => {
    const r = await run(createToolSearchTool(catalog), { query: "file read" })
    expect(r.ok).toBe(true)
    // readFile matches both the 'file' and 'read' terms ⇒ ranked first.
    expect(r.output.indexOf("readFile")).toBeLessThan(r.output.indexOf("writeFile"))
  })

  test("no matches ⇒ ok:false", async () => {
    const r = await run(createToolSearchTool(catalog), { query: "kubernetes" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("No matching")
    // Honesty: failure copy must not imply a deferred-tool mechanism exists.
    expect(r.output.toLowerCase()).not.toContain("defer")
  })

  test("model-facing description is honest: no defer/expand over-claim", () => {
    const tool = createToolSearchTool(catalog)
    const desc = tool.description.toLowerCase()
    // It is a catalog discovery aid, not server-side deferral/expansion.
    expect(desc).not.toContain("defer")
    expect(desc).not.toContain("expand")
    expect(desc).not.toContain("tool_reference")
    expect(desc).toContain("catalog")
    // The query-field description (also model-facing) must not say "defer".
    const shape = (tool.inputSchema as unknown as { shape: { query: { description?: string } } })
      .shape
    expect((shape.query.description ?? "").toLowerCase()).not.toContain("defer")
  })

  test("select: mode returns exact tools and flags unknowns", async () => {
    const r = await run(createToolSearchTool(catalog), {
      query: "select:writeFile,nope",
    })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("### writeFile")
    expect(r.output).toContain("input_schema")
    expect(r.output).toContain("Unknown: nope")
  })
})

describe("skillsActivatedFor", () => {
  const skills: Skill[] = [
    { name: "tf", description: "", body: "", paths: ["**/*.tf"], sourcePath: "a" },
    { name: "ts", description: "", body: "", paths: ["src/**/*.ts"], sourcePath: "b" },
    { name: "always", description: "", body: "", sourcePath: "c" }, // no paths
  ]

  test("matches gitignore-style globs; skills without paths never activate", () => {
    expect(skillsActivatedFor(skills, ["infra/main.tf"]).map((s) => s.name)).toEqual(["tf"])
    expect(skillsActivatedFor(skills, ["src/a/b.ts"]).map((s) => s.name)).toEqual(["ts"])
    expect(skillsActivatedFor(skills, ["src/a/b.ts", "x.tf"]).map((s) => s.name)).toEqual([
      "tf",
      "ts",
    ])
    expect(skillsActivatedFor(skills, ["README.md"])).toEqual([])
  })
})
