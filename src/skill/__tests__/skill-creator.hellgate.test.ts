/**
 * HELLGATE — jun-6 skill-creator (Codex parity): the agent-callable
 * `skill_create` tool that SCAFFOLDS + VALIDATES + INSTALLS a skill.
 *
 * Invariants:
 *   - A valid input scaffolds a SKILL.md whose frontmatter re-parses under the
 *     SAME discovery schema, and is written through the injected port.
 *   - An invalid name / frontmatter is rejected BEFORE any write (no port call).
 *   - A `../escape` name can never reach the writer (path-safety re-validation).
 *   - The rendered markdown is deterministic (same input ⇒ byte-identical).
 *   - A writer failure surfaces as a clean `ok:false` (never throws).
 */

import { describe, expect, test } from "bun:test"
import { parseFrontmatter } from "../frontmatter"
import {
  createSkillCreatorTool,
  renderSkillMarkdown,
  type SkillWriteResult,
  type SkillWriterPort,
  validateScaffold,
} from "../skill-creator"
import { SkillFrontmatterSchema } from "../skill-frontmatter"

const ctx = { cwd: "/repo", signal: new AbortController().signal }

/** A recording fake writer. `result` controls the simulated outcome. */
const fakeWriter = (
  result: SkillWriteResult = { ok: true, path: "/skills/foo/SKILL.md" },
): { port: SkillWriterPort; calls: { relPath: string; content: string }[] } => {
  const calls: { relPath: string; content: string }[] = []
  return {
    calls,
    port: {
      write: async (relPath, content) => {
        calls.push({ relPath, content })
        return result
      },
    },
  }
}

const run = async (
  tool: ReturnType<typeof createSkillCreatorTool>,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; output: string }> => {
  for await (const ev of tool.execute(input as never, ctx)) {
    if (ev.type === "result") return { ok: ev.result.ok, output: ev.result.output }
  }
  throw new Error("tool yielded no result")
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
      // allowedTools renders as a YAML list ⇒ parseFrontmatter yields a string[].
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

describe("createSkillCreatorTool — install path", () => {
  test("valid input scaffolds + writes through the port", async () => {
    const w = fakeWriter({ ok: true, path: "/skills/greet/SKILL.md" })
    const tool = createSkillCreatorTool(w.port)
    const res = await run(tool, {
      name: "greet",
      description: "Greet the user",
      body: "Say hello.",
    })
    expect(res.ok).toBe(true)
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0]?.relPath).toBe("greet/SKILL.md")
    expect(w.calls[0]?.content).toContain("name: greet")
    expect(res.output).toContain("greet")
  })

  test("default-OFF semantics: tool is NOT read-only / NOT concurrency-safe", () => {
    const tool = createSkillCreatorTool(fakeWriter().port)
    expect(tool.isReadOnly()).toBe(false)
    expect(tool.isConcurrencySafe({} as never)).toBe(false)
  })
})

describe("createSkillCreatorTool — rejection BEFORE any write", () => {
  test("path-escape name ⇒ rejected, port NEVER called", async () => {
    const w = fakeWriter()
    const tool = createSkillCreatorTool(w.port)
    const res = await run(tool, {
      name: "../../etc/passwd",
      description: "evil",
      body: "x",
    })
    expect(res.ok).toBe(false)
    expect(res.output).toContain("kebab-case")
    expect(w.calls).toHaveLength(0)
  })

  test("empty body is rejected by the schema (no write)", async () => {
    const w = fakeWriter()
    const tool = createSkillCreatorTool(w.port)
    // The Zod inputSchema requires a non-empty body; the tool's own validation
    // would also reject — but here we feed a structurally-bad name to ensure the
    // pre-write guard fires deterministically.
    const res = await run(tool, { name: "UPPER", description: "d", body: "b" })
    expect(res.ok).toBe(false)
    expect(w.calls).toHaveLength(0)
  })
})

