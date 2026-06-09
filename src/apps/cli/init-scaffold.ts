/**
 * LANE SLASH / Ticket 16 — `/init` CLAUDE.md (AGENTS.md) scaffold.
 *
 * A surface-only, **gated** (`QUANTA_INIT_SLASH`, default-OFF) one-shot that
 * bootstraps the project-rules file the agent loads at the top of every session
 * (`repo-rules` reads `AGENTS.md` / `CLAUDE.md` / `.codex/CODEX-RULES.md`). The
 * RICH path is the `/init` SKILL (`src/skill/system-skills/init/SKILL.md`) — a
 * registered `/init` slash SHADOWS it via dispatch precedence, so this slash is
 * a fast, deterministic, *mechanical* scaffold that also points at the skill for
 * the full LLM-authored treatment ("ask: refresh CLAUDE.md").
 *
 * Design constraints peculiar to the slash surface:
 *   - `SlashContext` has NO interactive confirm/prompt (one-shot). There is no
 *     Y/N. So the destructive-overwrite seam is filled by `--force` (refuse +
 *     exit 1 when the target exists and `--force` is absent) PLUS `--dry-run`
 *     (print the scaffold, write NOTHING, exit 0) as the real "preview before
 *     you commit" answer to the missing confirm.
 *   - AGENTS.md is PREFERRED as the write target when it already exists (multi-
 *     vendor SSOT, matching `loadRepoRules`' same-dir priority); otherwise the
 *     conventional `CLAUDE.md`.
 *   - The auto-generated sections are bracketed by sentinel markers so a FUTURE
 *     `--force` can regenerate ONLY the marked blocks surgically and leave human-
 *     authored prose intact. (This pass writes the whole file; the markers make
 *     the surgical refresh a pure-string future step, no migration needed.)
 *
 * Purity: `scaffoldClaudeMd` is a PURE function of `(cwd, opts)` — no clock, no
 * fs — so its output is a deterministic golden. The fs/shell effects live only
 * in `detectCommands` (reads package.json/Makefile/Justfile), `scanRepoMap`
 * (one `rg --files` via the injected shell), and `buildInitCmd`'s `run` body.
 * NO-THROW on the public surface: every fs/shell failure degrades to a typed
 * outcome, never a throw out of `run`.
 */

import { exec } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, stat, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { makeRepoMapScan, type RepoMapShell } from "@/runner/assemble/repo-map-scan"
import { errMessage } from "@/shared"
import { green, yellow } from "@/ui"
import type { SlashCommand, SlashContext } from "./slash-contract"

/** Sentinel markers bracketing the auto-generated block. A future `--force`
 *  refresh replaces ONLY the bytes between these two lines (surgical), leaving
 *  any human prose outside them untouched. Kept as literals so the scaffold
 *  stays clock-/fs-pure and the golden is stable. */
export const INIT_AUTO_START = "<!-- quanta:auto:start -->"
export const INIT_AUTO_END = "<!-- quanta:auto:end -->"

/** Conservative per-command detection result. `undefined` per field means "we
 *  could not verify a real command" — NEVER invent one (a rules file with a
 *  wrong command is worse than none). */
export interface DetectedCommands {
  readonly build?: string | undefined
  readonly test?: string | undefined
  readonly typecheck?: string | undefined
  readonly lint?: string | undefined
}

/** Options for {@link scaffoldClaudeMd}. Everything is pre-resolved by the
 *  effectful layer so the scaffold itself stays pure. */
export interface ScaffoldOpts {
  /** Already-truncated repo map (rides verbatim — the caller applied the cap). */
  readonly repoMap?: string | undefined
  readonly buildCmd?: string | undefined
  readonly testCmd?: string | undefined
  readonly typecheckCmd?: string | undefined
  readonly lintCmd?: string | undefined
}

/** Format one `## Quick Start` command bullet, or a placeholder when unknown. */
const cmdBullet = (label: string, cmd: string | undefined): string =>
  cmd !== undefined ? `- ${label}: \`${cmd}\`` : `- ${label}: _(not detected — fill in)_`

/**
 * PURE — render the rules-file body. Fixed section order:
 *   `# <basename>` / `## Quick Start` / `## Directory` / `## Key Files` /
 *   `## Conventions`. The `## Directory` body is the ALREADY-truncated repoMap
 *   verbatim (the caller owns the cap). The auto block is bracketed by the
 *   {@link INIT_AUTO_START}/{@link INIT_AUTO_END} sentinels so a later surgical
 *   `--force` can regenerate only the marked region.
 *
 * Deterministic: no clock, no fs, no env — same inputs ⇒ byte-identical output.
 */
