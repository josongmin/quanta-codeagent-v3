/**
 * External-config migration PERSIST adapter (H13).
 *
 * The converters in `./convert` turn competitor config into typed
 * {@link ConvertedItem}s; THIS module writes each item to the quanta location
 * + format that quanta's own READERS consume, so an imported config is actually
 * used on the next run. Destinations (each grep-confirmed against the reader):
 *
 *   - settings (permission) → `<project>/settings.json#permissions` — the
 *       Claude-shaped settings file quanta reads (`@/agent/command-hooks`
 *       loads `#hooks` from the SAME file; permissions ride alongside).
 *   - hooks                 → `<project>/settings.json#hooks` — read by
 *       `loadCommandHookBindings(join(cwd,"settings.json"))`.
 *   - mcp                   → `<project>/.mcp.json#mcpServers` — the standard
 *       `.mcp.json` shape `readMcpConfig` accepts. `env` is NEVER written
 *       (the converter already dropped it; we preserve that — defense in depth).
 *   - subagents             → `<project>/.quanta/agents/<name>.md` — frontmatter
 *       round-trips through `@/skill/frontmatter#parseFrontmatter`.
 *   - agents_md (repo-rules)→ `<project>/AGENTS.md` — quanta's native rule
 *       entrypoint, read by `@/agent/repo-rules#loadRepoRules`.
 *   - cursor_rules          → `<project>/.quanta/rules/<name>.md` — read by
 *       `@/agent/glob-rules#loadGlobRules` (native rule dir, `.md`/`.mdc`).
 *
 * Discipline (mirrors the slice's versioned-sibling + throttle discipline):
 *   - IDEMPOTENT + SAFE: never silently overwrite an existing quanta config.
 *       JSON settings/.mcp.json are MERGED (union of allow/deny/ask, peer keys
 *       preserved). Markdown destinations (AGENTS.md, subagent/glob `.md`) are
 *       written as a `*.imported.md` SIBLING when the native file already
 *       exists — the imported content is never lost AND the native is untouched.
 *   - ATOMIC + SINGLE-RESOLUTION (jun-10 audit #17): the JSON merge writers
 *       resolve their destination ONCE (parent realpath + leaf) and commit via
 *       `@/storage` writeFileAtomic temp+rename — no torn settings.json/.mcp.json
 *       on crash, no check→write symlink TOCTOU window.
 *   - LEDGER: on a successful persist we record `imported` for the source key
 *       so a 2nd run is a no-op (throttled). Caller passes the `sourceKey`.
 *   - NO-THROW: a single item's persist failure becomes a typed
 *       {@link MigrationWarning}; the remaining items still persist.
 *   - DEFAULT-OFF: `enabled === false` ⇒ zero disk touch (byte-identical).
 *
 * This module is env-free + homedir-free (every path injected) so it stays
 * inside the isolated migration slice; the CLI surface resolves the knob +
 * homeDir + projectDir and calls in.
 */

import { createHash, randomBytes } from "node:crypto"
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { errMessage, logger } from "@/shared"
import { isThrottled, loadMigrationLedger, recordDisposition } from "./ledger"
import type {
  ConvertedGlobRule,
  ConvertedHook,
  ConvertedItem,
  ConvertedMcpServer,
  ConvertedMemory,
  ConvertedRepoRules,
  ConvertedSettings,
  ConvertedSkill,
  ConvertedSubagent,
  MigrationItemType,
  MigrationWarning,
  SkillStagePort,
} from "./types"

/**
 * Durability barrier for the JSON atomic commit — the SAME shape the slice's
 * sibling import-log writer exposes (`ImportLogSync` in `@/migration`), declared
 * locally because this slice is fenced to `@/shared` only (ADR-0038). Splitting
 * the temp-file fsync from the parent-dir fsync lets a fault-injection test stub
 * them and PROVE the ordering invariant: the rename NEVER runs if the temp
 * fsync rejected (no torn file surfaces as committed). Defaults issue a real
 * `fsync(2)` via an `fs/promises` handle.
 */
export interface ConfigWriteSync {
  /** Flush the temp file's bytes to stable storage BEFORE the rename. A
   *  rejection ABORTS the commit — the rename must not run, the temp is
   *  cleaned up, and the original file is left byte-identical. */
  readonly syncFile: (path: string) => Promise<void>
  /** Flush the parent directory AFTER a successful rename so the new dirent is
   *  durable. Best-effort — a rejection is swallowed (some platforms reject a
   *  directory fsync and the bytes are already safe). */
  readonly syncDir: (dir: string) => Promise<void>
}

/** Real durability barrier — `fsync` via an `fs/promises` file handle. Mirrors
 *  `defaultImportLogSync`: the dir flush swallows the platforms that reject a
 *  directory `fsync` (Windows / some FUSE mounts) since the bytes are already
 *  durable from the temp flush + rename. */
