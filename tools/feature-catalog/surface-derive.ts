/**
 * tools/feature-catalog/surface-derive.ts — MECHANICAL surface_integration deriver.
 *
 * Fills `surface_integration` for every feature WITHOUT an LLM, from a single
 * deterministic fact: per-surface file-level import reachability. Reuses the
 * import graph from `./reachability` (`computeReachability().adj`) and runs a
 * fresh BFS from EACH surface's own entrypoint:
 *
 *   cli  reachability ← src/apps/cli/index.ts        (the native agent surface)
 *   web  reachability ← src/apps/web-daemon/index.ts (the web backend runtime)
 *
 * Derivation (no heuristics — every status traces to a reachability fact):
 *   evidence.code has no src/*.ts        → cli=na,  web=na   (pure tooling/docs)
 *   ≥1 src file reachable from cli entry → cli=full          (CLI renders it)
 *   else (src exists, cli-unreachable)   → cli=missing
 *   ≥1 src file reachable from web entry → web=partial        ┐ backend RUNS it;
 *                                                              │ browser affordance
 *                                                              │ is gated by the
 *                                                              │ 7-tag session-host-turn-event bridge /
 *                                                              │ SlashPalette /
 *                                                              │ SessionCommand and
 *                                                              │ is NOT mechanically
 *                                                              ┘ confirmed → AUDIT.
 *   else (src exists, web-unreachable)   → web=missing        (code can't run in web)
 *
 * `web=partial` here is a deliberate UPPER BOUND, not a confirmed affordance —
 * the evidence string says so. The LLM audit (method:audited) downgrades the
 * event-bridge-dropped ones to web=missing with precise file:line. method is
 * stamped "derived"; files that already carry a surface_integration block (the
 * audited seeds) are left untouched.
 *
 * Run: `bun fc surface-derive`        (dry-run summary)
 *      `bun fc surface-derive --write` (apply to yaml files)
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { computeReachability } from "./reachability"
import { loadFeatures } from "./schema"

const REPO_ROOT = resolve(import.meta.dir, "..", "..")

import { FEATURES_DIR } from "./paths"

const CLI_ENTRY = "src/apps/cli/index.ts"
const WEB_ENTRY = "src/apps/web-daemon/index.ts"
const VERIFIED = "2026-06-09"

const bfs = (
  adj: ReadonlyMap<string, ReadonlyArray<string>>,
  entry: string,
): ReadonlySet<string> => {
  const reached = new Set<string>()
  if (!adj.has(entry)) return reached
  reached.add(entry)
  const q: string[] = [entry]
  while (q.length > 0) {
    const cur = q.shift() as string
    for (const next of adj.get(cur) ?? []) {
      if (!reached.has(next)) {
        reached.add(next)
        q.push(next)
      }
    }
  }
  return reached
}

type Status = "full" | "partial" | "missing" | "na"

export interface DerivedRow {
  readonly id: string
  readonly path: string
  readonly cli: Status
  readonly web: Status
  readonly cliEvidence: string
  readonly webEvidence: string
  readonly skipped: boolean // already has a surface_integration block
}

// double-quote-safe one-line evidence (the mini-YAML parser breaks on internal
// double quotes); collapse whitespace + strip embedded quotes.
const ev1 = (s: string): string => s.replace(/"/g, "'").replace(/\s+/g, " ").trim()

const yamlBlock = (
  cli: Status,
  web: Status,
  cliEv: string,
  webEv: string,
  method: "derived" | "audited" = "derived",
): string => {
  const lines = [
    "surface_integration:",
    `  cli: ${cli}`,
    `  web: ${web}`,
    `  method: ${method}`,
    `  verified: "${VERIFIED}"`,
  ]
  const evLines: string[] = []
  if (cliEv.length > 0) evLines.push(`    cli: "${ev1(cliEv)}"`)
  if (webEv.length > 0) evLines.push(`    web: "${ev1(webEv)}"`)
  if (evLines.length > 0) lines.push("  evidence:", ...evLines)
  return `${lines.join("\n")}\n`
}

// Replace an existing surface_integration block (key line + all following
// indented lines), or insert before `purpose:` if none exists. Pure.
export const upsertSurfaceBlock = (text: string, block: string): string => {
  const existing = /^surface_integration:\n(?:[ \t].*\n|\n)*/m
  if (existing.test(text)) return text.replace(existing, block)
  const anchor = text.search(/(^|\n)purpose:/)
  if (anchor === -1) return text
  const at = text[anchor] === "\n" ? anchor + 1 : anchor
  return `${text.slice(0, at)}${block}${text.slice(at)}`
}

export interface AuditedVerdict {
  readonly path: string // repo-relative yaml path
  readonly cli: Status
  readonly web: Status
  readonly cliEvidence?: string
  readonly webEvidence?: string
}

const VALID = new Set<Status>(["full", "partial", "missing", "na"])

