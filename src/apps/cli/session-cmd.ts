/**
 * `/session export <id>` + `/session import <path>` slash command (ADR-0294).
 *
 * Exposes the existing pure import/export primitive (ADR-0157,
 * `src/session/import-export.ts` + `src/session/import-export-fs.ts`) at the
 * CLI surface so a user can round-trip a session off-host:
 *
 *   /session export <id> [--out=<path>]   — read session from host store,
 *                                            wrap in v1 envelope, write JSON.
 *   /session import <path> [--id=<id>]    — read JSON envelope, persist into
 *                                            host store under a fresh (or
 *                                            user-supplied) id.
 *   /session                              — usage.
 *   /session help                         — usage.
 *
 * Default-OFF (RFC §1.2): when `ctx.sessionIo` is absent (one-shot surfaces,
 * REPL pre-store-construction, future Tauri shell without an adapter wired)
 * the command prints "not wired in this surface" + exits 0. Byte-identical
 * to NOT registering the command. No allocation, no IO on the absent path.
 *
 * Path safety: `--out` and `<path>` MUST resolve under cwd OR `os.homedir()`.
 * `is-path-inside` is already a dependency (used by `src/storage/fs-jail-lib`)
 * so we reuse it here.
 *
 * Import size cap: 50 MB. Larger ⇒ typed error + exit 1.
 *
 * No-throw on slash run: ALL FS / SessionImportError failures land as typed
 * messages on `ctx.err` + exit 1, never re-thrown. The slash dispatcher does
 * not need to know slash-internal failure shapes.
 *
 * Plane-clean: imports `@/session/import-export`, `@/session/import-export-fs`,
 * `@/session/types`, `node:fs/promises`, `node:path`, `node:os`, and the
 * existing `is-path-inside` dep. NO `@/storage`, NO `@/permission`, NO
 * `@/agent`. The host's session store is abstracted via the `ctx.sessionIo`
 * adapter so this file does not need to know storage internals.
 */

import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, resolve as resolvePath } from "node:path"
import isPathInside from "is-path-inside"
import { importSessionFromJson, SessionImportError } from "@/session/import-export"
import { exportSessionToFile } from "@/session/import-export-fs"
import type { SavedSession } from "@/session/types"
import type { SlashCommand, SlashContext } from "./slash-commands"

/* ------------------------------------------------------------------ */
/* surface contract — `ctx.sessionIo` slot                             */
/* ------------------------------------------------------------------ */

/** Host-provided adapter abstracting the workspace session store. Surface
 *  owns the wire (REPL / future Tauri shell); this slash never imports
 *  `@/storage` directly. */
export interface SessionIoState {
  /** Read a session by id; resolves to `null` when the id is unknown. */
  readonly readSession: (id: string) => Promise<SavedSession | null>
  /** Persist a session under `id`. Overwrites any existing entry. */
  readonly writeSession: (id: string, session: SavedSession) => Promise<void>
  /** Mint a fresh opaque id (caller chooses the alphabet — typically the
   *  same minter the host's `createSession` uses). */
  readonly mintNewId: () => string
  /** Clock seam — `Date.now` by default (used for the default filename). */
  readonly now?: () => number
}

declare module "./slash-commands" {
  interface SlashContext {
    /** ADR-0294 `/session` export/import adapter. Absent ⇒ slash prints
     *  "not wired in this surface" + exit 0. */
    readonly sessionIo?: SessionIoState | undefined
  }
}

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

/** 50 MB import-file cap. Anything larger is almost certainly NOT a session
 *  envelope (the largest production session in the corpus is ~141 MB but
 *  that is an outlier; the P99 is 52 MB and P90 is 10 MB — 50 MB sits
 *  between those, accommodating typical large sessions while still catching
 *  obvious mistakes early). The cap is enforced BEFORE the file is read
 *  into memory so a 4 GB JSON cannot OOM the process. */
const IMPORT_SIZE_CAP_BYTES = 50 * 1024 * 1024

/** Quanta version string emitted into the envelope `exporterMeta`. The
 *  pure primitive (`exportSession`) demands one; the slash hard-codes a
 *  placeholder rather than parsing package.json (slice-fence — no `node:fs`
 *  read of repo metadata from a surface command). Future wire to a richer
 *  `runtimeConfig().quantaVersion` is a one-line edit. */
const QUANTA_VERSION = "0"

/* ------------------------------------------------------------------ */
/* path safety                                                         */
/* ------------------------------------------------------------------ */

/** Resolve `p` to an absolute path under `ctx.cwd`. */
const absUnderCwd = (ctx: SlashContext, p: string): string =>
  isAbsolute(p) ? resolvePath(p) : resolvePath(ctx.cwd, p)

