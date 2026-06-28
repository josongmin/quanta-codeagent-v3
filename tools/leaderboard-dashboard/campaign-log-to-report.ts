#!/usr/bin/env bun
/**
 * campaign-log-to-report — recover graded verdicts that are stuck in a campaign's
 * BOX LOG into a real report.json in the SSOT sink, so the dashboard shows them.
 *
 * WHY (jun-28): a full-remote box mirrors its report.json to the SSOT only when it
 * FINISHES its slice. A spot reclaim (or any mid-slice death) means the per-
 * instance verdicts — already graded by the official harness and streamed into
 * the box log (`■ <id> PASS — patch=…B turns=…`) — never reach a report file, so
 * the dashboard stays stale even though the grades exist. This tool parses those
 * streamed verdicts and writes one report.json into the canonical results dir;
 * the dashboard (report-backed, auto-refresh) then reflects them.
 *
 * The verdicts are REAL official-harness grades recovered verbatim from the log —
 * not synthesized. The report carries `source: "recovered-from-campaign-log"` so
 * its provenance is explicit.
 *
 *   bun campaign-log-to-report.ts --logs '/tmp/camp-w2-b*.log' \
 *       --preset agentless-v6-singlepass-execfull --tag w2 [--out <dir>] [--dry-run]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { Glob } from "bun"

// ── pure core (unit-tested) ─────────────────────────────────────────────────

export interface RawVerdict {
  id: string
  passed: boolean
  patchBytes: number
  turns: number
}

const VERDICT_RE = /■ (\S+) (PASS|FAIL) — patch=(\d+)B turns=(\d+)/g

/** Parse every `■ <id> PASS|FAIL — patch=NB turns=M` line from a campaign log. */
export function parseCampaignVerdicts(text: string): RawVerdict[] {
  const out: RawVerdict[] = []
  for (const m of text.matchAll(VERDICT_RE)) {
    out.push({
      id: m[1] as string,
      passed: m[2] === "PASS",
      patchBytes: Number.parseInt(m[3] as string, 10),
      turns: Number.parseInt(m[4] as string, 10),
    })
  }
  return out
}

export interface InstanceVerdict {
  id: string
  passed: boolean
  patchBytes: number
  turns: number
}

/** Collapse relaunch duplicates to ONE verdict per instance: a PASS on ANY attempt
 *  wins (matches the dashboard's any-pass=solved semantic), and among same-passed
 *  attempts the FEWEST-turns one is kept. */
export function dedupVerdicts(rows: readonly RawVerdict[]): InstanceVerdict[] {
  const best = new Map<string, RawVerdict>()
  for (const r of rows) {
    const cur = best.get(r.id)
    if (cur === undefined) {
      best.set(r.id, r)
      continue
    }
    // PASS beats FAIL; among equal pass-state, fewer turns wins.
    if ((r.passed && !cur.passed) || (r.passed === cur.passed && r.turns < cur.turns)) {
      best.set(r.id, r)
    }
  }
  return [...best.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export interface RecoveredReport {
  timestamp: string
  model: string | undefined
  source: string
  knobs: { preset: string; resolved: Record<string, never>; inactive: never[] }
  perInstance: Array<{ id: string; passed: boolean; patchBytes: number; turns: number }>
}

/** Build a report.json shaped exactly like a real bench report (perInstance +
 *  knobs.preset + model) so the dashboard parses it identically. */
export function buildReport(
  verdicts: readonly InstanceVerdict[],
  opts: { preset: string; model: string | undefined; timestamp: string },
): RecoveredReport {
  return {
    timestamp: opts.timestamp,
    model: opts.model,
    source: "recovered-from-campaign-log",
    knobs: { preset: opts.preset, resolved: {}, inactive: [] },
    perInstance: verdicts.map((v) => ({
      id: v.id,
      passed: v.passed,
      patchBytes: v.patchBytes,
      turns: v.turns,
    })),
  }
}

/** Recover the model id from a box log (`provider=…, model=gpt-5.5, n=1`). */
export function modelFromLog(text: string): string | undefined {
  return text.match(/model=([\w.-]+)/)?.[1]
}

// ── IO shell ────────────────────────────────────────────────────────────────

const argOf = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const main = (): void => {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`)
  }
  const logsGlob = argOf("--logs")
  const preset = argOf("--preset")
  const tag = argOf("--tag") ?? "recovered"
  if (logsGlob === undefined || preset === undefined) {
    out(
      "usage: campaign-log-to-report.ts --logs '<glob>' --preset <name> [--tag t] [--out dir] [--dry-run]",
    )
    process.exit(2)
  }
  const outDir =
    argOf("--out") ??
    (process.env.QUANTA_BENCH_RESULTS_DIR && process.env.QUANTA_BENCH_RESULTS_DIR !== "off"
      ? process.env.QUANTA_BENCH_RESULTS_DIR
      : join(homedir(), ".quanta", "bench", "results"))

  let text = ""
  let model: string | undefined
  for (const file of new Glob(logsGlob).scanSync({ absolute: true })) {
    const t = readFileSync(file, "utf8")
    text += t
    model ??= modelFromLog(t)
  }
  const verdicts = dedupVerdicts(parseCampaignVerdicts(text))
  if (verdicts.length === 0) {
    out(`no verdicts found in ${logsGlob}`)
    process.exit(1)
  }
  const report = buildReport(verdicts, { preset, model, timestamp: new Date().toISOString() })
  const passed = verdicts.filter((v) => v.passed)
  const dest = join(outDir, `report-campaign-recovered-${tag}.json`)
  if (process.argv.includes("--dry-run")) {
    out(`[dry-run] would write ${dest}`)
  } else {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(dest, JSON.stringify(report, null, 2))
    out(`wrote ${basename(dest)} → ${outDir}`)
  }
  out(
    `  ${verdicts.length} instances (${passed.length} PASS): ${passed.map((v) => v.id).join(", ")}`,
  )
}

if (import.meta.main) main()
