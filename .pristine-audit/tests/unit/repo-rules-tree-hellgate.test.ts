/**
 * ADR-0098 hellgate — repo-rules tree scoping + deeper-wins
 *
 * Codex AGENTS.md scoping rule absorption: monorepo packages must be able to
 * have their own AGENTS.md and have those rules ride into the prompt ALONGSIDE
 * (and AFTER) any root-level rules, so the LLM treats package-local rules as
 * winning a same-axis conflict (deeper-wins via positional ordering).
 *
 * 15 adversarial cases. Each one names the failure mode it's defending against.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadRepoRules } from "@/agent"

describe("ADR-0098 loadRepoRules tree scoping (hellgate)", () => {
  let base: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "qct-repo-rules-tree-"))
    // Mark base as a git repo so the walk halts here — without this the walk
    // would keep going up to filesystem root, which makes every test's
    // outcome depend on whatever AGENTS.md may exist on the test host.
    await mkdir(join(base, ".git"))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  // ── Tree walk ──────────────────────────────────────────────────────────

  test("HELL-1: 3-layer monorepo (root + packages + packages/foo) all loaded", async () => {
    await writeFile(join(base, "AGENTS.md"), "root rule", "utf8")
    await mkdir(join(base, "packages"))
    await writeFile(join(base, "packages/AGENTS.md"), "packages rule", "utf8")
    await mkdir(join(base, "packages/foo"))
    await writeFile(join(base, "packages/foo/AGENTS.md"), "foo rule", "utf8")

    const out = await loadRepoRules(join(base, "packages/foo"))
    expect(out).toBeDefined()
    expect(out?.layers).toHaveLength(3)
    // Root → deeper order in rendered body (deeper-wins via LLM positional bias).
    const rootIdx = out!.body.indexOf("root rule")
    const pkgsIdx = out!.body.indexOf("packages rule")
    const fooIdx = out!.body.indexOf("foo rule")
    expect(rootIdx).toBeGreaterThan(-1)
    expect(pkgsIdx).toBeGreaterThan(rootIdx)
    expect(fooIdx).toBeGreaterThan(pkgsIdx)
  })

  test("HELL-2: mixed entrypoints across layers (root AGENTS.md + sub CLAUDE.md)", async () => {
    await writeFile(join(base, "AGENTS.md"), "root via AGENTS", "utf8")
    await mkdir(join(base, "sub"))
    await writeFile(join(base, "sub/CLAUDE.md"), "sub via CLAUDE", "utf8")

    const out = await loadRepoRules(join(base, "sub"))
    expect(out?.layers).toHaveLength(2)
    expect(out?.body).toContain("root via AGENTS")
    expect(out?.body).toContain("sub via CLAUDE")
    const entrypoints = out?.layers?.map((l) => l.entrypoint) ?? []
    expect(entrypoints).toEqual(["AGENTS.md", "CLAUDE.md"])
  })

  // ── Stop conditions ────────────────────────────────────────────────────

  test("HELL-3: .git boundary processed then halts (no leak above repo root)", async () => {
    await writeFile(join(base, "AGENTS.md"), "repo root rule", "utf8")
    await mkdir(join(base, "a/b/c"), { recursive: true })

    const out = await loadRepoRules(join(base, "a/b/c"))
    expect(out).toBeDefined()
    expect(out?.layers).toHaveLength(1)
    expect(out?.layers?.[0]?.sourcePath).toBe(join(base, "AGENTS.md"))
  })

  test("HELL-4: no layers found anywhere → undefined (byte-identical default)", async () => {
    await mkdir(join(base, "a/b"), { recursive: true })
    const out = await loadRepoRules(join(base, "a/b"))
    expect(out).toBeUndefined()
  })

  // ── Per-layer security/skip ────────────────────────────────────────────

  test("HELL-5: symlinked layer is skipped, other layers survive (security)", async () => {
    const target = join(base, "secret.txt")
    await writeFile(target, "SECRET CONTENT", "utf8")
    await writeFile(join(base, "AGENTS.md"), "root real", "utf8")
    await mkdir(join(base, "sub"))
    await symlink(target, join(base, "sub/AGENTS.md"))

    const out = await loadRepoRules(join(base, "sub"))
    expect(out?.layers).toHaveLength(1)
    expect(out?.body).toContain("root real")
    expect(out?.body).not.toContain("SECRET")
  })

  test("HELL-6: empty-body layer skipped; next-candidate in same dir picked", async () => {
    await mkdir(join(base, "sub"))
    await writeFile(join(base, "sub/AGENTS.md"), "   \n  \n", "utf8")
    await writeFile(join(base, "sub/CLAUDE.md"), "sub real", "utf8")

    const out = await loadRepoRules(join(base, "sub"))
    expect(out?.layers).toHaveLength(1)
    expect(out?.layers?.[0]?.entrypoint).toBe("CLAUDE.md")
    expect(out?.body).toContain("sub real")
  })

  // ── Backward compatibility ─────────────────────────────────────────────

  test("HELL-7: single-layer body is RAW (no subheader) — byte-identical pre-tree", async () => {
    await writeFile(join(base, "AGENTS.md"), "single layer body", "utf8")
    const out = await loadRepoRules(base)
    expect(out?.layers).toHaveLength(1)
    // Body MUST NOT include `### From ./AGENTS.md` wrap when only one layer
    // exists; prior consumers (prompt.ts) expect the raw body content.
    expect(out?.body).toBe("single layer body")
  })

  test("HELL-8: same-dir priority AGENTS.md > CLAUDE.md > .codex/CODEX-RULES.md preserved", async () => {
    await writeFile(join(base, "AGENTS.md"), "primary", "utf8")
    await writeFile(join(base, "CLAUDE.md"), "secondary", "utf8")
    await mkdir(join(base, ".codex"))
    await writeFile(join(base, ".codex/CODEX-RULES.md"), "tertiary", "utf8")

    const out = await loadRepoRules(base)
    expect(out?.layers).toHaveLength(1)
    expect(out?.layers?.[0]?.entrypoint).toBe("AGENTS.md")
    expect(out?.body).toBe("primary")
  })

  // ── Layers[] shape ─────────────────────────────────────────────────────

  test("HELL-9: layers[] ordered root→cwd (highest depth first, depth-0 last)", async () => {
    await writeFile(join(base, "AGENTS.md"), "depth-2", "utf8")
    await mkdir(join(base, "a"))
    await writeFile(join(base, "a/AGENTS.md"), "depth-1", "utf8")
    await mkdir(join(base, "a/b"))
    await writeFile(join(base, "a/b/AGENTS.md"), "depth-0", "utf8")

    const out = await loadRepoRules(join(base, "a/b"))
    expect(out?.layers).toHaveLength(3)
    expect(out?.layers?.[0]?.body).toBe("depth-2") // root first
    expect(out?.layers?.[2]?.body).toBe("depth-0") // cwd last
    expect(out?.layers?.[0]?.depth).toBe(2)
    expect(out?.layers?.[1]?.depth).toBe(1)
    expect(out?.layers?.[2]?.depth).toBe(0)
  })

  test("HELL-10: relativePath labels use './' (cwd) and '../' (ancestors)", async () => {
    await writeFile(join(base, "AGENTS.md"), "root", "utf8")
    await mkdir(join(base, "a/b"), { recursive: true })
    await writeFile(join(base, "a/b/AGENTS.md"), "cwd", "utf8")

    const out = await loadRepoRules(join(base, "a/b"))
    expect(out?.layers).toHaveLength(2)
    const cwdLayer = out!.layers!.find((l) => l.depth === 0)
    expect(cwdLayer?.relativePath).toBe("./AGENTS.md")
    const rootLayer = out!.layers!.find((l) => l.depth === 2)
    expect(rootLayer?.relativePath).toBe("../../AGENTS.md")
  })

  // ── Top-level RepoRules summary fields ─────────────────────────────────

  test("HELL-11: top-level sourcePath/entrypoint reflect the deepest layer", async () => {
    await writeFile(join(base, "AGENTS.md"), "root", "utf8")
    await mkdir(join(base, "sub"))
    await writeFile(join(base, "sub/CLAUDE.md"), "sub", "utf8")

    const out = await loadRepoRules(join(base, "sub"))
    expect(out?.entrypoint).toBe("CLAUDE.md")
    expect(out?.sourcePath).toBe(join(base, "sub/CLAUDE.md"))
  })

  // ── Multi-layer rendering format ──────────────────────────────────────

  test("HELL-12: multi-layer body uses '### From <relativePath>' subheaders", async () => {
    await writeFile(join(base, "AGENTS.md"), "ROOT_BODY", "utf8")
    await mkdir(join(base, "sub"))
    await writeFile(join(base, "sub/AGENTS.md"), "SUB_BODY", "utf8")

    const out = await loadRepoRules(join(base, "sub"))
    expect(out?.layers).toHaveLength(2)
    expect(out?.body).toContain("### From ../AGENTS.md")
    expect(out?.body).toContain("ROOT_BODY")
    expect(out?.body).toContain("### From ./AGENTS.md")
    expect(out?.body).toContain("SUB_BODY")
    // Sub appears AFTER root in the rendered body.
    expect(out!.body.indexOf("ROOT_BODY")).toBeLessThan(out!.body.indexOf("SUB_BODY"))
  })

  // ── MAX_BYTES per-layer truncation ────────────────────────────────────

  test("HELL-13: 100 KiB layer truncated independently; other layers untouched", async () => {
    await writeFile(join(base, "AGENTS.md"), "a".repeat(100 * 1024), "utf8")
    await mkdir(join(base, "sub"))
    await writeFile(join(base, "sub/AGENTS.md"), "tiny", "utf8")

    const out = await loadRepoRules(join(base, "sub"))
    expect(out?.layers).toHaveLength(2)
    const rootLayer = out!.layers![0]!
    expect(rootLayer.body).toContain("[truncated:")
    expect(rootLayer.body).toContain(`${100 * 1024} bytes total`)
    const subLayer = out!.layers![1]!
    expect(subLayer.body).toBe("tiny")
  })

  // ── Depth cap (no infinite loop) ──────────────────────────────────────

  test("HELL-14: walk terminates without infinite loop on deep path without rules", async () => {
    const deep = join(base, "a/b/c/d/e/f")
    await mkdir(deep, { recursive: true })
    const out = await loadRepoRules(deep)
    expect(out).toBeUndefined()
  })

  // ── Concurrent walks ──────────────────────────────────────────────────

  test("HELL-15: concurrent loadRepoRules calls return independent results", async () => {
    await writeFile(join(base, "AGENTS.md"), "root", "utf8")
    await mkdir(join(base, "a"))
    await writeFile(join(base, "a/AGENTS.md"), "a-body", "utf8")
    await mkdir(join(base, "b"))
    await writeFile(join(base, "b/AGENTS.md"), "b-body", "utf8")

    const [outA, outB, outBase] = await Promise.all([
      loadRepoRules(join(base, "a")),
      loadRepoRules(join(base, "b")),
      loadRepoRules(base),
    ])

    expect(outA?.layers).toHaveLength(2)
    expect(outA?.body).toContain("root")
    expect(outA?.body).toContain("a-body")

    expect(outB?.layers).toHaveLength(2)
    expect(outB?.body).toContain("root")
    expect(outB?.body).toContain("b-body")
    expect(outB?.body).not.toContain("a-body")

    expect(outBase?.layers).toHaveLength(1)
    expect(outBase?.body).toBe("root")
  })
})
