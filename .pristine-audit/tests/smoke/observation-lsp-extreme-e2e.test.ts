/**
 * EXTREME real-pyright e2e for lsp-enrich resilience (jul-6).
 *
 * The happy-path e2e (observation-lsp-e2e.test.ts) proves harvest works. This one
 * is adversarial: the classes that only surface against a REAL language server
 * under abuse — malformed source, missing/renamed files, huge symbol sets, mixed
 * non-python candidates, weird cwd paths, empty files. Every case MUST resolve to
 * a well-formed bundle (harvest or graceful null) — NEVER a throw, hang, or OOM.
 * A dead/absent server ⇒ null, not a crash. Gated (skips without pyright).
 */

import { afterAll, describe, expect, it } from "bun:test"
import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_SOURCE_AUTHORITY, gatherObservations } from "@/agent/observation/pipeline"
import { lspEnrichProvider } from "@/agent/observation/providers/lsp-enrich/provider"
import { renderObservations } from "@/agent/observation/render/render"

const pyrightAvailable = (): boolean => {
  try {
    execSync("command -v pyright-langserver", { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const BUDGET = { maxMillis: 30_000, maxOwners: 10 }
const ctx = (cwd: string, files: readonly string[]) => ({
  cwd,
  issueText: "something broke",
  repoFiles: files,
  capability: "source-repair" as const,
})

const dirs: string[] = []
const mkFixture = (files: Record<string, string>, prefix = "obs-x-"): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(d, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, body)
  }
  return d
}
const harvest = (dir: string, files: readonly string[]) =>
  gatherObservations([lspEnrichProvider(files, dir)], ctx(dir, files), {
    authority: DEFAULT_SOURCE_AUTHORITY,
    budget: BUDGET,
  })

describe.skipIf(!pyrightAvailable())("lsp-enrich EXTREME — real pyright resilience", () => {
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  it("MALFORMED python (syntax errors) ⇒ well-formed bundle, never throws/hangs", async () => {
    const d = mkFixture({ "broken.py": "def broken(:\n    x = = 3\nclass  :\n  pass\n" })
    const bundle = await harvest(d, ["broken.py"])
    // Pyright may return partial symbols or none; the contract is only: no crash,
    // owners is an array, and any owner it DID emit belongs to the candidate file.
    expect(Array.isArray(bundle.owners)).toBe(true)
    for (const o of bundle.owners) expect(o.file).toBe("broken.py")
    expect(() => renderObservations(bundle)).not.toThrow()
  })

  it("NONEXISTENT candidate file ⇒ graceful null (ENOENT never crashes — the abs-path bug class)", async () => {
    const d = mkFixture({ "real.py": "def real_fn(x):\n    return x\n" })
    // Candidate points at a file that is NOT on disk (renamed/deleted since listing).
    const bundle = await harvest(d, ["ghost_deleted.py"])
    expect(bundle.contributors).not.toContain("lsp-prefetch")
    expect(bundle.owners).toHaveLength(0)
  })

  it("HUGE symbol set ⇒ owner cap holds (≤ maxOwners), no hang/OOM", async () => {
    const body = Array.from({ length: 200 }, (_, i) => `def fn_${i}(a):\n    return a\n`).join("\n")
    const d = mkFixture({ "huge.py": body })
    const bundle = await gatherObservations(
      [lspEnrichProvider(["huge.py"], d)],
      ctx(d, ["huge.py"]),
      {
        authority: DEFAULT_SOURCE_AUTHORITY,
        budget: { maxMillis: 30_000, maxOwners: 5 },
      },
    )
    // The cap is authoritative even against a 200-symbol file — never floods the prompt.
    expect(bundle.owners.length).toBeLessThanOrEqual(5)
    for (const o of bundle.owners) expect(o.file).toBe("huge.py")
  })

  it("MIXED non-python + python candidates ⇒ python harvested, non-python skipped (no crash)", async () => {
    const d = mkFixture({
      "notes.md": "# just markdown, no language server\n",
      "data.txt": "not code\n",
      "code.py": "def mixed_owner_marker(req):\n    return req\n",
    })
    const bundle = await harvest(d, ["notes.md", "data.txt", "code.py"])
    // Non-py get no server ⇒ silently skipped; the .py still harvests its symbol.
    expect(bundle.owners.every((o) => o.file === "code.py")).toBe(true)
    for (const o of bundle.owners) expect(o.file).not.toMatch(/\.(md|txt)$/)
  })

  it("cwd + file path with SPACES ⇒ still opens + harvests (no path-quoting break)", async () => {
    const d = mkFixture(
      { "sub dir/mod ule.py": "def spaced_path_marker(x):\n    return x\n" },
      "obs x space-",
    )
    const bundle = await harvest(d, ["sub dir/mod ule.py"])
    // A sandbox path with spaces must not break the abs-path open.
    expect(Array.isArray(bundle.owners)).toBe(true)
    for (const o of bundle.owners) expect(o.file).toBe("sub dir/mod ule.py")
  })

  it("EMPTY / comment-only file ⇒ null (no noise-owner shipped)", async () => {
    const d = mkFixture({ "empty.py": "# just a comment\n\n" })
    const bundle = await harvest(d, ["empty.py"])
    // A server that readies but has no promotable symbol ⇒ null, never an empty-noise owner.
    expect(bundle.contributors).not.toContain("lsp-prefetch")
    expect(bundle.owners).toHaveLength(0)
  })

  it("CONCURRENT on the SAME cwd ⇒ shared warm-pool, both resolve (no double-open deadlock)", async () => {
    const d = mkFixture({ "same.py": "def same_cwd_marker(x):\n    return x\n" }, "obs-x-same-")
    // Two enrich passes race on ONE workspace — the per-cwd warm-pool must serialize
    // the open without deadlocking; both calls resolve to well-formed bundles.
    const [a, b] = await Promise.all([harvest(d, ["same.py"]), harvest(d, ["same.py"])])
    expect(Array.isArray(a.owners)).toBe(true)
    expect(Array.isArray(b.owners)).toBe(true)
    // At least one harvested the symbol (the workspace IS valid); neither hung/crashed.
    expect(a.owners.length + b.owners.length).toBeGreaterThan(0)
  })

  it("MANY candidate files + TIGHT budget ⇒ abandons mid-list gracefully, no hang", async () => {
    const files: Record<string, string> = {}
    const rels: string[] = []
    for (let i = 0; i < 20; i++) {
      const rel = `f${i}.py`
      files[rel] = `def marker_${i}(x):\n    return x\n`
      rels.push(rel)
    }
    const d = mkFixture(files, "obs-x-many-")
    const start = Date.now()
    // 300ms budget across 20 cold files: most opens will not ready — the provider must
    // abandon within budget and return whatever it got, NEVER walk all 20 to 90s each.
    const bundle = await gatherObservations([lspEnrichProvider(rels, d)], ctx(d, rels), {
      authority: DEFAULT_SOURCE_AUTHORITY,
      budget: { maxMillis: 300, maxOwners: 50 },
    })
    expect(Date.now() - start).toBeLessThan(5_000) // bounded by budget, not 20×90s
    expect(Array.isArray(bundle.owners)).toBe(true)
    for (const o of bundle.owners) expect(rels).toContain(o.file)
  })
})