export const defaultConfigWriteSync: ConfigWriteSync = {
  syncFile: async (path) => {
    const handle = await open(path, "r+")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
  syncDir: async (dir) => {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(dir, "r")
      await handle.sync()
    } catch (e) {
      // Directory fsync rejected (EISDIR/EPERM/EINVAL on some platforms) — the
      // bytes are already durable from the temp flush + rename, so swallow.
      logger.debug(`config-migration: parent-dir fsync skipped: ${errMessage(e)}`)
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined)
    }
  },
}

/** Inputs to a persist run. Every path injected (slice stays env-free). */
export interface PersistConvertedInput {
  /** Resolved opt-in knob. False ⇒ byte-identical no-op (nothing written). */
  readonly enabled: boolean
  readonly homeDir: string
  readonly projectDir: string
  /** The converter outputs to persist (only `ok:true` items are written). */
  readonly converted: readonly ConvertedItem[]
  /** Stable source key for the ledger `imported` record + throttle check. When
   *  omitted, no ledger row is written (the caller didn't track a source). */
  readonly sourceKey?: string
  /** Durability barrier override (fault-injection seam). Defaults to a real
   *  `fsync(2)`; a test injects a rejecting `syncFile` to prove the commit is
   *  fail-closed (rename skipped, original bytes intact, no temp residue). */
  readonly writeSync?: ConfigWriteSync
  /** RFC03-4 — the host-composed staging port for imported SKILLS. When absent,
   *  imported skills are NOT written anywhere (fail-closed: an imported skill
   *  must go through the RFC03-2/3 proposal/promote pipeline, never a live-dir
   *  write). The host (CLI surface) composes it from the real
   *  `SkillProposalArtifactPort` + approval machine and injects it here. */
  readonly skillStage?: SkillStagePort
}

/** Result of a persist run. */
export interface PersistConvertedResult {
  /** True ⇒ at least one item was written to disk this run. */
  readonly persisted: boolean
  /** True ⇒ the source key was already `imported`/seen ⇒ suppressed (no-op). */
  readonly throttled: boolean
  /** Per-item non-fatal warnings (a single failed write does not throw). */
  readonly warnings: readonly MigrationWarning[]
  /** The item types actually written this run (diagnostics). */
  readonly writtenTypes: readonly MigrationItemType[]
}

const EMPTY_RESULT: PersistConvertedResult = Object.freeze({
  persisted: false,
  throttled: false,
  warnings: [],
  writtenTypes: [],
})

/** True iff `path` exists (file OR dir). */
const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// ─── SYMLINK-ESCAPE guard on the WRITE destination (O_NOFOLLOW) ───────────
//
// The READ side of this slice is already O_NOFOLLOW-hardened (`readImportFile`
// → `refuseSymlink`, N10): an import SOURCE that is a symlink is refused so a
// crafted `.claude/x → ~/.ssh/id_rsa` cannot leak credentials. The WRITE side
// had no symmetric guard — a competitor tree whose `settings.json` / `.mcp.json`
// DESTINATION is a symlink pointing OUT of the project (e.g. at
// `~/.ssh/authorized_keys`) would have `writeFile` FOLLOW the link and CLOBBER
// the outside target: a path-traversal WRITE. We fail CLOSED: a symlinked
// destination is REFUSED (never followed), surfaced as a typed warning — the
// same posture as the corrupt-target refusal (refuse rather than destroy).

/** True iff `path` is itself a symlink (lstat, no-follow). Absent / a real file
 *  / a real dir ⇒ false. A symlinked DESTINATION must NEVER be written through
 *  (it could point outside the project tree). */
const isSymlinkDestination = async (path: string): Promise<boolean> => {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch {
    // ENOENT (no destination yet) or any stat failure ⇒ not a symlink to follow.
    return false
  }
}

/** A symlinked write destination: refuse + surface a typed warning (never
 *  follow the link to clobber whatever it points at). */
const symlinkTargetWarning = (path: string): MigrationWarning =>
  writeWarning(
    path,
    "symlink-escape: destination is a symlink — refusing to write through it (no-follow)",
  )

/** jun-10 silent-failure audit #17 — resolve a JSON destination ONCE (realpath
 *  of the PARENT dir + re-joined leaf) so the symlink check, the existing-state
 *  read, and the atomic write all operate on the SAME resolved real path.
 *  Re-walking the original path per operation was a TOCTOU: a symlink planted
 *  between the `lstat` check and the old `writeFile` was FOLLOWED — a
 *  path-traversal clobber. After this single resolution nothing re-resolves,
 *  and the atomic temp+rename below REPLACES (never follows) any later-planted
 *  leaf symlink. Deliberately does NOT realpath the LEAF: a symlinked leaf must
 *  stay visible to `isSymlinkDestination` so the write-jail refusal holds.
 *  Throws when the parent dir is missing (the per-item loop surfaces it as a
 *  typed warning — same posture as the old writeFile ENOENT). */
const resolveJsonDestinationOnce = async (path: string): Promise<string> =>
  join(await realpath(dirname(path)), basename(path))

/** Probe the original file's permission bits (absent / unstat-able ⇒
 *  `undefined` — a NEW file keeps default perms, byte-identical to the old
 *  plain create). Attributed at debug: this is a benign existence probe. */