/** True iff `abs` resolves under cwd OR `os.homedir()`. Equality with the
 *  root itself counts as inside (`is-path-inside` returns false on
 *  equality, so we accept both). */
const isUnderCwdOrHome = (abs: string, cwd: string): boolean => {
  const home = homedir()
  if (abs === cwd || abs === home) return true
  return isPathInside(abs, cwd) || isPathInside(abs, home)
}

/* ------------------------------------------------------------------ */
/* argv parsing                                                        */
/* ------------------------------------------------------------------ */

interface ParsedFlags {
  readonly positional: readonly string[]
  readonly out?: string
  readonly id?: string
}

/** Parse `--out=...` and `--id=...` flags. Unknown `--foo` flags throw. */
const parseFlags = (args: readonly string[]): ParsedFlags => {
  const positional: string[] = []
  let out: string | undefined
  let id: string | undefined
  for (const a of args) {
    if (a.startsWith("--out=")) {
      out = a.slice("--out=".length)
      continue
    }
    if (a.startsWith("--id=")) {
      id = a.slice("--id=".length)
      continue
    }
    if (a.startsWith("--")) {
      throw new Error(`/session: unknown flag: ${a}`)
    }
    positional.push(a)
  }
  const base: { positional: string[]; out?: string; id?: string } = { positional }
  if (out !== undefined) base.out = out
  if (id !== undefined) base.id = id
  return base
}

/* ------------------------------------------------------------------ */
/* usage                                                                */
/* ------------------------------------------------------------------ */

const USAGE_LINES: readonly string[] = [
  "usage: /session <subcommand>",
  "  /session export <id> [--out=<path>]   — write session envelope to JSON",
  "  /session import <path> [--id=<id>]    — read envelope and persist a new session",
  "  /session help                         — show this help",
] as const

const printUsage = (ctx: SlashContext): void => {
  for (const line of USAGE_LINES) ctx.out(`${line}\n`)
}

/* ------------------------------------------------------------------ */
/* export subcommand                                                   */
/* ------------------------------------------------------------------ */

/** Build the default filename when `--out` is absent.
 *  Shape: `quanta-session-<id>-<ts>.json` under cwd. */
const defaultOutPath = (ctx: SlashContext, id: string, now: number): string =>
  resolvePath(ctx.cwd, `quanta-session-${id}-${now}.json`)