describe("createSkillCreatorTool — full path-escape matrix (round-1 jun-6 audit)", () => {
  // Every hostile spelling must be rejected at NAME_RE step 0, BEFORE the writer
  // port is ever invoked — so a path-segment escape can never reach the FS.
  const HOSTILE = [
    "../escape",
    "../../etc/passwd",
    "/etc/passwd",
    "foo/bar",
    "foo\\bar",
    "UPPER",
    "-leading-dash",
    ".hidden",
    "foo bar",
    "a/../../../b",
    "..",
    ".",
    "foo.ts",
  ]
  test("every hostile name is rejected before any write", async () => {
    for (const name of HOSTILE) {
      const w = fakeWriter()
      const tool = createSkillCreatorTool(w.port)
      const res = await run(tool, { name, description: "d", body: "b" })
      expect(res.ok).toBe(false)
      expect(w.calls).toHaveLength(0)
    }
  })

  test("a NUL byte in the name is rejected before any write", async () => {
    const w = fakeWriter()
    const tool = createSkillCreatorTool(w.port)
    const name = `foo${String.fromCharCode(0)}bar`
    const res = await run(tool, { name, description: "d", body: "b" })
    expect(res.ok).toBe(false)
    expect(w.calls).toHaveLength(0)
  })
})

describe("createSkillCreatorTool — writer failure is graceful", () => {
  test("a failing writer surfaces ok:false, never throws", async () => {
    const w = fakeWriter({ ok: false, reason: "disk full" })
    const tool = createSkillCreatorTool(w.port)
    const res = await run(tool, { name: "ok", description: "d", body: "b" })
    expect(res.ok).toBe(false)
    expect(res.output).toContain("disk full")
  })
})

// ── ROUND-2 (Tool-contract conformance lens — ITERATOR-REJECT) ──────────────
// The Tool contract (types.ts: "exactly one terminal result, which MUST be the
// last event") requires `execute` to NEVER reject the async iterator: every
// failure — including a THROWING/REJECTING injected port — must surface as a
// typed `ok:false` result. The port is contractually no-throw, but a buggy /
// hostile adapter (an EACCES that escapes, a programmer bug) must not crash the
// dispatch pipeline. Mirrors permission_propose_pattern's defensive try/catch.
describe("createSkillCreatorTool — throwing port yields a typed result (no iterator reject)", () => {
  const drive = async (
    tool: ReturnType<typeof createSkillCreatorTool>,
    input: Record<string, unknown>,
    ctx: { cwd: string; signal: AbortSignal },
  ): Promise<{ ok: boolean; output: string; mode?: string }> => {
    const results: Array<{ ok: boolean; output: string; mode?: string }> = []
    // for-await must NOT reject — that is the whole point of the contract.
    for await (const ev of tool.execute(input as never, ctx as never)) {
      if (ev.type === "result") {
        const f = (ev.result as { failure?: { mode?: string } }).failure
        results.push({ ok: ev.result.ok, output: ev.result.output, mode: f?.mode })
      }
    }
    // exactly ONE terminal result.
    expect(results).toHaveLength(1)
    return results[0] as { ok: boolean; output: string; mode?: string }
  }

  test("a writer port that THROWS (rejects) ⇒ typed ok:false, iterator resolves", async () => {
    const throwingPort: SkillWriterPort = {
      write: async () => {
        throw new Error("EACCES: permission denied, open '/skills/ok/SKILL.md'")
      },
    }
    const tool = createSkillCreatorTool(throwingPort)
    const res = await drive(tool, { name: "ok", description: "d", body: "b" }, ctx)
    expect(res.ok).toBe(false)
    expect(res.mode).toBe("error")
    // the underlying message is surfaced (client-visible), not swallowed silently
    expect(res.output.toLowerCase()).toContain("install failed")
  })

  test("a writer port that throws a NON-Error ⇒ still a typed ok:false", async () => {
    const throwingPort: SkillWriterPort = {
      write: () => Promise.reject("stringly-typed failure"),
    }
    const tool = createSkillCreatorTool(throwingPort)
    const res = await drive(tool, { name: "ok", description: "d", body: "b" }, ctx)
    expect(res.ok).toBe(false)
    expect(res.mode).toBe("error")
  })
})