const statModeOrUndefined = async (path: string): Promise<number | undefined> => {
  try {
    return (await stat(path)).mode
  } catch (e) {
    logger.debug(`config-migration: no original mode to preserve (new file?): ${errMessage(e)}`)
    return undefined
  }
}

/** Atomic + DURABLE commit for the JSON merge writers (audit #17, jun-10 D10):
 *  write to a temp in the SAME (already-resolved) directory, `fsync` the temp
 *  BEFORE the rename (durability barrier), re-apply the original file's mode,
 *  `rename` into place, then best-effort `fsync` the PARENT DIR so the new
 *  dirent survives a crash. A crash mid-write can no longer tear the user's
 *  settings.json/.mcp.json into a file the next run classifies "corrupt" and
 *  permanently refuses to self-heal — and a `rename` REPLACES (never follows) a
 *  later-planted leaf symlink, so the check→write TOCTOU is closed too.
 *
 *  Reaches PARITY with the slice's sibling import-log writer (`appendImportLog`
 *  in `@/migration`, ADR-0038) and `@/storage` writeFileAtomic (ADR-0398): the
 *  fsync barrier + parent-dir flush + EXDEV `copyFile` fallback are all present,
 *  and the barrier is INJECTABLE via {@link ConfigWriteSync} (the same seam
 *  shape the import-log writer exposes). Re-declared locally because the
 *  migration slice is fenced to `@/shared` only (ADR-0038), the same precedent
 *  as `@/storage` mirroring the `@/lsp` atomic adapter rather than crossing its
 *  fence. A failure anywhere BEFORE the rename (incl. a rejected `syncFile`)
 *  leaves the original untouched — the partial temp is cleaned up — and
 *  propagates to the per-item loop's typed-warning catch. */
const writeJsonAtomic = async (
  path: string,
  value: Record<string, unknown>,
  sync: ConfigWriteSync,
): Promise<void> => {
  const content = `${JSON.stringify(value, null, 2)}\n`
  const temp = `${path}.quanta-tmp-${randomBytes(8).toString("hex")}`
  const originalMode = await statModeOrUndefined(path)
  try {
    await writeFile(temp, content, "utf8")
    // Durability barrier: flush the temp's bytes BEFORE the rename so a torn /
    // zero-length temp can never be promoted under the final name. A rejection
    // ABORTS the commit (caught below: temp cleaned, original untouched).
    await sync.syncFile(temp)
    if (originalMode !== undefined) {
      // Best-effort mode carry-over (bytes are the contract; mode is the bonus).
      await chmod(temp, originalMode).catch((e) => {
        logger.debug(`config-migration: mode preservation failed: ${errMessage(e)}`)
      })
    }
  } catch (e) {
    // Best-effort cleanup of the partial temp; the ORIGINAL error wins.
    await unlink(temp).catch((cleanupErr) => {
      logger.debug(`config-migration: atomic temp cleanup failed: ${errMessage(cleanupErr)}`)
    })
    throw e
  }
  // POSIX rename(temp, path) — atomic on the same filesystem (the temp lives
  // next to the destination by construction). EXDEV is unreachable here (temp
  // is a sibling of path), but if a future caller hands a cross-device temp the
  // fallback copies+removes rather than throwing — matching writeFileAtomic.
  try {
    await rename(temp, path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") {
      await unlink(temp).catch(() => undefined)
      throw e
    }
    await copyFile(temp, path)
    await unlink(temp).catch((cleanupErr) => {
      logger.debug(`config-migration: post-copy temp cleanup failed: ${errMessage(cleanupErr)}`)
    })
  }
  // Parent-dir fsync so the rename's new dirent is durable across a crash.
  // Best-effort (swallows EISDIR/EPERM/EINVAL) — the bytes are already safe.
  await sync.syncDir(dirname(path))
}

/**
 * The state of an existing JSON config target, read fail-CLOSED.
 *
 *  - `absent`  — the file does not exist ⇒ a fresh write from an empty base.
 *  - `empty`   — present but whitespace-only ⇒ also a fresh base (a 0-byte or
 *                blank file carries no user data to lose).
 *  - `object`  — present, parses to a plain JSON object ⇒ merge into it.
 *  - `corrupt` — present but NOT parseable as a JSON object (JSONC, hand-edit,
 *                trailing garbage, or a top-level array/scalar). We REFUSE to
 *                overwrite — clobbering it to `{}` would DESTROY the user's
 *                file (audited permissions / MCP servers). The caller surfaces
 *                a `config-unreadable` warning and writes nothing.
 */
type ExistingJson =
  | { readonly state: "absent" }
  | { readonly state: "empty" }
  | { readonly state: "object"; readonly value: Record<string, unknown> }
  | { readonly state: "corrupt" }

/** Read an existing JSON config target, fail-CLOSED on a corrupt present file
 *  (never clobbers a hand-edited / JSONC config to `{}`). */
