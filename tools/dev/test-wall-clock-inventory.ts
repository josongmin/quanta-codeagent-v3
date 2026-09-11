#!/usr/bin/env bun
// biome-ignore-all lint/suspicious/noConsole: CLI tool — console is the IO surface.
/**
 * `tools/dev/test-wall-clock-inventory` — the committed classification of every
 * upper-bound wall-clock assertion in ordinary test source (TVH-15 item 1).
 *
 * # Why an inventory and not a fix
 *
 * There are 159 of these. They are NOT all defects: the same syntax carries four
 * different intents, and only two of them are wrong to run in the functional
 * tier. Rewriting 159 sites blind would delete real cancellation coverage. So
 * the first artifact is a per-site JUDGMENT, made by reading the site, stored
 * machine-readably, and then used as the ratchet's allowlist.
 *
 *   functional-deadline  the bound is the CONTRACT: a cancellation, clamp,
 *                        fail-fast or cycle-detection path exists, and without
 *                        it the call does not take longer — it does not return.
 *                        The alternative is orders of magnitude away (a 30s
 *                        sleep, an exponential backtrack, an infinite walk), so
 *                        host load cannot flip the verdict.
 *   performance-contract the bound judges HOST THROUGHPUT: N operations in M
 *                        milliseconds, with correctness already proven by a
 *                        separate assertion. A loaded box flips these, which is
 *                        exactly the false RED that amplifies into re-runs.
 *                        These belong in a measurement tier with warmup,
 *                        samples and a load band.
 *   test-only-settle     the bound is slack the TEST needs (clock skew between
 *                        two reads, a resolution allowance), not a property of
 *                        the unit.
 *   irrelevant-non-time  the compared value is not an elapsed measurement at
 *                        all — a call counter, an mtime ordering, a parsed
 *                        header delta under an injected clock.
 *
 * # Why sites are keyed by content, not by line
 *
 * A line number in a committed ledger is invalidated by every edit ABOVE it, in
 * a file this ledger does not own. The key is therefore
 * `<file>::<subject> <matcher> <bound>#<ordinal>` — stable under unrelated
 * edits, and unique even in `hard-deny-redos-bound.test.ts`, which has three
 * identical `elapsed < 100` sites. `line` is carried for navigation only and is
 * never compared.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type FileScan, scanTestSource, type WallAssertionSite } from "./test-determinism-scan"
import { listTestSources, REPO_ROOT } from "./test-source-corpus"

export const INVENTORY_PATH = join(REPO_ROOT, "tools", "dev", "test-wall-clock-inventory.json")

export type WallClassification =
  | "functional-deadline"
  | "performance-contract"
  | "test-only-settle"
  | "irrelevant-non-time"

export interface WallInventoryRow {
  readonly key: string
  readonly file: string
  /** Navigation only — never compared, because unrelated edits move it. */
  readonly line: number
  readonly matcher: string
  readonly subject: string
  readonly bound: string
  readonly evidence: WallAssertionSite["evidence"]
  readonly classification: WallClassification
  /** Why THIS site is that class. Written by reading the site, not by a regex. */
  readonly justification: string
}

export interface WallInventory {
  readonly schema: "quanta.test-wall-clock-inventory.v1"
  readonly counts: Readonly<Record<WallClassification, number>>
  readonly rows: readonly WallInventoryRow[]
}

/** Content key: stable under edits above the site, unique within a file. */
export const wallSiteKey = (site: WallAssertionSite, ordinal: number): string =>
  `${site.file}::${site.subject} ${site.matcher} ${site.bound}#${ordinal}`

/** Key every site of a scan, assigning ordinals to identical repeats. */
export const keyedWallSites = (
  scans: readonly FileScan[],
): readonly (WallAssertionSite & { readonly key: string })[] => {
  const seen = new Map<string, number>()
  const out: (WallAssertionSite & { readonly key: string })[] = []
  for (const scan of scans) {
    for (const site of scan.wall) {
      const base = wallSiteKey(site, 0).slice(0, -1)
      const ordinal = seen.get(base) ?? 0
      seen.set(base, ordinal + 1)
      out.push({ ...site, key: `${base}${ordinal}` })
    }
  }
  return out
}

export const loadWallInventory = (path: string = INVENTORY_PATH): WallInventory =>
  JSON.parse(readFileSync(path, "utf8")) as WallInventory

const countByClassification = (
  rows: readonly WallInventoryRow[],
): Record<WallClassification, number> => {
  const counts: Record<WallClassification, number> = {
    "functional-deadline": 0,
    "performance-contract": 0,
    "test-only-settle": 0,
    "irrelevant-non-time": 0,
  }
  for (const row of rows) counts[row.classification] += 1
  return counts
}

/**
 * Rebuild the inventory from the tree, carrying every existing classification
 * forward by KEY and refreshing the navigation line numbers.
 *
 * A site with no existing classification is reported, not invented: the
 * regenerate path refuses to write an unclassified row, so the only way into
 * this file is a human judgment.
 */
export const rebuildInventory = (
  scans: readonly FileScan[],
  previous: WallInventory,
): { readonly inventory: WallInventory; readonly unclassified: readonly string[] } => {
  const byKey = new Map(previous.rows.map((row) => [row.key, row]))
  const rows: WallInventoryRow[] = []
  const unclassified: string[] = []
  for (const site of keyedWallSites(scans)) {
    const existing = byKey.get(site.key)
    if (existing === undefined) {
      unclassified.push(`${site.file}:${site.line}  ${site.subject} ${site.matcher} ${site.bound}`)
      continue
    }
    rows.push({
      key: site.key,
      file: site.file,
      line: site.line,
      matcher: site.matcher,
      subject: site.subject,
      bound: site.bound,
      evidence: site.evidence,
      classification: existing.classification,
      justification: existing.justification,
    })
  }
  return {
    inventory: {
      schema: "quanta.test-wall-clock-inventory.v1",
      counts: countByClassification(rows),
      rows,
    },
    unclassified,
  }
}

const main = async (): Promise<number> => {
  const write = process.argv.includes("--write")
  const files = listTestSources()
  const scans = files.map((file) => scanTestSource(file.rel, file.text))
  const previous = loadWallInventory()
  const { inventory, unclassified } = rebuildInventory(scans, previous)
  const removed = previous.rows.filter(
    (row) => !inventory.rows.some((next) => next.key === row.key),
  )
  console.log(
    `[wall-inventory] scanned=${files.length} sites=${inventory.rows.length} ` +
      `unclassified=${unclassified.length} removed=${removed.length}`,
  )
  for (const [classification, count] of Object.entries(inventory.counts)) {
    console.log(`  ${classification}: ${count}`)
  }
  for (const site of unclassified) console.log(`  UNCLASSIFIED ${site}`)
  if (write) {
    if (unclassified.length > 0) {
      console.error("[wall-inventory] refusing to write with unclassified sites — classify first")
      return 1
    }
    writeFileSync(INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`)
    console.log(`[wall-inventory] wrote ${INVENTORY_PATH}`)
  }
  return unclassified.length > 0 ? 1 : 0
}

if (import.meta.main) process.exit(await main())
