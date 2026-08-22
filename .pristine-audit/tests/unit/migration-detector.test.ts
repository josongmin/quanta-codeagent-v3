/**
 * ADR-0038: detector marker-based positive + negative cases against a
 * virtual home directory tmpdir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detectExternalAgents, detectorContracts } from "@/migration"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "migration-detector-"))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const touch = async (rel: string): Promise<void> => {
  const abs = join(home, rel)
  await mkdir(join(abs, ".."), { recursive: true })
  await writeFile(abs, "{}", "utf8")
}

const mkdirp = async (rel: string): Promise<void> => {
  await mkdir(join(home, rel), { recursive: true })
}

describe("detectExternalAgents (ADR-0038)", () => {
  test("empty home ⇒ []", async () => {
    expect(await detectExternalAgents(home)).toEqual([])
  })

  test("only .claude/ dir, no markers ⇒ NOT detected", async () => {
    await mkdirp(".claude")
    expect(await detectExternalAgents(home)).toEqual([])
  })

  test("claude_code: auth.json + projects/ ⇒ detected", async () => {
    await touch(".claude/auth.json")
    await mkdirp(".claude/projects")
    const r = await detectExternalAgents(home)
    expect(r).toHaveLength(1)
    expect(r[0]?.provider).toBe("claude_code")
    expect(r[0]?.root).toBe(join(home, ".claude"))
  })

  test("claude_code: auth.json ONLY ⇒ NOT detected (projects missing)", async () => {
    await touch(".claude/auth.json")
    expect(await detectExternalAgents(home)).toEqual([])
  })

  test("claude_code: projects/ ONLY ⇒ NOT detected (auth.json missing)", async () => {
    await mkdirp(".claude/projects")
    expect(await detectExternalAgents(home)).toEqual([])
  })

  test("cursor: sessions.json present ⇒ detected", async () => {
    await touch(".cursor/sessions.json")
    const r = await detectExternalAgents(home)
    expect(r).toHaveLength(1)
    expect(r[0]?.provider).toBe("cursor")
  })

  test("aider: history.json present ⇒ detected", async () => {
    await touch(".aider/history.json")
    const r = await detectExternalAgents(home)
    expect(r).toHaveLength(1)
    expect(r[0]?.provider).toBe("aider")
  })

  test("multi-provider home ⇒ all detected, in contract order", async () => {
    await touch(".claude/auth.json")
    await mkdirp(".claude/projects")
    await touch(".cursor/sessions.json")
    await touch(".aider/history.json")
    const r = await detectExternalAgents(home)
    const names = r.map((d) => d.provider)
    expect(names).toEqual(["claude_code", "cursor", "aider"])
  })

  test("unknown agent-shaped dir ⇒ NOT detected (no silent 'unknown' surface)", async () => {
    await mkdirp(".gpt-engineer")
    await touch(".gpt-engineer/state.json")
    expect(await detectExternalAgents(home)).toEqual([])
  })

  test("detectorContracts() exposes 3 known providers", () => {
    const c = detectorContracts()
    expect(c.map((p) => p.provider).sort()).toEqual(["aider", "claude_code", "cursor"])
  })

  test("markers list returned with absolute paths", async () => {
    await touch(".cursor/sessions.json")
    const r = await detectExternalAgents(home)
    expect(r[0]?.markers).toEqual([join(home, ".cursor/sessions.json")])
  })

  test("non-existent homeDir ⇒ [] (graceful, no throw)", async () => {
    const ghost = join(home, "..", "definitely-does-not-exist-xyz")
    expect(await detectExternalAgents(ghost)).toEqual([])
  })
})