export const scaffoldClaudeMd = (cwd: string, opts: ScaffoldOpts = {}): string => {
  const name = basename(cwd) || "project"
  const dirBody =
    opts.repoMap !== undefined && opts.repoMap.length > 0
      ? opts.repoMap
      : "_(repo map unavailable — run from a repo root)_"
  const lines: string[] = [
    `# ${name}`,
    "",
    INIT_AUTO_START,
    "",
    "## Quick Start",
    "",
    cmdBullet("Build", opts.buildCmd),
    cmdBullet("Test", opts.testCmd),
    cmdBullet("Typecheck", opts.typecheckCmd),
    cmdBullet("Lint", opts.lintCmd),
    "",
    "## Directory",
    "",
    "```",
    dirBody,
    "```",
    "",
    "## Key Files",
    "",
    "- _(list the 3-6 entry points / hot files a contributor must know)_",
    "",
    "## Conventions",
    "",
    "- _(the non-obvious rules a contributor must follow — derived from observed",
    "  patterns, not boilerplate)_",
    "",
    INIT_AUTO_END,
    "",
  ]
  return `${lines.join("\n")}\n`
}

/** Map a lockfile present in `cwd` to its package manager. Falls back to `npm`
 *  (the conservative default — `npm run <x>` works for any npm-compatible
 *  scripts block). */
const detectPm = (cwd: string): string => {
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun"
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn"
  return "npm"
}

interface PackageJsonShape {
  readonly scripts?: Record<string, unknown>
}

/** Read `cwd/package.json` and return its `scripts` map (string values only).
 *  NO-THROW: a missing / malformed file ⇒ `undefined`. */
const readScripts = async (cwd: string): Promise<Record<string, string> | undefined> => {
  const path = join(cwd, "package.json")
  if (!existsSync(path)) return undefined
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object") return undefined
  const scripts = (parsed as PackageJsonShape).scripts
  if (scripts === null || typeof scripts !== "object") return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}

/** Best-effort, conservative detection. Order:
 *   1. `package.json` scripts → `<pm> run <key>` for any of build/test/
 *      typecheck/lint that EXIST (never invent a missing one).
 *   2. No package.json → `Makefile` (`make <target>`) for the same targets.
 *   3. No Makefile → `Justfile` (`just <recipe>`).
 *   4. Nothing recognized ⇒ all fields `undefined`.
 *
 * NO-THROW. The detection NEVER fabricates a command: a field is set ONLY when
 * a real script/target/recipe of that name is present.
 */
export const detectCommands = async (cwd: string): Promise<DetectedCommands> => {
  const scripts = await readScripts(cwd)
  if (scripts !== undefined) {
    const pm = detectPm(cwd)
    const pick = (key: string): string | undefined =>
      scripts[key] !== undefined ? `${pm} run ${key}` : undefined
    return {
      build: pick("build"),
      test: pick("test"),
      typecheck: pick("typecheck"),
      lint: pick("lint"),
    }
  }
  // Fallback chain: Makefile then Justfile. We only read the file to confirm a
  // target/recipe of the expected name is declared — never invent one.
  const makefile = await readTextIfPresent(join(cwd, "Makefile"))
  if (makefile !== undefined) {
    const has = (target: string): string | undefined =>
      hasMakeTarget(makefile, target) ? `make ${target}` : undefined
    return {
      build: has("build"),
      test: has("test"),
      typecheck: has("typecheck"),
      lint: has("lint"),
    }
  }
  const justfile =
    (await readTextIfPresent(join(cwd, "Justfile"))) ??
    (await readTextIfPresent(join(cwd, "justfile")))
  if (justfile !== undefined) {
    const has = (recipe: string): string | undefined =>
      hasJustRecipe(justfile, recipe) ? `just ${recipe}` : undefined
    return {
      build: has("build"),
      test: has("test"),
      typecheck: has("typecheck"),
      lint: has("lint"),
    }
  }
  return {}
}