const readExistingJson = async (path: string): Promise<ExistingJson> => {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    return { state: "absent" }
  }
  if (raw.trim().length === 0) return { state: "empty" }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: "corrupt" }
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return { state: "object", value: parsed as Record<string, unknown> }
  }
  // A top-level array or scalar is not a config object — refuse rather than
  // silently discard it.
  return { state: "corrupt" }
}

/** A target was present-but-unparseable: refuse + surface a typed warning
 *  (mirrors the `.mcp.json` writer's `config-unreadable` posture). */
const corruptTargetWarning = (path: string): MigrationWarning =>
  writeWarning(path, "config-unreadable: existing target is corrupt — refusing to overwrite")

/** Union two string lists, order-stable (existing first, then new), deduped. */
const unionList = (existing: unknown, incoming: readonly string[]): string[] => {
  const base = Array.isArray(existing)
    ? existing.filter((x): x is string => typeof x === "string")
    : []
  const out = [...base]
  for (const v of incoming) {
    if (!out.includes(v)) out.push(v)
  }
  return out
}

/** YAML-quote a scalar when it needs it (leading/trailing space, special chars). */
const yamlScalar = (v: string): string => (/^[\w.@/+-]+$/.test(v) ? v : JSON.stringify(v))

/** Render a frontmatter `.md` doc from a flat key→(scalar|list) map + body.
 *  Round-trips through `parseFrontmatter` (`---` fences, `key: value`, inline
 *  `[a, b]` lists). Empty-string scalars are omitted (parser would read `key:`
 *  as an empty list). */
const renderFrontmatterDoc = (
  fields: ReadonlyArray<readonly [string, string | readonly string[]]>,
  body: string,
): string => {
  const lines: string[] = ["---"]
  for (const [key, value] of fields) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map(yamlScalar).join(", ")}]`)
    } else if (typeof value === "string" && value.length > 0) {
      lines.push(`${key}: ${yamlScalar(value)}`)
    }
  }
  lines.push("---", "", body.endsWith("\n") ? body.slice(0, -1) : body, "")
  return lines.join("\n")
}

/** Sanitize a name into a filesystem-safe stem (no separators / traversal). */
const safeStem = (name: string): string => {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "")
  return cleaned.length > 0 ? cleaned : "imported"
}

/** Build a `skipped_malformed`-style write warning. */
const writeWarning = (path: string, detail: string): MigrationWarning => ({
  kind: "unreadable",
  path,
  detail,
})

// ─── CODE-EXEC guard on .mcp.json command/args ───────────────────────────
//
// `.mcp.json` is EXECUTABLE: quanta spawns `command` with `args`. A competitor
// config is UNTRUSTED, so a planted `command` / `arg` carrying a shell
// metacharacter (pipeline, command-substitution, redirection, control char)
// must NEVER be written into the executable config. We accept only a "plain"
// token — no whitespace in the command, no shell metacharacters in either.

/** Shell metacharacters that turn a token into a code-exec vector once it
 *  reaches a shell or an `argv` boundary. */
const SHELL_METACHAR = /[|&;<>$`(){}[\]!*?]/

/** True iff `s` contains a C0 control char (code point < 0x20 — incl. NUL,
 *  TAB, newline). Checked by code point so no raw control char lives in
 *  source. */
const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x20) return true
  }
  return false
}

/** A safe MCP `command`: a single token (no whitespace) with no shell
 *  metacharacters or control chars. `node`, `/usr/local/bin/mcp-fs`, `mcp-fs`
 *  pass; `rm -rf ~; curl|sh`, `node evil`, `node\nrm -rf /` are rejected. */
const isSafeCommand = (command: string): boolean =>
  command.length > 0 &&
  !/\s/.test(command) &&
  !SHELL_METACHAR.test(command) &&
  !hasControlChar(command)

/** A safe MCP `arg`: no shell metacharacters or control chars. Path-y args
 *  (`--root`, `/x/y`, `--port=8080`) pass; `$(whoami)`, `` `id` ``,
 *  `x>/etc/passwd` are rejected. */
const isSafeArg = (arg: string): boolean => !SHELL_METACHAR.test(arg) && !hasControlChar(arg)

/** True iff EVERY executable field of an mcp entry is shell-safe. A non-stdio
 *  entry (no command) is structurally safe — there is nothing to spawn. */
const isSafeMcpEntry = (entry: {
  readonly command?: string
  readonly args?: readonly string[]
}): boolean => {
  if (entry.command !== undefined && !isSafeCommand(entry.command)) return false
  if (entry.args !== undefined && !entry.args.every(isSafeArg)) return false
  return true
}

/** Thrown by {@link writeNoClobber} when the path it would write is a symlink
 *  (no-follow). Caught by the per-item loop in `persistConvertedItems` and
 *  turned into a typed warning — never followed to clobber an outside file. */
class SymlinkWriteRefusedError extends Error {
  constructor(readonly destPath: string) {
    super(`symlink-escape: refusing to write through symlink ${JSON.stringify(destPath)}`)
  }
}

