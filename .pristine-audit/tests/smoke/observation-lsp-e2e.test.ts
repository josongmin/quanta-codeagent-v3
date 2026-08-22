/**
 * REAL-pyright e2e hellgate for LSP → observation injection (jul-6).
 *
 * WHY e2e (not a unit test): every lsp-enrich unit test uses a FAKE session, so
 * the two bugs that actually broke LSP injection in the bench — (1) opening a
 * REPO-RELATIVE path (pyright ENOENT ⇒ silent no-op) and (2) an unbounded open
 * that blocks on the 90s ready-timeout — passed every fake-based test. Only a
 * run against a REAL language server exercises the path/latency contract. This
 * test is RED without the abs-path + abort-bound fixes.
 *
 * SCENARIO:
 *   fixture   — a temp dir with ONE python file carrying a globally-unique symbol
 *   treatment — real `lspNavProvider()` → lspEnrichProvider → gather → render;
 *               the rendered `<quanta_observations>` MUST carry that symbol tagged
 *               `source: lsp-prefetch` (proves harvest → merge → render end-to-end).
 *   control   — same file, a null nav provider (no server): the symbol MUST be
 *               absent and `lsp-prefetch` MUST NOT be a contributor (non-vacuous:
 *               proves it is the LSP path, not the fixture, that injects the symbol).
 *   gate      — skipped when `pyright-langserver` is not on PATH (live-tier).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { execSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_SOURCE_AUTHORITY, gatherObservations } from "@/agent/observation/pipeline"
import { lspEnrichProvider } from "@/agent/observation/providers/lsp-enrich/provider"
import { renderObservations } from "@/agent/observation/render/render"
import type { LspNavProvider } from "@/tool"

const pyrightAvailable = (): boolean => {
  try {
    execSync("command -v pyright-langserver", { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const UNIQUE_SYMBOL = "zzz_unique_owner_marker_9f3c"
const REL_FILE = "models.py"
// Real pyright cold-start needs headroom well past the 5s pipeline default.
const GENEROUS_BUDGET = { maxMillis: 45_000, maxOwners: 10 }
const CTX = {
  cwd: "/unused",
  issueText: "the request handler is broken",
  repoFiles: [REL_FILE],
  capability: "source-repair" as const,
}

// A nav provider that never yields a session — the "no language server" control.
const nullNavProvider: LspNavProvider = {
  unavailableReason: () => "control: no server",
  open: async () => null,
}

describe.skipIf(!pyrightAvailable())("observation LSP injection — real pyright e2e", () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "obs-lsp-e2e-"))
    writeFileSync(
      join(dir, REL_FILE),
      `def ${UNIQUE_SYMBOL}(request):\n    """Handle the request."""\n    return request\n`,
    )
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("TREATMENT: real LSP harvests the unique symbol into the rendered <quanta_observations>", async () => {
    // Default provider = real lspNavProvider() (the production path).
    const provider = lspEnrichProvider([REL_FILE], dir)
    const bundle = await gatherObservations([provider], CTX, {
      authority: DEFAULT_SOURCE_AUTHORITY,
      budget: GENEROUS_BUDGET,
    })
    const rendered = renderObservations(bundle)

    // Harvest → merge → render, end-to-end. RED without the abs-path fix
    // (pyright ENOENTs the relative path) or the abort-bound fix (times out).
    expect(bundle.contributors).toContain("lsp-prefetch")
    expect(bundle.owners.some((o) => o.symbol === UNIQUE_SYMBOL)).toBe(true)
    expect(rendered).toContain(UNIQUE_SYMBOL)
    expect(rendered).toContain("<quanta_observations>")
  }, 60_000)

  it("G1 PRODUCTION BUDGET: a warm server harvests within the 5s pipeline default (not just 45s)", async () => {
    // Bench PREWARMS pyright before localize runs, so the production condition is a
    // WARM server + the default pipeline budget (5s) — NOT a cold start. Warm it once…
    await lspEnrichProvider([REL_FILE], dir).produce(CTX, { maxMillis: 45_000, maxOwners: 10 })
    // …then run the exact production path: gatherObservations with NO explicit budget ⇒
    // DEFAULT_BUDGET (5s). RED if a warm server can't harvest in the shipped budget ⇒
    // default-ON lsp-prefetch would silently no-op per instance in real bench.
    const bundle = await gatherObservations([lspEnrichProvider([REL_FILE], dir)], CTX, {
      authority: DEFAULT_SOURCE_AUTHORITY,
    })
    expect(bundle.contributors).toContain("lsp-prefetch")
    expect(bundle.owners.some((o) => o.symbol === UNIQUE_SYMBOL)).toBe(true)
  }, 60_000)

  it("G4 CONCURRENCY: N concurrent enrich calls on distinct cwds all complete (no deadlock/crash)", async () => {
    // default-ON lsp-prefetch fires per instance; a concurrent bench opens many cwds at
    // once. lsp-prefetch shares the per-cwd warm-pool with the agent's own lsp_nav (no
    // NEW servers), and the RSS watchdog caps memory — but the observable safety property
    // is: concurrent enrich never deadlocks and always returns a bundle (harvest or null).
    const dirs = Array.from({ length: 4 }, (_, i) => {
      const d = mkdtempSync(join(tmpdir(), `obs-lsp-conc-${i}-`))
      writeFileSync(join(d, REL_FILE), `def concurrent_marker_${i}(x):\n    return x\n`)
      return d
    })
    try {
      const bundles = await Promise.all(
        dirs.map((d) =>
          gatherObservations(
            [lspEnrichProvider([REL_FILE], d)],
            { ...CTX, cwd: d },
            {
              authority: DEFAULT_SOURCE_AUTHORITY,
              budget: GENEROUS_BUDGET,
            },
          ),
        ),
      )
      expect(bundles).toHaveLength(4)
      // every concurrent call resolved to a well-formed bundle — no hang, no throw.
      for (const b of bundles) expect(Array.isArray(b.owners)).toBe(true)
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true })
    }
  }, 90_000)

  it("CONTROL: no language server ⇒ symbol absent, lsp-prefetch not a contributor", async () => {
    const provider = lspEnrichProvider([REL_FILE], dir, nullNavProvider)
    const bundle = await gatherObservations([provider], CTX, {
      authority: DEFAULT_SOURCE_AUTHORITY,
      budget: GENEROUS_BUDGET,
    })
    const rendered = renderObservations(bundle)

    // Non-vacuous: it is the LSP path (not the fixture / render) that injects the symbol.
    expect(bundle.contributors).not.toContain("lsp-prefetch")
    expect(rendered).not.toContain(UNIQUE_SYMBOL)
  })
})
