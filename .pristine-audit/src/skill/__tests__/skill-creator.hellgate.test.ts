/**
 * HELLGATE — jun-6 + RFC03-2 skill-creator: the agent-callable `skill_create`
 * tool that COMPILES an immutable proposal and STAGES it for review.
 *
 * RFC03-2 CUTOVER: the tool no longer writes to the live skill directory on
 * invoke. Invariants:
 *   - `renderSkillMarkdown` / `validateScaffold` stay deterministic + schema-
 *     valid (unchanged pure helpers, still used by the compiler).
 *   - A valid input + resolving evidence ⇒ the proposal is STAGED (bytes handed
 *     to the stage port), NOT written to any live dir.
 *   - Empty / unresolved evidence ⇒ rejected, NO stage call (anti-vacuous).
 *   - A `../escape` name is rejected by the compiler, NO stage call.
 *   - A throwing stage port surfaces a clean typed `ok:false` (iterator resolves).
 */

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseFrontmatter } from "../frontmatter"

// Slice fence: @/skill (incl. its tests) may NOT reach @/storage. Inline the
// two primitives the fake io needs (sha256 + canonicalize) with node builtins.
const sha256Hex = (c: string): string => createHash("sha256").update(c, "utf8").digest("hex")
const canonicalizePath = (p: string): string => resolve(p)

import type { ProposalIo } from "../proposal/compiler"
import type { SkillProposalStagePort } from "../proposal/port"
import {
  createSkillCreatorTool,
  renderSkillMarkdown,
  type SkillCreatorDeps,
  validateScaffold,
} from "../skill-creator"
import { SkillFrontmatterSchema } from "../skill-frontmatter"

const ctx = { cwd: "/repo", signal: new AbortController().signal }

/** A recording fake stage port. Records every stage call so a test can assert
 *  the proposal WAS (or was NOT) staged. */
type StageCall = { proposalId: string; name: string; bytes: string; targetPath: string }
const fakeStage = (onStage?: () => void): { port: SkillProposalStagePort; calls: StageCall[] } => {
  const calls: StageCall[] = []
  return {
    calls,
    port: {
      stage: async (a) => {
        onStage?.()
        calls.push({
          proposalId: a.proposalId,
          name: a.name,
          bytes: a.bytes,
          targetPath: a.targetPath,
        })
        return { proposalId: a.proposalId }
      },
    },
  }
}

/** A ProposalIo over a real temp evidence root. */
const makeIo = (roots: string[], system: string[] = [], discovered: string[] = []): ProposalIo => ({
  sha256: (c) => sha256Hex(c),
  resolveUnderRoots: (p) => {
    const canonical = canonicalizePath(p)
    return roots.some((r) => canonical === r || canonical.startsWith(`${r}/`)) ? canonical : null
  },
  readIfExists: async (p) => {
    try {
      return await (await import("node:fs/promises")).readFile(p, "utf8")
    } catch {
      return null
    }
  },
  systemSkillNames: new Set(system),
  discoveredSkillNames: new Set(discovered),
})

const run = async (
  tool: ReturnType<typeof createSkillCreatorTool>,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; output: string; mode?: string }> => {
  const results: { ok: boolean; output: string; mode?: string }[] = []
  for await (const ev of tool.execute(input as never, ctx)) {
    if (ev.type === "result") {
      const f = (ev.result as { failure?: { mode?: string } }).failure
      results.push({
        ok: ev.result.ok,
        output: ev.result.output,
        ...(f?.mode !== undefined ? { mode: f.mode } : {}),
      })
    }
  }
  // exactly ONE terminal result (Tool contract).
  expect(results).toHaveLength(1)
  return results[0] as { ok: boolean; output: string; mode?: string }
}

describe("renderSkillMarkdown — deterministic + schema-valid", () => {
  test("rendered frontmatter re-parses under the discovery schema", () => {
    const md = renderSkillMarkdown({
      name: "pdf-extract",
      description: "Extract text from a PDF",
      body: "Use the read tool on the PDF.",
      userInvocable: true,
      allowedTools: ["read", "bash"],
      category: "skill",
      stability: "experimental",
    })
    const { data, body } = parseFrontmatter(md)
    expect(body).toContain("Use the read tool")
    const parsed = SkillFrontmatterSchema.safeParse({
      ...data,
      userInvocable: data.userInvocable === "true",
      allowedTools: Array.isArray(data.allowedTools) ? data.allowedTools : [data.allowedTools],
    })
    expect(parsed.success).toBe(true)
  })

  test("same input ⇒ byte-identical output", () => {
    const fields = {
      name: "a",
      description: "d",
      body: "b",
      userInvocable: false,
      allowedTools: [] as string[],
      category: "skill" as const,
      stability: "stable" as const,
    }
    expect(renderSkillMarkdown(fields)).toBe(renderSkillMarkdown(fields))
  })
})

