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
 * ## The process must look like a FRESH operator, not a half-relocated one
 *
 * The first version fenced the Quanta roots and left `HOME` alone. That is the exact
 * shape of an operator midway through relocating their home: the memory factory's
 * pre-relocation probe reads `<env.HOME>/.quanta/memory/memory.sqlite` IN PLACE when
 * the relocated home has no store. So on a machine with a real store, an ordinary test
 * opened and migrated the developer's store (round-8 audit, reproduced: sha changed,
 * journal switched to WAL, 11 columns added) — and the 49-file measurement missed it
 * because every probe HOME there was empty. `tests/_support/hermetic-quanta-home.ts`
 * already pinned HOME for injected bags for this reason; the preload did not.
 *
 * So the fence mirrors the shard runner's worker layout (`run-test-shards.ts`):
 * `HOME=<root>/home`, `QUANTA_HOME=<root>/home/.quanta`, `QUANTA_PREFS_HOME=<root>/prefs-home`.
 * `os.homedir()` still answers the startup HOME inside this process (Bun ignores the
 * later assignment); code that reads the env sees the scratch one.
 *
 * ## Children
 *
 * A child spawned WITHOUT an `env` option may not see those assignments. Measured in plain
 * `bun` after reassigning `process.env.HOME`: `Bun.spawn`, `Bun.spawnSync`, `spawnSync`,
 * `execSync` and `execFileSync` hand the child the environment the process STARTED with;
 * `spawn`, `exec`, `execFile`, `fork` and `Bun.$` pass the new value (round-10 audit; this
 * said "every `node:child_process` spawner"). An earlier version said "every child process
 * sees the scratch one"; that was false, and 260 test-side spawns pass no `env` (round-9
 * audit). So the preload makes an omitted `env` mean `process.env` for all of them — see
 * {@link withFencedEnv}.
 *
 * An EXPLICIT `env` is the caller's, with one addition: when it names no `HOME`, the child
 * gets the fenced one. Without `HOME` a child's `os.homedir()` falls back to the passwd
 * entry — the developer's real home (round-10 audit, measured). Not patched, so neither
 * rule reaches them: worker threads (nothing under `src/`, `tests/` or `tools/` starts one)
 * and `Bun.$` — `$\`…\`.env({ PATH })` hands the child exactly that env, no `HOME`
 * (round-11 audit, measured; no test calls `.env()` on a Bun shell today).
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
 *   - `HOME`, `QUANTA_HOME`, `QUANTA_PREFS_HOME`: kept if they already point at scratch
 *     (a shard worker, or a nested `bun test` inheriting this fence), otherwise pointed
 *     at this process's scratch, with `QUANTA_HOME` under the (possibly kept) `HOME`.
 *
 * "Scratch" is under a temp root: this process's `tmpdir()`, `/tmp`, `/var/tmp` (and
 * their macOS `/private` forms), and the macOS per-user temp root `/var/folders/<a>/<b>/T`
 * when `tmpdir()` lives under it. The last one is what keeps a shard worker's homes: the
 * worker's own `TMPDIR` is `<root>/tmp`, a sibling of `<root>/home`, so matching only
 * `tmpdir()` threw the worker's roots away (round-8 audit).
 *
 * Blank counts as unset, because every resolver reads blank as absent.
 */
import { join, resolve, sep } from "node:path"
import { type ToolchainLink, toolchainLinks } from "../../tools/dev/toolchain-roots"

export interface QuantaHomeFenceInput {
  readonly env: Readonly<Record<string, string | undefined>>
  /**
   * Required, not defaulted: the one impure question the policy asks (does a
   * toolchain root exist under the HOME being replaced), injected so the policy
   * stays a function a test can drive. See `tools/dev/toolchain-roots.ts`.
   */
  readonly exists: (path: string) => boolean
  /** This process's scratch root. */
  readonly scratchRoot: string
  /** Roots that count as scratch (see {@link scratchPrefixesFor}). */
  readonly scratchPrefixes: readonly string[]
}

export interface QuantaHomeFenceDecision {
  readonly set: Readonly<Record<string, string>>
  readonly unset: readonly string[]
  /** Toolchain roots to lend into the replaced HOME (`tools/dev/toolchain-roots.ts`). */
  readonly lend: readonly ToolchainLink[]
}

export const isScratch = (value: string, prefixes: readonly string[]): boolean => {
  const abs = resolve(value)
  return prefixes.some((p) => {
    const root = resolve(p)
    return abs === root || abs.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
  })
}

const present = (v: string | undefined): v is string => v !== undefined && v.trim() !== ""