/** Write `content` to `path`, but NEVER silently overwrite: if `path` already
 *  exists, write a `<stem>.imported<ext>` SIBLING instead. Returns the path
 *  actually written. Parent dirs are created. O_NOFOLLOW: if the path actually
 *  chosen to write is itself a symlink, REFUSE (never follow it out of tree). */
const writeNoClobber = async (path: string, content: string): Promise<string> => {
  const target = (await pathExists(path)) ? siblingImportedPath(path) : path
  if (await isSymlinkDestination(target)) throw new SymlinkWriteRefusedError(target)
  await mkdir(dirOf(target), { recursive: true })
  await writeFile(target, content, "utf8")
  return target
}

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")))

/** `/a/b/AGENTS.md` → `/a/b/AGENTS.imported.md`; extensionless → `.imported`. */
const siblingImportedPath = (path: string): string => {
  const slash = path.lastIndexOf("/")
  const dir = path.slice(0, slash + 1)
  const base = path.slice(slash + 1)
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return `${dir}${base}.imported`
  return `${dir}${base.slice(0, dot)}.imported${base.slice(dot)}`
}

// ─── per-type writers ────────────────────────────────────────────────────

/** Outcome of a JSON-config writer: whether a write actually happened + any
 *  non-fatal warnings (corrupt-target refusal, dropped unsafe entry). */
interface WriteOutcome {
  readonly wrote: boolean
  readonly warnings: readonly MigrationWarning[]
}

const NO_WRITE = (warning: MigrationWarning): WriteOutcome => ({
  wrote: false,
  warnings: [warning],
})

/** settings (permission) → `<project>/settings.json#permissions`. MERGES into
 *  any existing settings.json: union allow/deny/ask, preserve peer keys, only
 *  set `defaultMode` when absent (never override a native choice). Fail-CLOSED:
 *  a present-but-corrupt settings.json is preserved (refused), not clobbered. */
const persistSettings = async (
  projectDir: string,
  value: ConvertedSettings,
  sync: ConfigWriteSync,
): Promise<WriteOutcome> => {
  const path = await resolveJsonDestinationOnce(join(projectDir, "settings.json"))
  if (await isSymlinkDestination(path)) return NO_WRITE(symlinkTargetWarning(path))
  const existing = await readExistingJson(path)
  if (existing.state === "corrupt") return NO_WRITE(corruptTargetWarning(path))
  const current = existing.state === "object" ? existing.value : {}
  const existingPerms =
    typeof current.permissions === "object" && current.permissions !== null
      ? (current.permissions as Record<string, unknown>)
      : {}
  const permissions: Record<string, unknown> = {
    ...existingPerms,
    allow: unionList(existingPerms.allow, value.allow),
    deny: unionList(existingPerms.deny, value.deny),
    ask: unionList(existingPerms.ask, value.ask),
  }
  const next: Record<string, unknown> = { ...current, permissions }
  if (value.defaultMode !== undefined && current.defaultMode === undefined) {
    next.defaultMode = value.defaultMode
  }
  await writeJsonAtomic(path, next, sync)
  return { wrote: true, warnings: [] }
}

/** hooks → `<project>/settings.json#hooks` in the exact Claude shape
 *  `loadCommandHookBindings` parses: `{ <Event>: [ { matcher?, hooks:[{type,
 *  command}] } ] }`. MERGES: appends groups under each event, preserving any
 *  existing hooks (idempotent — an identical group is not duplicated).
 *  Fail-CLOSED on a corrupt existing settings.json. */
const persistHooks = async (
  projectDir: string,
  value: readonly ConvertedHook[],
  sync: ConfigWriteSync,
): Promise<WriteOutcome> => {
  const path = await resolveJsonDestinationOnce(join(projectDir, "settings.json"))
  if (await isSymlinkDestination(path)) return NO_WRITE(symlinkTargetWarning(path))
  const existing = await readExistingJson(path)
  if (existing.state === "corrupt") return NO_WRITE(corruptTargetWarning(path))
  const current = existing.state === "object" ? existing.value : {}
  const hooks: Record<string, unknown[]> = {}
  const existingHooks =
    typeof current.hooks === "object" && current.hooks !== null
      ? (current.hooks as Record<string, unknown>)
      : {}
  for (const [event, groups] of Object.entries(existingHooks)) {
    if (Array.isArray(groups)) hooks[event] = [...groups]
  }
  for (const h of value) {
    const group: Record<string, unknown> = {
      ...(h.matcher !== undefined ? { matcher: h.matcher } : {}),
      hooks: h.commands.map((command) => ({ type: "command", command })),
      // T04 trust gate — an IMPORTED hook is external/untrusted shell, so stamp
      // the review marker the command-hooks loader reads (TIGHTENING-only: the
      // legacy `parseCommandHookBindings` honors `needsReview:true` → the hook
      // is HELD until the user approves it via `/hooks` when the trust gate is
      // armed). The marker is inert when the gate is OFF (byte-identical run).
      // `source` is informational; `needsReview` is the load-bearing field.
      source: "imported",
      needsReview: true,
    }
    const bucket = hooks[h.event] ?? []
    hooks[h.event] = bucket
    const serialized = JSON.stringify(group)
    if (!bucket.some((g) => JSON.stringify(g) === serialized)) bucket.push(group)
  }
  const next: Record<string, unknown> = { ...current, hooks }
  await writeJsonAtomic(path, next, sync)
  return { wrote: true, warnings: [] }
}