/** Read a file, returning its text or `undefined` if absent / unreadable. */
const readTextIfPresent = async (path: string): Promise<string | undefined> => {
  if (!existsSync(path)) return undefined
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

/** `target:` at the start of a line (allowing prerequisites after the colon). */
const hasMakeTarget = (makefile: string, target: string): boolean => {
  const re = new RegExp(`^${escapeRe(target)}\\s*:`, "m")
  return re.test(makefile)
}

/** `recipe:` (optionally with params before the colon) at line start — `just`
 *  recipes are declared `name args...:`. */
const hasJustRecipe = (justfile: string, recipe: string): boolean => {
  const re = new RegExp(`^${escapeRe(recipe)}(\\s[^:\\n]*)?\\s*:`, "m")
  return re.test(justfile)
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Re-run the repo-map scan (NOT cached — `/init` owns its own scan) via the
 *  injected shell. Best-effort: any failure ⇒ `undefined` (the scaffold then
 *  prints a placeholder Directory section). Caps mirror the prompt-assembly
 *  defaults so the embedded map is bounded regardless of repo shape. */
export const scanRepoMap = async (
  cwd: string,
  shell: RepoMapShell,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  try {
    const scan = makeRepoMapScan(signal !== undefined ? { shell, signal } : { shell })
    return await scan({ cwd, maxDepth: 3, maxFiles: 200, maxChars: 4000 })
  } catch {
    return undefined
  }
}

/** Count auto-blocks + total `##` sections in an existing file (for the
 *  refusal message — gives the human a sense of how much they'd lose). */
const countSections = (body: string): number => {
  let n = 0
  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) n += 1
  }
  return n
}

/** Human-readable byte size for the refusal message. */
const humanSize = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`

/** Dependencies for {@link buildInitCmd}. The shell is injected so the scan is
 *  unit-testable with canned `rg` stdout; the fs writer is injected so the
 *  write-failure NO-THROW path is exercisable without a real EACCES. */
export interface InitCmdDeps {
  /** Injected `rg --files` shell (the surface passes a `node:child_process`
   *  adapter; tests pass a canned `RepoMapShell`). */
  readonly shell?: RepoMapShell | undefined
  /** Test seam: override the file writer (default `node:fs/promises.writeFile`).
   *  Returns void on success; throwing simulates an fs failure (caught + mapped
   *  to a NO-THROW exit-1 by the caller). */
  readonly write?: ((path: string, data: string) => Promise<void>) | undefined
}

/** Resolve the write target: prefer an EXISTING `AGENTS.md` (multi-vendor SSOT,
 *  matching `loadRepoRules` priority); else an existing `CLAUDE.md`; else the
 *  conventional `CLAUDE.md` for a fresh write. Returns the filename + whether it
 *  already exists. */
const resolveTarget = (cwd: string): { file: string; path: string; exists: boolean } => {
  const agents = join(cwd, "AGENTS.md")
  if (existsSync(agents)) return { file: "AGENTS.md", path: agents, exists: true }
  const claude = join(cwd, "CLAUDE.md")
  if (existsSync(claude)) return { file: "CLAUDE.md", path: claude, exists: true }
  return { file: "CLAUDE.md", path: claude, exists: false }
}

const defaultWrite = (path: string, data: string): Promise<void> => writeFile(path, data, "utf8")

/** Default `rg --files` shell for the LIVE surface (tests inject their own canned
 *  shell). Runs the scan command in `cwd` via node's `exec`, best-effort with a
 *  5s cap + bounded buffer. NEVER throws: a non-zero exit (rg returns 1 on no
 *  matches) or a timeout resolves to a typed result the scanner treats as "no
 *  map" — `/init` then degrades to a scaffold without the Directory tree. */
const defaultRepoMapShell: RepoMapShell = (cmd, opts) =>
  new Promise((resolve) => {
    exec(
      cmd,
      {
        cwd: opts.cwd,
        timeout: 5000,
        maxBuffer: 16 * 1024 * 1024,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      },
      (error, stdout) => {
        const timedOut = error !== null && (error as { killed?: boolean }).killed === true
        const exitCode =
          error !== null && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error !== null
              ? 1
              : 0
        resolve({ stdout: stdout ?? "", exitCode, timedOut })
      },
    )
  })

/** Assemble the full scaffold for `cwd` (detect commands + scan map + render). */
const assembleScaffold = async (cwd: string, shell: RepoMapShell | undefined): Promise<string> => {
  const [cmds, repoMap] = await Promise.all([
    detectCommands(cwd),
    shell !== undefined ? scanRepoMap(cwd, shell) : Promise.resolve(undefined),
  ])
  return scaffoldClaudeMd(cwd, {
    repoMap,
    buildCmd: cmds.build,
    testCmd: cmds.test,
    typecheckCmd: cmds.typecheck,
    lintCmd: cmds.lint,
  })
}

/** Parse the `/init` flag set. Unknown args are reported (caller exits 1). */
const parseInitArgs = (
  args: readonly string[],
): { force: boolean; dryRun: boolean; unknown?: string } => {
  let force = false
  let dryRun = false
  for (const a of args) {
    if (a === "--force") force = true
    else if (a === "--dry-run") dryRun = true
    else return { force, dryRun, unknown: a }
  }
  return { force, dryRun }
}

type InitTarget = ReturnType<typeof resolveTarget>

/** Assemble the scaffold, mapping a (best-effort impossible but defensive)
 *  failure to a typed `{ err }` instead of a throw. NO-THROW seam. */
const tryAssemble = async (
  cwd: string,
  shell: RepoMapShell | undefined,
): Promise<{ body: string } | { err: string }> => {
  try {
    return { body: await assembleScaffold(cwd, shell) }
  } catch (e) {
    return { err: errMessage(e) }
  }
}

/** `--dry-run` branch — print the scaffold, write NOTHING. The real answer to
 *  the missing interactive-confirm seam: preview before you commit. */
const runDryRun = async (
  ctx: SlashContext,
  target: InitTarget,
  shell: RepoMapShell | undefined,
): Promise<number> => {
  const r = await tryAssemble(ctx.cwd, shell)
  if ("err" in r) {
    ctx.err(`/init: scaffold failed: ${r.err}\n`)
    return 1
  }
  ctx.out(r.body)
  ctx.out(yellow(`⚠ dry-run — nothing written. Re-run \`/init\` to write ${target.file}.\n`))
  return 0
}

