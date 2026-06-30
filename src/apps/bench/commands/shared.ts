/**
 * Shared argv-parsing primitives + pure validators for the `quanta-bench`
 * subcommand handlers (extracted from cli.ts, ADR-0536 P0). These read
 * `process.argv` / `process.env` directly so every handler observes the same
 * single argv truth — moved verbatim out of cli.ts, behaviour-identical.
 */
import { readFileSync } from "node:fs"
import { gateOn } from "@/shared"
import { type AuthSource, resolveAuthSource, selectAuthSourceLabel } from "../auth-pool"

/** Every `instance_id` in a SWE-bench dataset jsonl — the expected set that
 *  instance-aware relaunch reconciles against to detect partial box loss.
 *  Best-effort: unparseable/blank lines are skipped, a missing file ⇒ []. */
export const readDatasetInstanceIds = (path: string): string[] => {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return []
  }
  const ids: string[] = []
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (t === "") continue
    try {
      const id = (JSON.parse(t) as { instance_id?: unknown }).instance_id
      if (typeof id === "string" && id !== "") ids.push(id)
    } catch {
      /* skip malformed line */
    }
  }
  return ids
}

/** Read a value flag in BOTH `--flag value` and `--flag=value` forms. The
 *  `=`-form previously fell through `indexOf` and was silently ignored. */
export const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  if (i >= 0) return process.argv[i + 1]
  const pref = `${flag}=`
  const eq = process.argv.find((a) => a.startsWith(pref))
  return eq !== undefined ? eq.slice(pref.length) : undefined
}
export const hasFlag = (flag: string): boolean => process.argv.includes(flag)
export const allowExtraBoxes = (): boolean =>
  hasFlag("--allow-extra-boxes") || gateOn(process.env, "QUANTA_ALLOW_EXTRA_BOXES")
export const waitForIdleBox = (): boolean =>
  hasFlag("--wait-for-idle") || gateOn(process.env, "QUANTA_BENCH_WAIT_FOR_IDLE")

export const resolveCliAuthSource = (): AuthSource => {
  const authPoolArg = argValue("--auth-pool")
  const authFileArg = argValue("--auth-file")
  const authLabelArg = argValue("--auth-label")
  const resolved = resolveAuthSource({
    env: process.env,
    ...(authPoolArg !== undefined ? { authPoolArg } : {}),
    ...(authFileArg !== undefined ? { authFileArg } : {}),
  })
  return authLabelArg !== undefined ? selectAuthSourceLabel(resolved, authLabelArg) : resolved
}

export const positiveMinutesFlagMs = (flag: string): number | undefined => {
  const raw = argValue(flag)
  if (raw === undefined || raw.trim() === "") return undefined
  const mins = Number(raw)
  return Number.isFinite(mins) && mins > 0 ? mins * 60_000 : undefined
}

/** Print a render* block (diff / explain / leaderboard markdown) to raw stdout
 *  — NOT via `logger.info`, which prefixes `[info]`, mangles embedded `\n` to
 *  `?`, and de-dups repeated lines (which silently swallowed identical
 *  gold/agent file lines in `explain`). Raw output is also copy-pasteable. */
export const printBlock = (s: string): void => {
  process.stdout.write(`${s}\n`)
}

/** Value-taking flags — their following token is a value, NOT a positional. */
export const VALUE_FLAGS = new Set([
  "--predictions",
  "--backend",
  "--dataset",
  "--max-workers",
  "--run-id",
  "--key",
  "--out",
  "--region",
  "--preset",
  "--title",
  "--patch",
  "--instance",
  "--datasets",
  "--workers",
  "--ami",
  "--max-box-wall-min",
  "--shards",
  "--observe-dir",
  "--mode",
  "--model",
  "--lines",
  "--auth-pool",
  "--auth-file",
  "--auth-label",
  "--chunk-size",
  "--microchunk-dir",
  "--max-parallel",
  "--port",
  "--run",
  "--save",
])

/** Positional args after the subcommand (argv[2]), skipping flags AND the
 *  value token that follows a value-flag (so `--preset x` doesn't leak `x`). */
export const positionals = (): string[] => {
  const rest = process.argv.slice(3)
  const out: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]
    if (tok === undefined) continue
    if (tok.startsWith("-")) {
      if (VALUE_FLAGS.has(tok)) i++ // skip its value
      continue
    }
    out.push(tok)
  }
  return out
}

/** model_name_or_path from the first prediction row — names the harness report
 *  file `<model>.<runId>.json`, so the backend must poll for the right name. */
export const modelNameFromPredictions = (path: string): string | undefined => {
  try {
    const first = readFileSync(path, "utf8")
      .split("\n")
      .find((l) => l.trim() !== "")
    if (first === undefined) return undefined
    const row = JSON.parse(first) as { model_name_or_path?: unknown }
    return typeof row.model_name_or_path === "string" ? row.model_name_or_path : undefined
  } catch {
    return undefined
  }
}

/** Coerce a prior report's `resolved_ids` to a clean `string[]` for `--skip-resolved`.
 *  Accepts a real string array OR a JSON-encoded string array (some swebench exports
 *  double-encode the id arrays); filters out non-strings / empties. Mirrors
 *  analyze/verdicts.ts strArray so a malformed report can't pollute the merged
 *  resolved tally or seed the skip set with non-string junk. */
export const resolvedIdsFromReport = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.length > 0)
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v)
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === "string" && x.length > 0)
      }
    } catch {
      // not JSON — fall through
    }
  }
  return []
}

/** Parse `--max-workers` for the remote swebench grade harness. ABSENT ⇒ ok with
 *  no value (backend default applies). A POSITIVE integer ⇒ ok with that value.
 *  Zero / negative / non-integer garbage ⇒ `invalid` — `Number.isInteger(Number("0"))`
 *  and `Number.isInteger(Number("-5"))` are both true, so the prior inline parser
 *  shipped `--max_workers 0` / `-5` verbatim into the remote harness command
 *  (a broken grade run). Mirrors the strict `argPositiveInt` guard index.ts uses
 *  for this same class. Pure (string in) so it is unit-testable without argv. */
export const parseMaxWorkers = (
  raw: string | undefined,
): { ok: true; value?: number } | { ok: false; raw: string } => {
  if (raw === undefined || raw.trim() === "") return { ok: true }
  const n = Number(raw)
  if (Number.isInteger(n) && n >= 1) return { ok: true, value: n }
  return { ok: false, raw }
}
