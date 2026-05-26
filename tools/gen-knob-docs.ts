#!/usr/bin/env bun
/**
 * `bun run tools/gen-knob-docs.ts` — auto-generate knob documentation.
 *
 * Outputs three artifacts (all idempotent on a no-change run):
 *   1. `docs/knobs.md`                — markdown registry view (index + detail)
 *   2. `tools/feature-catalog/features/02-tool-system/bench-knobs.yaml`
 *                                     — feature catalog entry for the bench
 *                                       knob bundle (rolls up the 12 ids)
 *   3. `README.md` marker-block       — between `<!-- knobs:start -->` and
 *                                       `<!-- knobs:end -->` (NO-OP when the
 *                                       marker is absent)
 *
 * Pure-ish design:
 *   - `buildKnobsMarkdown`, `buildFeatureYaml`, `replaceReadmeBlock` are PURE
 *     (deterministic given the knob list + an injected ISO timestamp).
 *   - `main` reads/writes via Bun fs ports — all side effects live in one
 *     place so tests exercise the pure builders directly.
 *
 * The knob list comes from the framework registry. The script side-effect-
 * imports every per-knob module BEFORE reading `allKnobs()` so the bundle is
 * complete regardless of caller order. Adding a new knob to
 * `src/runner/knobs/knobs/` therefore requires adding its import below — same
 * contract as `src/apps/cli/knobs-bootstrap.ts`.
 */
import { type AnyKnob, allKnobs } from "@/runner/knobs"
import { bootstrapBenchKnobs } from "./swebench-matrix"

/** Snapshot the registry view we operate on. Sorted by id for stable output.
 *  Folds the idempotent `bootstrapBenchKnobs` seam so the docs generator
 *  works after a hellgate-style registry reset (the bootstrap re-registers
 *  any missing knobs from cached module exports — see swebench-matrix.ts).
 *  Awaits the dynamic import bootstrap so callers get a populated registry.
 *
 *  Optional `registry` test seam: tests pass a hand-built map so they don't
 *  have to touch the global knob registry (fragile under hellgate reset).
 *  Production callers omit it. */
