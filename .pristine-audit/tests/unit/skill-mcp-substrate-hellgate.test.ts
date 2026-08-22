/**
 * ★ CONTRACT — ADR-0476 skill→MCP substrate threading (the "deps channel").
 *
 * The per-turn MCP reconcile (`reconcileSkillMcpForTurn`) needs each active
 * skill's raw `dependencies` block. This battery pins the WHOLE channel that
 * carries it from disk to the reconcile call:
 *
 *   discover (lift from full SKILL.md)  →  Skill.rawDependencies
 *     →  buildSkillBlock inventory (GATED propagation)
 *       →  augmentActiveSkillsWithPlugin (preserved through union)
 *         →  reconcileSkillMcpDepsForTurn (mapped onto ActiveSkillDeps)
 *
 * Invariants under test:
 *   - The block is lifted from the FULL content (frontmatter), NOT `skill.body`
 *     (which is post-frontmatter — the block would be invisible there).
 *   - A skill with NO `dependencies:` block ⇒ field absent (byte-identical).
 *   - Inventory propagation is GATED (`QUANTA_SKILL_MCP_DEPS`): off ⇒ field
 *     absent on the channel even when the skill declared a block.
 *   - The block survives the plugin-union projection (locality: deps ride with
 *     their skill).
 *   - The reconcile mapping is a pure no-op when no `skillMcpSession` is wired.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import {
  augmentActiveSkillsWithPlugin,
  reconcileSkillMcpDepsForTurn,
} from "@/agent/loop-activation-hook"
import { buildSkillBlock } from "@/agent/tier1/skill"
import { __resetRuntimeConfig } from "@/shared"
import { discoverSkills } from "@/skill"
import type { ActiveSkillDeps, SkillMcpSession } from "@/skill/skill-mcp-deps"

const WITH_DEPS = `---
name: with-deps
description: A skill that declares MCP deps
dependencies:
  tools:
    - type: mcp
      value: my-server
      transport: stdio
      command: my-mcp-binary
      args: ["--flag"]
    - type: mcp
      value: remote-svc
      transport: streamable_http
      url: https://mcp.example.com/v1
---
Body here — note the dependencies block lives in the FRONTMATTER, above this.
`

const NO_DEPS = `---
name: no-deps
description: A plain skill, no deps block
---
Just a body.
`

let root: string | null = null
const origGate = process.env.QUANTA_SKILL_MCP_DEPS

const seedSkills = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "skill-mcp-substrate-"))
  writeFileSync(join(dir, "with-deps.md"), WITH_DEPS)
  writeFileSync(join(dir, "no-deps.md"), NO_DEPS)
  return dir
}

beforeEach(() => {
  root = seedSkills()
  __resetRuntimeConfig()
})
afterEach(() => {
  if (root !== null) rmSync(root, { recursive: true, force: true })
  root = null
  if (origGate === undefined) delete process.env.QUANTA_SKILL_MCP_DEPS
  else process.env.QUANTA_SKILL_MCP_DEPS = origGate
  __resetRuntimeConfig()
})

// ---------------------------------------------------------------------------
// A. Discovery lift — from the FULL SKILL.md content (frontmatter).
// ---------------------------------------------------------------------------

describe("A. discovery lifts the raw dependencies block", () => {
  test("A1 — a skill with a deps block carries rawDependencies = { tools: [...] }", async () => {
    const skills = await discoverSkills(root ?? "")
    const withDeps = skills.find((s) => s.name === "with-deps")
    expect(withDeps).toBeDefined()
    const raw = withDeps?.rawDependencies as { tools: unknown[] } | undefined
    expect(raw).toBeDefined()
    expect(Array.isArray(raw?.tools)).toBe(true)
    expect(raw?.tools.length).toBe(2)
    // first tool = the stdio dep
    const first = raw?.tools[0] as Record<string, unknown>
    expect(first.value).toBe("my-server")
    expect(first.transport).toBe("stdio")
    expect(first.command).toBe("my-mcp-binary")
  })

  test("A2 — a skill with NO deps block has no rawDependencies field (byte-identical)", async () => {
    const skills = await discoverSkills(root ?? "")
    const noDeps = skills.find((s) => s.name === "no-deps")
    expect(noDeps).toBeDefined()
    expect(noDeps && "rawDependencies" in noDeps).toBe(false)
  })

  test("A3 — the block is lifted from frontmatter, not the (post-frontmatter) body", async () => {
    const skills = await discoverSkills(root ?? "")
    const withDeps = skills.find((s) => s.name === "with-deps")
    // body must NOT contain the dependencies block (it's frontmatter-only) yet
    // rawDependencies is still populated ⇒ proves we lifted from full content.
    expect(withDeps?.body.includes("dependencies:")).toBe(false)
    expect(withDeps?.rawDependencies).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// B. Inventory propagation — GATED.
// ---------------------------------------------------------------------------

const cfgWithSkills = (dir: string): AgentConfig =>
  ({ skills: { dir }, cwd: "/repo" }) as unknown as AgentConfig

describe("B. buildSkillBlock propagates rawDependencies ONLY when gated on", () => {
  test("B1 — gate ON ⇒ inventory entry carries the deps block", async () => {
    process.env.QUANTA_SKILL_MCP_DEPS = "1"
    __resetRuntimeConfig()
    const block = await buildSkillBlock(cfgWithSkills(root ?? ""))
    const entry = block?.inventory.find((s) => s.name === "with-deps")
    expect(entry).toBeDefined()
    expect((entry as { rawDependencies?: unknown }).rawDependencies).toBeDefined()
  })

  test("B2 — gate OFF (default) ⇒ inventory entry has NO deps field (byte-identical)", async () => {
    delete process.env.QUANTA_SKILL_MCP_DEPS
    __resetRuntimeConfig()
    const block = await buildSkillBlock(cfgWithSkills(root ?? ""))
    const entry = block?.inventory.find((s) => s.name === "with-deps")
    expect(entry).toBeDefined()
    expect(entry && "rawDependencies" in entry).toBe(false)
  })

  test("B3 — gate ON + skill without a block ⇒ still no field (no phantom)", async () => {
    process.env.QUANTA_SKILL_MCP_DEPS = "1"
    __resetRuntimeConfig()
    const block = await buildSkillBlock(cfgWithSkills(root ?? ""))
    const entry = block?.inventory.find((s) => s.name === "no-deps")
    expect(entry).toBeDefined()
    expect(entry && "rawDependencies" in entry).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// C. Union projection preserves rawDependencies (locality: deps ride w/ skill).
// ---------------------------------------------------------------------------

describe("C. augmentActiveSkillsWithPlugin preserves rawDependencies", () => {
  const rawA = { tools: [{ type: "mcp", value: "svc-a", transport: "stdio", command: "a" }] }

  test("C1 — caller deps survive when plugin skills force the union+map path", () => {
    const caller = [{ name: "with-deps", description: "d", rawDependencies: rawA }]
    // A non-empty resolvedSkills forces the union+projection branch (the empty
    // branch returns the caller array by reference, trivially preserving).
    const out = augmentActiveSkillsWithPlugin(caller, {
      resolvedSkills: [{ name: "plug", description: "p" }],
    })
    const survived = out?.find((s) => s.name === "with-deps")
    expect((survived as { rawDependencies?: unknown }).rawDependencies).toEqual(rawA)
  })

  test("C2 — a skill with no deps stays field-less through the union", () => {
    const caller = [{ name: "plain", description: "d" }]
    const out = augmentActiveSkillsWithPlugin(caller, {
      resolvedSkills: [{ name: "plug", description: "p" }],
    })
    const plain = out?.find((s) => s.name === "plain")
    expect(plain && "rawDependencies" in plain).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// D. Reconcile mapping — descriptor → ActiveSkillDeps; no-op without a session.
// ---------------------------------------------------------------------------

describe("D. reconcileSkillMcpDepsForTurn maps + no-ops correctly", () => {
  const rawA = { tools: [{ type: "mcp", value: "svc-a", transport: "stdio", command: "a" }] }

  test("D1 — no skillMcpSession wired ⇒ pure no-op (never throws, never maps)", async () => {
    // No session on the config: the helper must return immediately. We pass a
    // hostile getter to PROVE the active-skills array is never even iterated.
    let touched = false
    const skills = new Proxy([{ name: "x", rawDependencies: rawA }], {
      get(t, p, r) {
        if (p === "length" || p === Symbol.iterator || typeof p === "symbol") {
          touched = true
        }
        return Reflect.get(t, p, r)
      },
    })
    await reconcileSkillMcpDepsForTurn({}, skills)
    expect(touched).toBe(false)
  })

  test("D2 — session wired ⇒ reconcile receives mapped ActiveSkillDeps (skillId+rawDeps)", async () => {
    let received: readonly ActiveSkillDeps[] | null = null
    const session: SkillMcpSession = {
      reconcile: async (deps) => {
        received = deps
        return { attached: [], detached: [] }
      },
      shutdownAll: async () => {},
      attachedIdentities: () => [],
    }
    await reconcileSkillMcpDepsForTurn({ skillMcpSession: session }, [
      { name: "with-deps", rawDependencies: rawA },
      { name: "plain" },
    ])
    expect(received).not.toBeNull()
    const got = received as unknown as ActiveSkillDeps[]
    expect(got.length).toBe(2)
    expect(got[0]).toEqual({ skillId: "with-deps", rawDependencies: rawA })
    // a deps-less skill maps to a bare skillId (no phantom rawDependencies key)
    expect(got[1]).toEqual({ skillId: "plain" })
  })
})