export const OUTRANKING_ROOTS = ["QUANTA_CONFIG_DIR", "QUANTA_BENCH_HOME"] as const

/**
 * Per-subsystem overrides that name where Quanta WRITES its own state. Each outranks the
 * Quanta home for its subsystem, so an operator who exported one (`QUANTA_SESSIONS_DIR`,
 * `QUANTA_MEMORY_PATH`, …) aimed that subsystem of the whole suite at their real files
 * however the roots were fenced (round-8 audit, reproduced for sessions, permission state
 * and memory). Removed when the value is an absolute or `~` path outside scratch; a
 * non-path value (`QUANTA_WEB_DB=memory`, `QUANTA_BENCH_RECORD_TRAJECTORY=0`) is a
 * selector, not a location, and is kept. The classification of EVERY string knob in the
 * catalogue — this list, the roots, and the reviewed non-state kinds — is enforced by
 * `tests/unit/cli/quanta-home-fence-string-knob-classification-hellgate.test.ts`, so a new
 * path knob cannot land unclassified.
 */
export const STATE_PATH_OVERRIDES = [
  // `/mcp enable|disable` writes the file `resolveMcpConfigPath` names, and these two name
  // it when QUANTA_MCP_CONFIG is unset (round-10 audit; they were filed "operator config").
  "QUANTA_BROWSER_MCP_CONFIG",
  "QUANTA_BROWSER_MCP_PLUGIN_DIR",
  "QUANTA_MCP_CONFIG", // the connector-install WRITE target (mcp-connector-wire), not only a read
  "QUANTA_OTEL_SINK", // span sink destination; not in the knob catalogue (raw env read)
  "QUANTA_BENCH_AUTH_FILE",
  "QUANTA_BENCH_RECORD_TRAJECTORY",
  "QUANTA_BENCH_SINGLE_BOX_GUARD_DIR",
  "QUANTA_BENCH_TOKEN_BUDGET_DIR",
  "QUANTA_BG_STORE_DIR",
  "QUANTA_BUDGET_LEDGER_PATH",
  "QUANTA_HISTORY_FILE",
  "QUANTA_INDEX_DB_PATH",
  "QUANTA_MEMORY_PATH",
  "QUANTA_OBSERVE_DIR",
  "QUANTA_OTEL_SAVE",
  "QUANTA_PERMISSION_STATE",
  "QUANTA_RADAR_FILE",
  "QUANTA_SESSION_EVENT_LOG_DIR",
  "QUANTA_SESSION_REGISTRY_DISK_DIR",
  "QUANTA_SESSION_REGISTRY_SQLITE_PATH",
  "QUANTA_SESSIONS_DIR",
  "QUANTA_SKILLS_DIR",
  "QUANTA_STATE_PATH",
  "QUANTA_SWEBENCH_REPO_CACHE",
  "QUANTA_WEB_DB",
  "QUANTA_WEB_DB_DIR",
] as const

const pathLike = (v: string): boolean => v.startsWith("/") || v.startsWith("~")
export const FENCED_ROOTS = ["HOME", "QUANTA_HOME", "QUANTA_PREFS_HOME"] as const

export const decideQuantaHomeFence = (input: QuantaHomeFenceInput): QuantaHomeFenceDecision => {
  const scratch = (v: string | undefined): v is string =>
    present(v) && isScratch(v, input.scratchPrefixes)
  const unset: string[] = []
  for (const key of OUTRANKING_ROOTS) {
    const v = input.env[key]
    if (v === undefined) continue
    if (!scratch(v)) unset.push(key)
  }
  for (const key of STATE_PATH_OVERRIDES) {
    const v = input.env[key]
    if (present(v) && pathLike(v.trim()) && !scratch(v.trim())) unset.push(key)
  }
  const set: Record<string, string> = {}
  const envHome = input.env.HOME
  const home = scratch(envHome) ? envHome : join(input.scratchRoot, "home")
  // Replacing a real HOME hides the toolchains that resolve through it; lend them.
  const lend =
    home === envHome ? [] : toolchainLinks({ home, realHome: envHome, exists: input.exists })
  if (home !== envHome) set.HOME = home
  if (!scratch(input.env.QUANTA_HOME)) set.QUANTA_HOME = join(home, ".quanta")
  if (!scratch(input.env.QUANTA_PREFS_HOME)) {
    set.QUANTA_PREFS_HOME = join(input.scratchRoot, "prefs-home")
  }
  return { set, unset, lend }
}