describe("validateScaffold — schema reuse", () => {
  test("kebab-case violation rejected with schema message", () => {
    const err = validateScaffold({
      name: "Bad Name",
      description: "d",
      body: "b",
      userInvocable: true,
      allowedTools: [],
      category: "skill",
      stability: "experimental",
    })
    expect(err).not.toBeNull()
    expect(err).toContain("kebab")
  })

  test("valid fields ⇒ null", () => {
    expect(
      validateScaffold({
        name: "ok-skill",
        description: "d",
        body: "b",
        userInvocable: true,
        allowedTools: [],
        category: "skill",
        stability: "experimental",
      }),
    ).toBeNull()
  })
})

describe("createSkillCreatorTool — RFC03-2 proposal-stage (NO live write)", () => {
  test("valid input + resolving evidence ⇒ proposal STAGED, not written", async () => {
    const root = await mkdtemp(join(tmpdir(), "sc-ok-"))
    try {
      const ev = join(root, "raw_memories.md")
      await writeFile(ev, "I did the greet flow three times")
      const stage = fakeStage()
      const deps: SkillCreatorDeps = {
        io: makeIo([canonicalizePath(root)]),
        stage: stage.port,
        generatorVersion: "test@1",
      }
      const tool = createSkillCreatorTool(deps)
      const res = await run(tool, {
        name: "greet",
        description: "Greet the user",
        body: "Say hello.",
        evidence: [ev],
      })
      expect(res.ok).toBe(true)
      expect(stage.calls).toHaveLength(1)
      expect(stage.calls[0]?.name).toBe("greet")
      expect(stage.calls[0]?.targetPath).toBe("greet/SKILL.md")
      expect(stage.calls[0]?.bytes).toContain("name: greet")
      // proposalId is content-addressed (== draftHash of the staged bytes).
      expect(stage.calls[0]?.proposalId).toBe(sha256Hex(stage.calls[0]?.bytes ?? ""))
      expect(res.output.toLowerCase()).toContain("staged for review")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("default-OFF semantics: tool is NOT read-only / NOT concurrency-safe", () => {
    const tool = createSkillCreatorTool({
      io: makeIo(["/nope"]),
      stage: fakeStage().port,
      generatorVersion: "t",
    })
    expect(tool.isReadOnly()).toBe(false)
    expect(tool.isConcurrencySafe({} as never)).toBe(false)
  })
})

describe("createSkillCreatorTool — anti-vacuous evidence gate (NO stage)", () => {
  test("empty evidence ⇒ rejected, stage NEVER called", async () => {
    const stage = fakeStage()
    const tool = createSkillCreatorTool({
      io: makeIo(["/nope"]),
      stage: stage.port,
      generatorVersion: "t",
    })
    const res = await run(tool, {
      name: "greet",
      description: "d",
      body: "b",
      evidence: [] as string[],
    })
    expect(res.ok).toBe(false)
    expect(stage.calls).toHaveLength(0)
  })

  test("unresolved evidence path ⇒ rejected, stage NEVER called", async () => {
    const root = await mkdtemp(join(tmpdir(), "sc-unres-"))
    try {
      const stage = fakeStage()
      const tool = createSkillCreatorTool({
        io: makeIo([canonicalizePath(root)]),
        stage: stage.port,
        generatorVersion: "t",
      })
      const res = await run(tool, {
        name: "greet",
        description: "d",
        body: "b",
        evidence: [join(root, "ghost.md")],
      })
      expect(res.ok).toBe(false)
      expect(stage.calls).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("createSkillCreatorTool — path-escape names rejected (NO stage)", () => {
  const HOSTILE = [
    "../escape",
    "../../etc/passwd",
    "/etc/passwd",
    "foo/bar",
    "UPPER",
    ".hidden",
    "foo bar",
    "..",
  ]
  test("every hostile name is rejected before any stage call", async () => {
    const root = await mkdtemp(join(tmpdir(), "sc-hostile-"))
    try {
      const ev = join(root, "e.md")
      await writeFile(ev, "evidence")
      for (const name of HOSTILE) {
        const stage = fakeStage()
        const tool = createSkillCreatorTool({
          io: makeIo([canonicalizePath(root)]),
          stage: stage.port,
          generatorVersion: "t",
        })
        const res = await run(tool, { name, description: "d", body: "b", evidence: [ev] })
        expect(res.ok).toBe(false)
        expect(stage.calls).toHaveLength(0)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("createSkillCreatorTool — throwing stage port yields a typed result", () => {
  test("a stage port that THROWS ⇒ typed ok:false, iterator resolves", async () => {
    const root = await mkdtemp(join(tmpdir(), "sc-throw-"))
    try {
      const ev = join(root, "e.md")
      await writeFile(ev, "evidence")
      const throwingStage: SkillProposalStagePort = {
        stage: async () => {
          throw new Error("EACCES staging")
        },
      }
      const tool = createSkillCreatorTool({
        io: makeIo([canonicalizePath(root)]),
        stage: throwingStage,
        generatorVersion: "t",
      })
      const res = await run(tool, { name: "ok", description: "d", body: "b", evidence: [ev] })
      expect(res.ok).toBe(false)
      expect(res.mode).toBe("error")
      expect(res.output.toLowerCase()).toContain("stage port threw")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