/** Existing file + no `--force` ⇒ refuse (human sections would be lost). The
 *  refusal is the SOTA++ helpful seam: size + section count + exact re-run
 *  commands + the skill pointer (which preserves human prose). */
const runRefuse = async (ctx: SlashContext, target: InitTarget): Promise<number> => {
  let meta = "size unknown"
  try {
    const [st, body] = await Promise.all([stat(target.path), readFile(target.path, "utf8")])
    const sections = countSections(body)
    // Honest metadata only when the read SUCCEEDED — a stat/read fault must not
    // be reported as a real "0 B, 0 sections" (which would tell the user their
    // existing file is empty when it may be large). The refusal stands either way.
    meta = `${humanSize(st.size)}, ${sections} section${sections === 1 ? "" : "s"}`
  } catch {
    // best-effort metadata — refusal stands regardless of the read fault.
  }
  ctx.err(
    `/init: ${target.file} exists (${meta}). ` +
      `Re-run \`/init --force\` to overwrite (human sections lost), ` +
      `or \`/init --dry-run\` to preview, ` +
      `or ask "refresh CLAUDE.md" for the skill (preserves human prose).\n`,
  )
  return 1
}

/** Write branch (fresh file, or `--force` overwrite). NO-THROW: a scaffold or
 *  write failure is a typed exit-1 + friendly line. On success: green ✓ + the
 *  3-bullet summary (what the file is for / the surgical markers / the skill). */
const runWrite = async (
  ctx: SlashContext,
  target: InitTarget,
  shell: RepoMapShell | undefined,
  write: (path: string, data: string) => Promise<void>,
): Promise<number> => {
  const r = await tryAssemble(ctx.cwd, shell)
  if ("err" in r) {
    ctx.err(`/init: scaffold failed: ${r.err}\n`)
    return 1
  }
  try {
    await write(target.path, r.body)
  } catch (e) {
    ctx.err(`/init: failed to write ${target.file}: ${errMessage(e)}\n`)
    return 1
  }
  ctx.out(green(`✓ wrote ${target.path}\n`))
  ctx.out(`  • ${target.file} loads at the top of every session (repo-rules)\n`)
  ctx.out("  • auto sections are bracketed by quanta:auto markers — edit outside them\n")
  ctx.out('  • for a richer, LLM-authored pass: ask "refresh CLAUDE.md" (the /init skill)\n')
  return 0
}

/**
 * Build the `/init` slash command. Default-OFF: the surface only registers it
 * when `QUANTA_INIT_SLASH` is on, so when the gate is absent the command is not
 * in the registry at all (byte-identical). NO-THROW: every fs/shell failure is
 * a typed exit code + a friendly line, never an exception out of `run`.
 */
export const buildInitCmd = (deps: InitCmdDeps = {}): SlashCommand => {
  const write = deps.write ?? defaultWrite
  // Live surface (no injected shell) ⇒ scan the repo with the node-backed rg
  // shell; tests inject a canned shell and are unaffected.
  const shell = deps.shell ?? defaultRepoMapShell
  return {
    name: "/init",
    describe:
      "Scaffold an AGENTS.md / CLAUDE.md project-rules file from the repo (--dry-run | --force)",
    category: "other",
    async run(args, ctx: SlashContext): Promise<number> {
      const { force, dryRun, unknown } = parseInitArgs(args)
      if (unknown !== undefined) {
        ctx.err(`/init: unknown argument '${unknown}' (use --force or --dry-run)\n`)
        return 1
      }
      const target = resolveTarget(ctx.cwd)
      if (dryRun) return runDryRun(ctx, target, shell)
      if (target.exists && !force) return runRefuse(ctx, target)
      return runWrite(ctx, target, shell, write)
    },
  }
}
