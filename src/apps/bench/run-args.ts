/**
 * Bench CLI-arg parsing concern — the argv/env flag readers extracted verbatim
 * from `apps/bench/run-main.ts`. Pure parsing helpers + the small dotenv shim
 * the local-run entry activates before any `runtimeConfig()` read.
 *
 * Same bench-bootstrap posture as `apps/bench/index.ts` (its own dotenv shim);
 * downstream `run-main.ts` receives resolved values.
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { logger } from "@/shared"

// ── tiny dotenv (no dependency, first-wins; apps/cli has its own copy) ──────
const unquote = (v: string): string =>
  (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
    ? v.slice(1, -1)
    : v

/** Parse one `KEY=VALUE` line into a pair, or null for blanks/comments. A
 *  leading `export ` prefix is stripped (matches apps/cli dotenv). */
const parseEnvLine = (raw: string): [string, string] | null => {
  let line = raw.trim()
  if (line === "" || line.startsWith("#")) return null
  if (line.startsWith("export ")) line = line.slice("export ".length).trimStart()
  const eq = line.indexOf("=")
  if (eq <= 0) return null
  return [line.slice(0, eq).trim(), unquote(line.slice(eq + 1).trim())]
}

export const loadEnv = (files: string[]): void => {
  for (const f of files) {
    const p = resolve(process.cwd(), f)
    if (!existsSync(p)) continue
    for (const raw of readFileSync(p, "utf8").split("\n")) {
      const pair = parseEnvLine(raw)
      if (pair && process.env[pair[0]] === undefined) process.env[pair[0]] = pair[1]
    }
  }
}

export const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  if (i >= 0) return process.argv[i + 1]
  const pref = `${flag}=`
  const eq = process.argv.find((a) => a.startsWith(pref))
  return eq !== undefined ? eq.slice(pref.length) : undefined
}

export const argFlag = (flag: string): boolean => process.argv.includes(flag)

/** Parse a `--flag <int>` argv value as a positive integer. `Number()` returns
 *  NaN on garbage (e.g. `--n abc`) and `Number("")`===0; both used to slip
 *  through the raw `Math.max(1, Number(...))` parses. Returns `fallback` when
 *  the flag is absent OR its value is not a positive integer. */
export const argPositiveInt = (flag: string, fallback: number): number => {
  const raw = argValue(flag)
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw.trim())) {
    logger.warn(`ignoring invalid ${flag}="${raw}" — must be a positive integer`)
    return fallback
  }
  const n = Number.parseInt(raw.trim(), 10)
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}

/** Resolve instance-level concurrency: `--concurrency <N>` flag >
 *  `QUANTA_BENCH_CONCURRENCY` env > 1 (serial, byte-identical). Parallelises
 *  patch-gen across instances; Docker grading stays serialised by the
 *  python-swebench mutex (arm64-safe). */
export const resolveConcurrency = (): number => {
  const flag = argValue("--concurrency")
  if (flag !== undefined) return argPositiveInt("--concurrency", 1)
  const env = process.env.QUANTA_BENCH_CONCURRENCY
  if (env !== undefined && /^\d+$/.test(env.trim())) {
    const n = Number.parseInt(env.trim(), 10)
    if (Number.isSafeInteger(n) && n > 0) return n
  }
  return 1
}

/** b2 repair CLI/env override parser. Absent / empty / invalid / 0 ⇒ OFF
 *  (undefined). Positive integer N ⇒ `{ maxRounds: N }`. Keeps the top-level
 *  bench contract honest: `--repair-rounds 0` means "no repair", not "enter
 *  the repair path and still run round-0 validation once". */
export const repairConfigFromArg = (
  repairArg: string | undefined,
): { maxRounds: number } | undefined => {
  if (repairArg === undefined || repairArg.trim() === "") return undefined
  if (!/^\d+$/.test(repairArg.trim())) return undefined
  const rounds = Number.parseInt(repairArg.trim(), 10)
  return Number.isSafeInteger(rounds) && rounds > 0 ? { maxRounds: rounds } : undefined
}