/** mcp → `<project>/.mcp.json#mcpServers`. Writes ONLY the modeled shape
 *  (command/args, OR a bare entry for non-stdio). `env`/credentials are NEVER
 *  written — the converter dropped them and we serialize a closed field set.
 *  MERGES: a server already present (by name) is NOT overwritten.
 *  Fail-CLOSED on a corrupt existing .mcp.json. CODE-EXEC guard: any entry
 *  (incoming OR pre-existing) whose command/args carry a shell metacharacter is
 *  DROPPED — never written into the executable config. */
const persistMcp = async (
  projectDir: string,
  value: readonly ConvertedMcpServer[],
  sync: ConfigWriteSync,
): Promise<WriteOutcome> => {
  const path = await resolveJsonDestinationOnce(join(projectDir, ".mcp.json"))
  if (await isSymlinkDestination(path)) return NO_WRITE(symlinkTargetWarning(path))
  const existing = await readExistingJson(path)
  if (existing.state === "corrupt") return NO_WRITE(corruptTargetWarning(path))
  const current = existing.state === "object" ? existing.value : {}
  const { servers, warnings } = mergeMcpServers(path, current, value)
  const next: Record<string, unknown> = { ...current, mcpServers: servers }
  await writeJsonAtomic(path, next, sync)
  return { wrote: true, warnings }
}

/** Build the merged `mcpServers` map: scrub + safety-check every pre-existing
 *  entry, then add each incoming entry (never clobbering an existing name).
 *  Any entry — pre-existing OR incoming — that fails the CODE-EXEC guard is
 *  DROPPED with a typed warning, never written into the executable config. */
const mergeMcpServers = (
  path: string,
  current: Record<string, unknown>,
  value: readonly ConvertedMcpServer[],
): { servers: Record<string, unknown>; warnings: MigrationWarning[] } => {
  const warnings: MigrationWarning[] = []
  const servers: Record<string, unknown> = {}
  // The mcp SOURCE probe is `<project>/.mcp.json` — the SAME path we write. So
  // the existing file may itself be the credential-bearing competitor file. We
  // SCRUB every pre-existing server entry to the modeled command/args shape
  // (dropping env / headers / any secret-bearing field) before merging — the
  // credential-drop is structural even when source == destination.
  const existingServers =
    typeof current.mcpServers === "object" && current.mcpServers !== null
      ? (current.mcpServers as Record<string, unknown>)
      : {}
  for (const [name, raw] of Object.entries(existingServers)) {
    const entry = scrubMcpEntry(raw)
    // A pre-existing entry must NOT be re-blessed if it carries an unsafe
    // command (a planted hostile entry round-tripping through the scrub merge).
    if (isSafeMcpEntry(entry)) {
      servers[name] = entry
    } else {
      warnings.push(
        writeWarning(path, `dropped unsafe pre-existing mcp server ${JSON.stringify(name)}`),
      )
    }
  }
  for (const s of value) {
    if (s.name in servers) continue // never clobber an existing (scrubbed) entry
    if (!isSafeMcpEntry(s)) {
      warnings.push(writeWarning(path, `dropped unsafe mcp server ${JSON.stringify(s.name)}`))
      continue
    }
    const entry: Record<string, unknown> = {}
    if (s.command !== undefined) entry.command = s.command
    if (s.args !== undefined) entry.args = [...s.args]
    // NOTE: deliberately NO env / headers / url-with-secrets — closed shape.
    servers[s.name] = entry
  }
  return { servers, warnings }
}

/** Reduce ANY mcp server entry (possibly carrying `env`/credentials) to the
 *  modeled closed shape — keep ONLY command/args. Drops env, headers, and any
 *  other field that could carry a secret. */
const scrubMcpEntry = (raw: unknown): { command?: string; args?: string[] } => {
  const entry: { command?: string; args?: string[] } = {}
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>
    if (typeof o.command === "string") entry.command = o.command
    if (Array.isArray(o.args)) entry.args = o.args.filter((a): a is string => typeof a === "string")
  }
  return entry
}

/** subagents → `<project>/.quanta/agents/<name>.md` (frontmatter). No-clobber:
 *  an existing spec yields a `.imported.md` sibling. */
const persistSubagents = async (
  projectDir: string,
  value: readonly ConvertedSubagent[],
): Promise<WriteOutcome> => {
  for (const spec of value) {
    const path = join(projectDir, ".quanta", "agents", `${safeStem(spec.name)}.md`)
    const doc = renderFrontmatterDoc(
      [
        ["name", spec.name],
        ...(spec.description !== undefined
          ? ([["description", spec.description]] as ReadonlyArray<readonly [string, string]>)
          : []),
        ["tools", spec.tools],
      ],
      spec.systemPrompt,
    )
    await writeNoClobber(path, doc)
  }
  return { wrote: value.length > 0, warnings: [] }
}