/** The macOS per-user temp root (`confstr(_CS_DARWIN_USER_TEMP_DIR)`) that `osTmp` sits
 *  under, in its `/var` spelling, or undefined. */
const darwinUserTempRoot = (osTmp: string): string | undefined => {
  const m = /^(?:\/private)?(\/var\/folders\/[^/]+\/[^/]+\/T)(?:\/|$)/.exec(resolve(osTmp))
  return m?.[1]
}

/**
 * The temp roots that count as scratch on this host: the OS temp dir as given (and its
 * macOS `/private` twin), `/tmp`, `/var/tmp` (both spellings), and the per-user temp
 * root `osTmp` lives under, if any.
 */
export const scratchPrefixesFor = (osTmp: string): readonly string[] => {
  const out = new Set<string>([osTmp, "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"])
  if (osTmp.startsWith("/var/")) out.add(`/private${osTmp}`)
  if (osTmp.startsWith("/private/var/")) out.add(osTmp.slice("/private".length))
  const userTemp = darwinUserTempRoot(osTmp)
  if (userTemp !== undefined) {
    out.add(userTemp)
    out.add(`/private${userTemp}`)
  }
  return [...out]
}

/**
 * Scratch roots left by test processes that no longer exist — a run killed by a
 * watchdog or a signal never reaches the global `afterAll`. Pure: the caller supplies
 * the directory listing and a liveness probe, and removes what this returns. A root
 * named for a LIVE pid is never returned, whoever owns that pid now.
 */
export const staleScratchRoots = (
  entries: readonly string[],
  isAlive: (pid: number) => boolean,
): readonly string[] => entries.filter((name) => /^[0-9]+$/.test(name) && !isAlive(Number(name)))

/* ── children inherit the fenced environment ───────────────────────────────── */

type Opts = Record<string, unknown>
const isPlainOptions = (v: unknown): v is Opts =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** An options bag whose `env` is `process.env` when the caller named none — `null`
 *  included, which Node reads as `process.env` (round-11: `own.HOME` threw on it) — and
 *  whose explicit `env` gains the fenced `HOME` when it names none. */
const fencedOptions = (o: Opts | undefined, env: NodeJS.ProcessEnv): Opts => {
  if (o === undefined || o.env == null) return { ...(o ?? {}), env }
  const own = o.env as Record<string, unknown>
  return own.HOME === undefined && env.HOME !== undefined
    ? { ...o, env: { ...own, HOME: env.HOME } }
    : o
}

/**
 * Normalise the arguments of one spawner call so an omitted `env` becomes `env`. Pure:
 * returns new arguments, never mutates the caller's. Signatures, by family:
 *  - `Bun.spawn(cmd[], opts?)`, `Bun.spawn({ cmd, … })` (and the Sync twins);
 *  - `spawn|spawnSync|execFile|execFileSync|fork(file, args?, opts?, cb?)`;
 *  - `exec|execSync(command, opts?, cb?)`.
 */
/** Where a `file-args` or `command` call keeps its options. `(file, undefined | null,
 *  options)` is a valid call with the options in slot 2; the previous rule saw no args
 *  array, spliced options into slot 1 and pushed the caller's options — explicit env and
 *  cwd included — out of reach (round-10 audit, measured). */
const optionsSlot = (family: "file-args" | "command", out: readonly unknown[]): number => {
  if (family === "command") return 1
  return Array.isArray(out[1]) || (out[1] == null && out.length > 2) ? 2 : 1
}

const fenceSlot = (out: unknown[], at: number, env: NodeJS.ProcessEnv): void => {
  if (isPlainOptions(out[at])) out[at] = fencedOptions(out[at], env)
  else if (at < out.length && out[at] == null) out[at] = fencedOptions(undefined, env)
  else out.splice(at, 0, fencedOptions(undefined, env))
}

export const withFencedEnv = (
  family: "bun" | "file-args" | "command",
  args: readonly unknown[],
  env: NodeJS.ProcessEnv,
): unknown[] => {
  const out = [...args]
  if (family === "bun") {
    if (isPlainOptions(out[0])) out[0] = fencedOptions(out[0], env)
    else out[1] = fencedOptions(isPlainOptions(out[1]) ? out[1] : undefined, env)
    return out
  }
  fenceSlot(out, optionsSlot(family, out), env)
  return out
}

/** The `node:child_process` spawners and the family each one's arguments belong to. */
export const CHILD_PROCESS_SPAWNERS = {
  spawn: "file-args",
  spawnSync: "file-args",
  execFile: "file-args",
  execFileSync: "file-args",
  fork: "file-args",
  exec: "command",
  execSync: "command",
} as const