export const collectKnobsForDocs = async (
  registry?: ReadonlyMap<string, AnyKnob>,
): Promise<readonly AnyKnob[]> => {
  if (registry === undefined) await bootstrapBenchKnobs()
  const source = registry ?? allKnobs()
  const out = [...source.values()]
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

/** Render the cost cell. `costMultiplier` may be absent (treat as 1×). */
const costCell = (k: AnyKnob): string => {
  const m = k.costMultiplier
  if (typeof m === "number" && m > 0) return `${m}×`
  return "1×"
}

/** Render the surfaces cell. We render in declaration order (no sort) so
 *  the doc matches the type-level enum order. */
const surfacesCell = (k: AnyKnob): string => k.surfaces.join(", ")

/** Render the source cell. Absent ⇒ "—". */
const sourceCell = (k: AnyKnob): string =>
  k.source !== undefined && k.source !== "" ? k.source : "—"

/** Render the relationship cells (conflicts / requires). Absent / empty ⇒
 *  empty string (the section is omitted from the detail view when both are
 *  empty). */
const relationshipsBlock = (k: AnyKnob): string => {
  const lines: string[] = []
  if (k.conflicts !== undefined && k.conflicts.length > 0) {
    lines.push(`Conflicts: ${k.conflicts.join(", ")}`)
  }
  if (k.requires !== undefined && k.requires.length > 0) {
    lines.push(`Requires: ${k.requires.join(", ")}`)
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n\n`
}

/** Build the full `docs/knobs.md` body. Pure. */
export const buildKnobsMarkdown = (knobs: readonly AnyKnob[], isoTimestamp: string): string => {
  const indexHeader = "| id | env | category | surfaces | cost | source |"
  const indexSep = "|---|---|---|---|---|---|"
  const indexRows = knobs.map(
    (k) =>
      `| \`${k.id}\` | \`${k.envKey}\` | ${k.category} | ${surfacesCell(k)} | ${costCell(
        k,
      )} | ${sourceCell(k)} |`,
  )
  const indexBlock = [
    `## Index (${knobs.length} knobs)`,
    "",
    indexHeader,
    indexSep,
    ...indexRows,
  ].join("\n")
  const details = knobs.map((k) => {
    const lines: string[] = [
      `## ${k.id}`,
      "",
      `ENV: \`${k.envKey}\``,
      `Surfaces: ${surfacesCell(k)}`,
      `Cost: ${costCell(k)} baseline`,
      `Source: ${sourceCell(k)}`,
      "",
      relationshipsBlock(k),
      k.describe,
    ]
    if (k.help !== undefined && k.help !== "") {
      lines.push("")
      lines.push(k.help)
    }
    return lines.filter((line) => line !== "").join("\n")
  })
  const header = [
    "# Knob registry — auto-generated",
    "",
    `Generated: ${isoTimestamp}`,
    "Run: `bun run tools/gen-knob-docs.ts`",
    "",
  ].join("\n")
  return `${header}${indexBlock}\n\n${details.join("\n\n")}\n`
}

/** Build the feature-catalog YAML body. Pure.
 *
 *  Output shape mirrors the existing 02-tool-system entries (e.g.
 *  `tools/feature-catalog/features/02-tool-system/01-edit.yaml`). The
 *  `knobs:` field carries the rollup list — every other id is the
 *  knob-detail view's source of truth. */
export const buildFeatureYaml = (knobs: readonly AnyKnob[]): string => {
  const ids = knobs.map((k) => `  - ${k.id}`).join("\n")
  return [
    "id: bench-knobs",
    "title: Bench knob registry — auto-generated rollup",
    "section: 2",
    "subsystem: 측정 시스템 — knob 등록부",
    "status: stable",
    "maturity: L4",
    "ui_surfaces: [bench, cli]",
    "monitoring: knobs_applied event",
    "modes: [n-a]",
    "configurable: env+cli+config-file+preset",
    "owners: ['@songmin']",
    "labels: [knob:framework, surface:bench]",
    "purpose: |",
    `  Auto-generated rollup of the ${knobs.length} bench-surface knobs. Each id is`,
    "  a self-contained record (env key + parse + apply + surfaces + cost). The",
    "  framework lives in `src/runner/knobs/` and is consumed by the bench driver",
    "  (`resolveBenchKnobs` + `applyBenchKnobs`) and by the matrix runner",
    "  (`tools/swebench-matrix.ts --axes`).",
    "evidence:",
    "  code:",
    "    - src/runner/knobs/registry.ts",
    "    - src/runner/knobs/resolve.ts",
    "    - src/runner/knobs/apply.ts",
    "    - src/runner/knobs/knobs",
    "  adrs: []",
    "  tests:",
    "    unit: [tests/unit/runner/knobs/]",
    "    integration: []",
    "    contract: []",
    "knobs:",
    ids,
    "deliberate_hold: null",
    "notes: 'Auto-generated by tools/gen-knob-docs.ts. Edits will be overwritten.'",
    "",
  ].join("\n")
}

/** README marker block — idempotent rewrite ONLY when the markers exist.
 *  Returns the input unchanged when markers absent (no-op). Returns the
 *  rewritten body when the markers' contents differ from the build. */
export const replaceReadmeBlock = (readme: string, knobs: readonly AnyKnob[]): string => {
  const startMarker = "<!-- knobs:start -->"
  const endMarker = "<!-- knobs:end -->"
  const startIdx = readme.indexOf(startMarker)
  const endIdx = readme.indexOf(endMarker)
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return readme
  const before = readme.slice(0, startIdx + startMarker.length)
  const after = readme.slice(endIdx)
  const tableHeader = "\n\n| id | env | category | cost |\n|---|---|---|---|"
  const rows = knobs
    .map((k) => `| \`${k.id}\` | \`${k.envKey}\` | ${k.category} | ${costCell(k)} |`)
    .join("\n")
  const newBlock = `${before}${tableHeader}\n${rows}\n\n${after}`
  if (newBlock === readme) return readme
  return newBlock
}

/** I/O side-effect entrypoint. Pure builders + Bun fs writes. */
export const main = async (): Promise<void> => {
  const knobs = await collectKnobsForDocs()
  const iso = new Date().toISOString()

  // 1. docs/knobs.md
  await Bun.write("docs/knobs.md", buildKnobsMarkdown(knobs, iso))

  // 2. feature catalog YAML
  await Bun.write(
    "tools/feature-catalog/features/02-tool-system/bench-knobs.yaml",
    buildFeatureYaml(knobs),
  )

  // 3. README marker block (only when present)
  let readme = ""
  try {
    readme = await Bun.file("README.md").text()
  } catch {
    readme = ""
  }
  if (readme !== "" && readme.includes("<!-- knobs:start -->")) {
    const updated = replaceReadmeBlock(readme, knobs)
    if (updated !== readme) await Bun.write("README.md", updated)
  }
}

if (import.meta.main) {
  main().catch((e) => {
    // biome-ignore lint/suspicious/noConsole: fatal-path operator output.
    console.error(`[gen-knob-docs] fatal: ${(e as Error).message}`)
    process.exit(1)
  })
}
