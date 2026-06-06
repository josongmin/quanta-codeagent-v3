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

import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { errMessage } from "@/shared"
import { isThrottled, loadMigrationLedger, recordDisposition } from "./ledger"
import type {
  ConvertedGlobRule,
  ConvertedHook,
  ConvertedItem,
  ConvertedMcpServer,
  ConvertedRepoRules,
  ConvertedSettings,
  ConvertedSubagent,
  MigrationItemType,
  MigrationWarning,
} from "./types"

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

/** Write `content` to `path`, but NEVER silently overwrite: if `path` already
 *  exists, write a `<stem>.imported<ext>` SIBLING instead. Returns the path
 *  actually written. Parent dirs are created. */
const writeNoClobber = async (path: string, content: string): Promise<string> => {
  const target = (await pathExists(path)) ? siblingImportedPath(path) : path
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
): Promise<WriteOutcome> => {
  const path = join(projectDir, "settings.json")
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
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8")
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
): Promise<WriteOutcome> => {
  const path = join(projectDir, "settings.json")
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
    }
    const bucket = hooks[h.event] ?? []
    hooks[h.event] = bucket
    const serialized = JSON.stringify(group)
    if (!bucket.some((g) => JSON.stringify(g) === serialized)) bucket.push(group)
  }
  const next: Record<string, unknown> = { ...current, hooks }
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8")
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
): Promise<WriteOutcome> => {
  const path = join(projectDir, ".mcp.json")
  const existing = await readExistingJson(path)
  if (existing.state === "corrupt") return NO_WRITE(corruptTargetWarning(path))
  const current = existing.state === "object" ? existing.value : {}
  const { servers, warnings } = mergeMcpServers(path, current, value)
  const next: Record<string, unknown> = { ...current, mcpServers: servers }
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8")
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

/** Persist ONE ok item to its destination. Returns whether it wrote + any
 *  non-fatal warnings (corrupt-target refusal, dropped unsafe entry). Throws
 *  only on a real fs failure (caught by the per-item loop). */
const persistOne = async (
  item: Extract<ConvertedItem, { ok: true }>,
  projectDir: string,
): Promise<WriteOutcome> => {
  switch (item.type) {
    case "settings":
      return persistSettings(projectDir, item.value)
    case "hooks":
      return persistHooks(projectDir, item.value)
    case "mcp":
      return persistMcp(projectDir, item.value)
    case "subagents":
      return persistSubagents(projectDir, item.value)
    case "agents_md":
      return persistRepoRules(projectDir, item.value)
    case "cursor_rules":
      return persistGlobRules(projectDir, item.value)
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

  const warnings: MigrationWarning[] = []
  const writtenTypes: MigrationItemType[] = []
  for (const item of input.converted) {
    if (!item.ok) continue
    try {
      const outcome = await persistOne(item, input.projectDir)
      warnings.push(...outcome.warnings)
      if (outcome.wrote) writtenTypes.push(item.type)
    } catch (err) {
      const detail = (err as { code?: string }).code ?? errMessage(err)
      warnings.push(writeWarning(destLabel(input.projectDir, item.type), detail))
    }
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