/** agents_md → `<project>/AGENTS.md` (quanta's native rule entrypoint). No-
 *  clobber: an existing AGENTS.md yields `AGENTS.imported.md`. */
const persistRepoRules = async (
  projectDir: string,
  value: ConvertedRepoRules,
): Promise<WriteOutcome> => {
  const path = join(projectDir, "AGENTS.md")
  const body = value.body.endsWith("\n") ? value.body : `${value.body}\n`
  await writeNoClobber(path, body)
  return { wrote: true, warnings: [] }
}

/** cursor_rules → `<project>/.quanta/rules/<name>.md` (frontmatter globs /
 *  alwaysApply). No-clobber per rule file. */
const persistGlobRules = async (
  projectDir: string,
  value: readonly ConvertedGlobRule[],
): Promise<WriteOutcome> => {
  let i = 0
  for (const rule of value) {
    i += 1
    const stem = safeStem(
      rule.sourcePath.slice(rule.sourcePath.lastIndexOf("/") + 1).replace(/\.(mdc|md)$/i, "") ||
        `rule-${i}`,
    )
    const path = join(projectDir, ".quanta", "rules", `${stem}.md`)
    const fields: Array<readonly [string, string | readonly string[]]> = []
    if (rule.description !== undefined) fields.push(["description", rule.description])
    if (rule.globs.length > 0) fields.push(["globs", rule.globs])
    if (rule.alwaysApply) fields.push(["alwaysApply", "true"])
    await writeNoClobber(path, renderFrontmatterDoc(fields, rule.body))
  }
  return { wrote: value.length > 0, warnings: [] }
}

// ─── skills → STAGED proposal (NEVER a live-dir write) ───────────────────
//
// RFC03-4 crux: an imported skill is UNTRUSTED. It does NOT land in the live
// skills directory here — it is STAGED through the injected `SkillStagePort`
// (which the host backs with the real `SkillProposalArtifactPort` + approval
// machine). Promotion into the live dir happens ONLY on an operator approve,
// via the artifact port's CAS `promote`. With NO stage port wired, an imported
// skill is written NOWHERE (fail-closed) — surfaced as a typed warning.

/** sha256 hex of `content` — the artifact hash the stage port binds the
 *  approval to (the host's CAS promote re-verifies it). */
const sha256Hex = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex")

/** skills → STAGED proposals via the injected `SkillStagePort`. Each imported
 *  skill's normalized bytes are `stage`d (staged artifact + approval bound to
 *  the hash); NO live-dir write. Absent stage port ⇒ fail-closed (nothing
 *  written, a typed warning per skill). */
const persistSkills = async (
  value: readonly ConvertedSkill[],
  stage: SkillStagePort | undefined,
): Promise<WriteOutcome> => {
  if (stage === undefined) {
    return {
      wrote: false,
      warnings: value.map((s) =>
        writeWarning(
          s.sourcePath,
          `no skill staging port wired — imported skill ${JSON.stringify(s.name)} not staged (fail-closed)`,
        ),
      ),
    }
  }
  let stagedAny = false
  for (const s of value) {
    const artifactHash = sha256Hex(s.skillMd)
    await stage.stage({
      artifactHash,
      bytes: s.skillMd,
      name: s.name,
      // The live target the CAS promote would write to (on approve) — the
      // canonical `<name>/SKILL.md` under the skills dir jail root.
      targetPath: `${s.name}/SKILL.md`,
      kind: "new",
    })
    stagedAny = true
  }
  return { wrote: stagedAny, warnings: [] }
}

// ─── memory → raw_memories.md APPEND (never MEMORY.md, never clobber) ─────
//
// An imported `~/.claude/CLAUDE.md` (memory form) is APPENDED to the existing
// `<homeDir>/.quanta/memory/raw_memories.md` evidence trail — never written to
// `MEMORY.md` (which must pass consolidation). The append is guarded against
// double-import: a provenance MARKER keyed by the source path means re-running
// the import does not append the same source twice.

/** A provenance marker line so a re-import does not double-append the same
 *  source. Kept on ONE line (no source content) for a cheap idempotency probe. */
const memoryMarker = (sourcePath: string): string =>
  `<!-- quanta-imported-memory: ${sourcePath} -->`

/** memory → APPEND to `<homeDir>/.quanta/memory/raw_memories.md`. Preserves any
 *  prior content (append, never overwrite). NEVER touches `MEMORY.md`.
 *  Idempotent: a source already appended (its provenance marker is present) is
 *  skipped. */
