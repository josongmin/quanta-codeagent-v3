/**
 * The POLICY half of the test-suite fence around the Quanta home roots.
 *
 * `tests/setup.ts` (bun's preload) applies this; the decision is a pure function so a
 * unit test can drive it over hostile inputs — the same shape as
 * `bench-results-fence.ts`, and for the same reason.
 *
 * ## What is being fenced — measured
 *
 * A measurement pass ran the test files one at a time, each under a fresh probe HOME,
 * inside a sandbox that denied writes to the real home. FORTY-NINE files wrote
 * Quanta state into whatever HOME the test process started with: web-daemon
 * `threads.db`, `~/.quanta/sessions`, the durable memory store and stage1 WAL, the
 * permission state file, the external-config migration ledger, node-repl kernel
 * records, `~/.quanta/health.json`, and 31 files' worth of bench work, traces and
 * full-remote reports under `~/Library/quanta-codeagent-v3/bench`. On a normal run that
 * HOME is the developer's.
 *
 * Most reach those paths through a resolver that honours an env override —
 * `quantaHomeDir()` / `quantaHomeDirFrom(env)` (`QUANTA_CONFIG_DIR ?? QUANTA_HOME ??
 * ~/.quanta`), `benchHome()` (`QUANTA_BENCH_HOME ?? CONFIG_DIR ?? QUANTA_HOME ?? …`), or
 * the OAuth store's `QUANTA_PREFS_HOME`. So the preload can close them by pointing those
 * roots at scratch before any test runs. It cannot move `os.homedir()`: Bun ignores a
 * later `process.env.HOME = …` inside the process.
 *
 * Measured with this preload in place, re-running the 49 the same way: it closed 43. The
 * other six were fixed where they escaped, because each undid or bypassed the fence —
 * a `QUANTA_*` wipe, a child spawned with a rebuilt env, a `beforeEach` that deleted the
 * roots, an injected `{}` env bag, a `homeDir` seam the test did not use, and node-repl's
 * state store hard-coding the OS home. After those: 49 of 49 wrote nothing there.
 *
 * ## The rule keys on WHERE a value points, not whether it is set
 *
 * An operator who exports `QUANTA_CONFIG_DIR` or `QUANTA_BENCH_HOME` for their own work
 * would otherwise aim the whole suite at it — the bench-results fence learned this one
 * already. So:
 *
 *   - `QUANTA_CONFIG_DIR`, `QUANTA_BENCH_HOME`: removed unless they point at scratch.
 *     They outrank `QUANTA_HOME`, so leaving an ambient one would defeat the fence; and
 *     setting them here would outrank what an individual test sets.
 *   - `QUANTA_HOME`, `QUANTA_PREFS_HOME`: kept if they already point at scratch (the
 *     sharded runner's workers set them), otherwise pointed at this process's scratch.
 *
 * Blank counts as unset, because every resolver reads blank as absent.
 */
import { join, resolve, sep } from "node:path"

export interface QuantaHomeFenceInput {
  readonly env: Readonly<Record<string, string | undefined>>
  /** This process's scratch root. */
  readonly scratchRoot: string
  /** Roots that count as scratch (the OS temp dirs, canonical and aliased). */
  readonly scratchPrefixes: readonly string[]
}

export interface QuantaHomeFenceDecision {
  readonly set: Readonly<Record<string, string>>
  readonly unset: readonly string[]
}

const isScratch = (value: string, prefixes: readonly string[]): boolean => {
  const abs = resolve(value)
  return prefixes.some((p) => {
    const root = resolve(p)
    return abs === root || abs.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
  })
}

const present = (v: string | undefined): v is string => v !== undefined && v.trim() !== ""

export const OUTRANKING_ROOTS = ["QUANTA_CONFIG_DIR", "QUANTA_BENCH_HOME"] as const
export const FENCED_ROOTS = { QUANTA_HOME: "quanta-home", QUANTA_PREFS_HOME: "prefs-home" } as const

export const decideQuantaHomeFence = (input: QuantaHomeFenceInput): QuantaHomeFenceDecision => {
  const unset: string[] = []
  for (const key of OUTRANKING_ROOTS) {
    const v = input.env[key]
    if (v === undefined) continue
    if (!present(v) || !isScratch(v, input.scratchPrefixes)) unset.push(key)
  }
  const set: Record<string, string> = {}
  for (const [key, leaf] of Object.entries(FENCED_ROOTS)) {
    const v = input.env[key]
    if (present(v) && isScratch(v, input.scratchPrefixes)) continue
    set[key] = join(input.scratchRoot, leaf)
  }
  return { set, unset }
}

/**
 * The temp roots that count as scratch on this host: the OS temp dir as given, its
 * macOS canonical form (`/var/folders/…` is `/private/var/folders/…`), and `/tmp` with
 * its canonical `/private/tmp`.
 */
export const scratchPrefixesFor = (osTmp: string): readonly string[] => {
  const out = new Set<string>([osTmp, "/tmp", "/private/tmp"])
  if (osTmp.startsWith("/var/")) out.add(`/private${osTmp}`)
  if (osTmp.startsWith("/private/var/")) out.add(osTmp.slice("/private".length))
  return [...out]
}