// Apply LLM-audited verdicts deterministically: rewrite each file's block to
// method:audited. Returns {applied, skipped} ids. Single trusted write path —
// the audit agents never touch files, they only return verdicts.
export const applyAuditedVerdicts = async (
  verdicts: readonly AuditedVerdict[],
): Promise<{ applied: number; skipped: string[] }> => {
  let applied = 0
  const skipped: string[] = []
  for (const v of verdicts) {
    if (!VALID.has(v.cli) || !VALID.has(v.web)) {
      skipped.push(`${v.path} (bad status ${v.cli}/${v.web})`)
      continue
    }
    const abs = resolve(REPO_ROOT, v.path)
    let text: string
    try {
      text = await readFile(abs, "utf8")
    } catch {
      skipped.push(`${v.path} (unreadable)`)
      continue
    }
    const block = yamlBlock(v.cli, v.web, v.cliEvidence ?? "", v.webEvidence ?? "", "audited")
    const next = upsertSurfaceBlock(text, block)
    if (next === text) {
      skipped.push(`${v.path} (no change / no anchor)`)
      continue
    }
    await writeFile(abs, next, "utf8")
    applied++
  }
  return { applied, skipped }
}

const gatherYaml = async (dir: string): Promise<string[]> => {
  const out: string[] = []
  for (const name of await readdir(dir)) {
    const full = join(dir, name)
    const st = await stat(full)
    if (st.isDirectory()) out.push(...(await gatherYaml(full)))
    else if (name.endsWith(".yaml")) out.push(full)
  }
  return out
}

export const deriveSurfaceIntegration = async (
  opts: { write?: boolean } = {},
): Promise<DerivedRow[]> => {
  const { adj } = await computeReachability()
  const cliReached = bfs(adj, CLI_ENTRY)
  const webReached = bfs(adj, WEB_ENTRY)

  // path → parsed feature (evidence.code, id)
  const loaded = await loadFeatures(FEATURES_DIR)
  const byPath = new Map(loaded.map((l) => [resolve(REPO_ROOT, l.path), l.feature]))

  // FEATURES_DIR is absolute (see ./paths). Joining it onto REPO_ROOT again
  // produced `<repo>/Users/...` and an ENOENT — the anchored value must be used
  // as-is, not treated as repo-relative the way the old literal was.
  const files = await gatherYaml(FEATURES_DIR)
  const rows: DerivedRow[] = []

  for (const file of files) {
    const feature = byPath.get(file)
    if (!feature) continue
    const text = await readFile(file, "utf8")
    const rel = relative(REPO_ROOT, file)
    // skip if a block already exists (audited seeds / prior derive)
    if (/(^|\n)surface_integration:/.test(text)) {
      rows.push({
        id: feature.id,
        path: rel,
        cli: feature.surface_integration.cli as Status,
        web: feature.surface_integration.web as Status,
        cliEvidence: "",
        webEvidence: "",
        skipped: true,
      })
      continue
    }

    const code = feature.evidence.code
    const src = code.filter((c) => c.startsWith("src/") && c.endsWith(".ts"))
    // web SURFACE code lives OUTSIDE src/ (the React app + the daemon shell);
    // a feature citing it is literally web code regardless of src reachability.
    const webCode = code.some(
      (c) =>
        c.includes("apps/web-frontend/") ||
        c.startsWith("src/apps/web-daemon/") ||
        c.includes("apps/tauri-shell/"),
    )
    let cli: Status
    let web: Status
    let cliEv = ""
    let webEv = ""

    // --- cli axis: reachable from the interactive CLI entrypoint ---
    if (src.length === 0) {
      cli = "na"
    } else {
      const cliHits = src.filter((c) => cliReached.has(c))
      cli = cliHits.length > 0 ? "full" : "missing"
      cliEv =
        cliHits.length > 0
          ? `derived: ${cliHits.length}/${src.length} evidence file(s) reachable from CLI entry (${CLI_ENTRY} import graph)`
          : `derived: 0/${src.length} evidence file(s) reachable from CLI entry (${CLI_ENTRY}) — not wired into the interactive CLI`
    }

    // --- web axis: web-surface code, else web-daemon backend reachability ---
    if (webCode) {
      web = "full"
      webEv =
        "derived: evidence.code cites web frontend / web-daemon / tauri-shell source — this IS web surface code"
    } else if (src.length === 0) {
      web = "na"
    } else {
      const webHits = src.filter((c) => webReached.has(c))
      web = webHits.length > 0 ? "partial" : "missing"
      webEv =
        webHits.length > 0
          ? `derived: reachable from web-daemon entry (${WEB_ENTRY}) — backend runs it; browser affordance is gated by the 6-event bridge / SlashPalette / SessionCommand and is NOT mechanically confirmed (needs audit)`
          : `derived: not reachable from web-daemon entry (${WEB_ENTRY}) — code does not run in the web backend`
    }

    if (opts.write) {
      // insert the block immediately before the (required, top-level) purpose: key
      const anchor = text.search(/(^|\n)purpose:/)
      if (anchor === -1) continue
      const at = text[anchor] === "\n" ? anchor + 1 : anchor
      const next = `${text.slice(0, at)}${yamlBlock(cli, web, cliEv, webEv)}${text.slice(at)}`
      await writeFile(file, next, "utf8")
    }

    rows.push({
      id: feature.id,
      path: rel,
      cli,
      web,
      cliEvidence: cliEv,
      webEvidence: webEv,
      skipped: false,
    })
  }
  return rows
}