const persistMemory = async (homeDir: string, value: ConvertedMemory): Promise<WriteOutcome> => {
  const rawPath = join(homeDir, ".quanta", "memory", "raw_memories.md")
  const marker = memoryMarker(value.sourcePath)
  let existing = ""
  try {
    existing = await readFile(rawPath, "utf8")
  } catch {
    existing = "" // absent ⇒ fresh file (append still creates it).
  }
  // Double-append guard — the SAME source is not appended twice.
  if (existing.includes(marker)) return { wrote: false, warnings: [] }
  await mkdir(dirname(rawPath), { recursive: true })
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
  const block = `${sep}${marker}\n${value.body}\n`
  // Append-only: write existing + block (never clobber prior evidence).
  await writeFile(rawPath, existing + block, "utf8")
  return { wrote: true, warnings: [] }
}

/** Persist ONE ok item to its destination. Returns whether it wrote + any
 *  non-fatal warnings (corrupt-target refusal, dropped unsafe entry). Throws
 *  only on a real fs failure (caught by the per-item loop). */
const persistOne = async (
  item: Extract<ConvertedItem, { ok: true }>,
  projectDir: string,
  homeDir: string,
  sync: ConfigWriteSync,
  skillStage: SkillStagePort | undefined,
): Promise<WriteOutcome> => {
  switch (item.type) {
    case "settings":
      return persistSettings(projectDir, item.value, sync)
    case "hooks":
      return persistHooks(projectDir, item.value, sync)
    case "mcp":
      return persistMcp(projectDir, item.value, sync)
    case "subagents":
      return persistSubagents(projectDir, item.value)
    case "agents_md":
      return persistRepoRules(projectDir, item.value)
    case "cursor_rules":
      return persistGlobRules(projectDir, item.value)
    case "skills":
      return persistSkills(item.value, skillStage)
    case "memory":
      return persistMemory(homeDir, item.value)
  }
}

/** Best-effort destination label for a warning when a write fails. */
const destLabel = (projectDir: string, type: MigrationItemType): string => {
  switch (type) {
    case "settings":
    case "hooks":
      return join(projectDir, "settings.json")
    case "mcp":
      return join(projectDir, ".mcp.json")
    case "subagents":
      return join(projectDir, ".quanta", "agents")
    case "agents_md":
      return join(projectDir, "AGENTS.md")
    case "cursor_rules":
      return join(projectDir, ".quanta", "rules")
    case "skills":
      // Skills are STAGED, not written to a project path — label the staging
      // sink (the diagnostic warning path is best-effort).
      return join(projectDir, ".claude", "skills")
    case "memory":
      return "raw_memories.md"
  }
}

/**
 * Persist ONE converted item, turning any throw into a typed warning.
 *
 * A unit because the module's NEVER-throws contract is exactly this boundary:
 * one item's failure must become a warning attributed to that item's
 * destination, not an abort that silently loses every item after it. The
 * `code` preference on the caught error keeps `EACCES`-style diagnostics
 * legible instead of a stringified stack.
 */
const persistItemGuarded = async (
  item: Extract<ConvertedItem, { ok: true }>,
  input: PersistConvertedInput,
  sync: ConfigWriteSync,
): Promise<WriteOutcome> => {
  try {
    return await persistOne(item, input.projectDir, input.homeDir, sync, input.skillStage)
  } catch (err) {
    const detail = (err as { code?: string }).code ?? errMessage(err)
    return {
      wrote: false,
      warnings: [writeWarning(destLabel(input.projectDir, item.type), detail)],
    }
  }
}

/**
 * Persist converted competitor config into quanta's live config locations.
 * Default-OFF (`enabled:false`) ⇒ byte-identical no-op. Throttled when the
 * `sourceKey` is already recorded. NEVER throws — a single item's failure is a
 * typed warning. On any successful write, records `imported` for `sourceKey`.
 */
export const persistConvertedItems = async (
  input: PersistConvertedInput,
): Promise<PersistConvertedResult> => {
  if (!input.enabled) return EMPTY_RESULT

  // Throttle: a source already imported/offered/declined is a no-op so a 2nd
  // run cannot re-clobber the user's (possibly hand-edited) imported config.
  if (input.sourceKey !== undefined && input.sourceKey !== "") {
    const ledger = await loadMigrationLedger(input.homeDir)
    if (isThrottled(ledger, input.sourceKey)) {
      return { persisted: false, throttled: true, warnings: [], writtenTypes: [] }
    }
  }

  const sync = input.writeSync ?? defaultConfigWriteSync
  const warnings: MigrationWarning[] = []
  const writtenTypes: MigrationItemType[] = []
  for (const item of input.converted) {
    if (!item.ok) continue
    const outcome = await persistItemGuarded(item, input, sync)
    warnings.push(...outcome.warnings)
    if (outcome.wrote) writtenTypes.push(item.type)
  }

  const persisted = writtenTypes.length > 0
  // Record `imported` so the NEXT run is throttled. Best-effort: a busy lock
  // just means one extra (idempotent) persist later — never a crash.
  if (persisted && input.sourceKey !== undefined && input.sourceKey !== "") {
    const types = [...new Set(writtenTypes)]
    await recordDisposition(input.homeDir, input.sourceKey, "imported", types).catch(() => false)
  }

  return { persisted, throttled: false, warnings, writtenTypes }
}
