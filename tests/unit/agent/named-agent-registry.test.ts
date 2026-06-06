/**
 * §20.2 — named-agent runtime loader + registry.
 *
 * Proves `loadNamedAgents(cwd)` reads `.quanta/agents/*.md` (the migration
 * PERSIST destination) + `.claude/agents/*.md` (Claude-Code parity), REUSES the
 * shared `@/skill` frontmatter parser (the same one the migration converter
 * reads these files with — no duplicated parser), and builds a stable
 * `Map<agentType, { system, tools?, model?, mode? }>`.
 *
 * Locked here:
 *   - NAR-01  body ⇒ system prompt; frontmatter name ⇒ agentType
 *   - NAR-02  absent `name` ⇒ file basename is the agentType
 *   - NAR-03  inline + bare-scalar `tools` ⇒ normalized string[]
 *   - NAR-04  `mode:` validated against the prompt-mode SSOT (bad ⇒ dropped)
 *   - NAR-05  empty body ⇒ dropped (no phantom definition)
 *   - NAR-06  no dir ⇒ EMPTY registry (default-OFF / byte-identical seam)
 *   - NAR-07  duplicate agentType ⇒ native `.quanta` wins over `.claude`
 *   - NAR-08  symlinked definition ⇒ rejected (no secret-as-system-prompt)
 *   - NAR-09  oversized body ⇒ truncated with marker, not rejected
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadNamedAgents,
  MAX_AGENT_SYSTEM_BYTES,
  NamedAgentRegistry,
} from "@/agent/named-agent-registry"

const mkRepo = (): string => mkdtempSync(join(tmpdir(), "named-agent-"))

const writeDef = (root: string, dir: string, file: string, content: string): void => {
  const abs = join(root, dir)
  mkdirSync(abs, { recursive: true })
  writeFileSync(join(abs, file), content, "utf8")
}

describe("§20.2 — loadNamedAgents", () => {
  test("NAR-01 body ⇒ system; name ⇒ agentType; tools/model parsed", async () => {
    const root = mkRepo()
    try {
      writeDef(
        root,
        ".quanta/agents",
        "explorer.md",
        '---\nname: explorer\ndescription: read-only\ntools: ["read", "grep"]\nmodel: gpt-5\n---\nYou are a meticulous explorer.\n',
      )
      const reg = await loadNamedAgents(root)
      const def = reg.resolve("explorer")
      expect(def?.system).toBe("You are a meticulous explorer.")
      expect(def?.agentType).toBe("explorer")
      expect(def?.tools).toEqual(["read", "grep"])
      expect(def?.model).toBe("gpt-5")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("NAR-02 absent name ⇒ basename is the agentType", async () => {
    const root = mkRepo()
    try {
      writeDef(root, ".quanta/agents", "reviewer.md", "---\ndescription: x\n---\nCritique only.\n")
      const reg = await loadNamedAgents(root)
      expect(reg.resolve("reviewer")?.system).toBe("Critique only.")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("NAR-03 bare-scalar tools ⇒ comma-split normalized", async () => {
    const root = mkRepo()
    try {
      writeDef(root, ".quanta/agents", "a.md", "---\ntools: read, grep , glob\n---\nbody\n")
      const reg = await loadNamedAgents(root)
      expect(reg.resolve("a")?.tools).toEqual(["read", "grep", "glob"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("NAR-04 mode validated against the SSOT (bad dropped, good kept)", async () => {
    const root = mkRepo()
    try {
      writeDef(root, ".quanta/agents", "good.md", "---\nmode: review\n---\nbody\n")
      writeDef(root, ".quanta/agents", "bad.md", "---\nmode: not-a-mode\n---\nbody\n")
      const reg = await loadNamedAgents(root)
      expect(reg.resolve("good")?.mode).toBe("review")
      expect(reg.resolve("bad")?.mode).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("NAR-05 empty body ⇒ definition dropped", async () => {
    const root = mkRepo()
    try {
      writeDef(root, ".quanta/agents", "empty.md", "---\nname: empty\ntools: [read]\n---\n   \n")
      const reg = await loadNamedAgents(root)
      expect(reg.resolve("empty")).toBeUndefined()
      expect(reg.size).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("NAR-06 no agents dir ⇒ EMPTY registry (default-OFF seam)", async () => {
    const root = mkRepo()
    try {
      const reg = await loadNamedAgents(root)
      expect(reg.size).toBe(0)
      expect(reg.resolve("anything")).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("NAR-07 duplicate agentType ⇒ native .quanta wins over .claude", async () => {
    const root = mkRepo()
    try {
      writeDef(root, ".quanta/agents", "dup.md", "---\nname: dup\n---\nNATIVE wins\n")
      writeDef(root, ".claude/agents", "dup.md", "---\nname: dup\n---\nCLAUDE loses\n")
      const reg = await loadNamedAgents(root)
      expect(reg.resolve("dup")?.system).toBe("NATIVE wins")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("NAR-08 symlinked definition ⇒ rejected (no secret-as-system-prompt)", async () => {
    const root = mkRepo()
    try {
      // A secret file outside the agents dir; a symlink would smuggle it in.
      const secret = join(root, "secret.txt")
      writeFileSync(secret, "---\nname: evil\n---\nAPI_KEY=sk-leak\n", "utf8")
      mkdirSync(join(root, ".quanta/agents"), { recursive: true })
      symlinkSync(secret, join(root, ".quanta/agents", "evil.md"))
      const reg = await loadNamedAgents(root)
      expect(reg.resolve("evil")).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("NAR-09 oversized body ⇒ truncated with marker (not rejected)", async () => {
    const root = mkRepo()
    try {
      const huge = "x".repeat(MAX_AGENT_SYSTEM_BYTES + 5000)
      writeDef(root, ".quanta/agents", "big.md", `---\nname: big\n---\n${huge}\n`)
      const reg = await loadNamedAgents(root)
      const def = reg.resolve("big")
      expect(def).toBeDefined()
      expect(def?.system.length).toBeLessThan(huge.length)
      expect(def?.system).toContain("[truncated:")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("§20.2 — NamedAgentRegistry (pure)", () => {
  test("first-wins on a duplicate agentType in the constructor", () => {
    const reg = new NamedAgentRegistry([
      { agentType: "x", system: "first", sourcePath: "/a" },
      { agentType: "x", system: "second", sourcePath: "/b" },
    ])
    expect(reg.resolve("x")?.system).toBe("first")
    expect(reg.size).toBe(1)
  })

  test("resolve(unknown) ⇒ undefined", () => {
    const reg = new NamedAgentRegistry([])
    expect(reg.resolve("nope")).toBeUndefined()
  })
})