const runExport = async (
  flags: ParsedFlags,
  ctx: SlashContext,
  sio: SessionIoState,
): Promise<number> => {
  const id = flags.positional[0]
  if (id === undefined) {
    ctx.err("/session export: missing <id>\n")
    return 1
  }
  if (flags.positional.length > 1) {
    ctx.err("/session export: too many positional arguments\n")
    return 1
  }
  const now = sio.now?.() ?? Date.now()
  const outPath =
    flags.out !== undefined ? absUnderCwd(ctx, flags.out) : defaultOutPath(ctx, id, now)
  if (!isUnderCwdOrHome(outPath, ctx.cwd)) {
    ctx.err("/session: refusing to write outside cwd or $HOME\n")
    return 1
  }
  let session: SavedSession | null
  try {
    session = await sio.readSession(id)
  } catch (e) {
    ctx.err(`/session export: read failed: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
  if (session === null) {
    ctx.err(`/session export: session not found: ${id}\n`)
    return 1
  }
  try {
    await exportSessionToFile(session, { quantaVersion: QUANTA_VERSION, now: () => now }, outPath)
  } catch (e) {
    ctx.err(`/session export: write failed: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
  // Re-stat to report bytes written. Stat failure is non-fatal — surface a
  // best-effort message without the byte count.
  let bytes: number | undefined
  try {
    const st = await stat(outPath)
    bytes = st.size
  } catch {
    bytes = undefined
  }
  ctx.out(bytes !== undefined ? `wrote ${outPath} (${bytes} bytes)\n` : `wrote ${outPath}\n`)
  return 0
}

/* ------------------------------------------------------------------ */
/* import subcommand                                                   */
/* ------------------------------------------------------------------ */

/** Stat the import file and gate on size. Returns `{ ok: true, size }` or
 *  `{ ok: false, code: 1 }` after the typed error has been surfaced. */
const checkImportFile = async (
  ctx: SlashContext,
  path: string,
): Promise<{ ok: true; size: number } | { ok: false }> => {
  let st: { size: number }
  try {
    st = await stat(path)
  } catch (e) {
    ctx.err(`/session import: ${e instanceof Error ? e.message : String(e)}\n`)
    return { ok: false }
  }
  if (st.size > IMPORT_SIZE_CAP_BYTES) {
    const mb = (st.size / 1024 / 1024).toFixed(2)
    ctx.err(`/session import: session file too large (cap 50 MB; got ${mb} MB)\n`)
    return { ok: false }
  }
  return { ok: true, size: st.size }
}

/** Count keys on the v1 envelope sidecar block (used for the human-readable
 *  summary line). v1 sidecar shape is a flat `{ conversationCheckpoint?,
 *  budgetLedger?, planQueue? }` so we report present keys joined by `,`. */
const sidecarKeys = (sidecar: Readonly<Record<string, unknown>> | undefined): string => {
  if (sidecar === undefined) return ""
  return Object.keys(sidecar).join(",")
}

/** Read + parse the envelope. Returns the import result OR a typed error
 *  with the message already surfaced to `ctx.err`. Extracted from
 *  `runImport` to keep that function under biome's cog-complexity cap. */
const readAndParseEnvelope = async (
  ctx: SlashContext,
  absPath: string,
): Promise<{ ok: true; result: ReturnType<typeof importSessionFromJson> } | { ok: false }> => {
  let text: string
  try {
    text = await Bun.file(absPath).text()
  } catch (e) {
    ctx.err(`/session import: ${e instanceof Error ? e.message : String(e)}\n`)
    return { ok: false }
  }
  try {
    const result = importSessionFromJson(text, { quantaVersion: QUANTA_VERSION })
    return { ok: true, result }
  } catch (e) {
    if (e instanceof SessionImportError) {
      ctx.err(`/session import: ${e.code}: ${e.message}\n`)
    } else {
      ctx.err(`/session import: ${e instanceof Error ? e.message : String(e)}\n`)
    }
    return { ok: false }
  }
}

const runImport = async (
  flags: ParsedFlags,
  ctx: SlashContext,
  sio: SessionIoState,
): Promise<number> => {
  const path = flags.positional[0]
  if (path === undefined) {
    ctx.err("/session import: missing <path>\n")
    return 1
  }
  if (flags.positional.length > 1) {
    ctx.err("/session import: too many positional arguments\n")
    return 1
  }
  const absPath = absUnderCwd(ctx, path)
  if (!isUnderCwdOrHome(absPath, ctx.cwd)) {
    ctx.err("/session: refusing to read outside cwd or $HOME\n")
    return 1
  }
  const check = await checkImportFile(ctx, absPath)
  if (!check.ok) return 1

  const parsed = await readAndParseEnvelope(ctx, absPath)
  if (!parsed.ok) return 1
  const { result } = parsed

  const newId = flags.id ?? sio.mintNewId()
  // Rewrite the in-envelope session id so the persisted file's `meta.id`
  // matches the store key under which we're writing it. Without this, the
  // store's index and the SavedSession.meta.id would drift.
  const rewritten: SavedSession = {
    ...result.session,
    meta: { ...result.session.meta, id: newId },
  }
  try {
    await sio.writeSession(newId, rewritten)
  } catch (e) {
    ctx.err(`/session import: write failed: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }

  const n = result.session.messages.length
  const sk = sidecarKeys(result.sidecar)
  ctx.out(`imported into session ${newId} (${n} messages, sidecar=${sk})\n`)
  return 0
}

/* ------------------------------------------------------------------ */
/* command entry                                                       */
/* ------------------------------------------------------------------ */

export const sessionCmd: SlashCommand = {
  name: "/session",
  describe: "Round-trip a session off-host (subcommands: export <id>, import <path>)",
  category: "session",
  async run(args, ctx) {
    if (ctx.sessionIo === undefined) {
      ctx.out("/session: not wired in this surface\n")
      return 0
    }
    if (args.length === 0) {
      printUsage(ctx)
      return 0
    }
    const sub = args[0] as string
    if (sub === "help") {
      printUsage(ctx)
      return 0
    }
    const rest = args.slice(1)
    let flags: ParsedFlags
    try {
      flags = parseFlags(rest)
    } catch (e) {
      ctx.err(`${(e as Error).message}\n`)
      return 1
    }
    if (sub === "export") return runExport(flags, ctx, ctx.sessionIo)
    if (sub === "import") return runImport(flags, ctx, ctx.sessionIo)
    ctx.err(`/session: unknown subcommand: ${sub} (use 'export', 'import', or 'help')\n`)
    return 1
  },
}

// Re-export helpers for tests.
export { IMPORT_SIZE_CAP_BYTES as __IMPORT_SIZE_CAP_BYTES, QUANTA_VERSION as __QUANTA_VERSION }
