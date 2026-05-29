/**
 * `/paste` (ADR-0224 — Aider `/paste` absorption).
 *
 * Reads the system clipboard via the platform's native clipboard tool and
 * attaches the result to the next user turn through the SURFACE's text
 * inbox.
 *
 * Backend matrix (auto-detected by platform):
 *   - macOS (`darwin`): `osascript -e 'the clipboard as «class PNGf»' ⇒
 *     image bytes (rejected; advise `/image add <path>` instead). On
 *     "the clipboard does not contain «class PNGf»" we fall back to
 *     `pbpaste` for text. (Aider also tries text on image-failure.)
 *   - Linux Wayland: `wl-paste` (requires `wl-clipboard` pkg).
 *   - Linux X11: `xclip -selection clipboard -o` (requires `xclip` pkg).
 *
 * Text-path-as-attachment: when the clipboard text looks like an absolute
 * file path that EXISTS and is a regular file, the body is the file's
 * contents (capped at 1 MB to match `web_fetch`'s default), labeled with
 * the path. Aider docs: "/paste — Paste image/text from the clipboard into
 * the chat. Optionally provide a name for the image."
 *
 * Slice posture (RFC §3.1):
 *   - Lives in `apps/cli`. Imports `node:fs/promises`, `node:os`,
 *     `node:child_process` + the local `./text-inbox`.
 *   - exactOptionalPropertyTypes-clean: every optional ctx field is gated
 *     before spread.
 *   - No-throw on the public surface: spawn errors, missing backends,
 *     oversize payloads all return typed exit codes with a stderr line.
 *
 * Test seam: `ctx.clipboardReader` injects a fake `() => Promise<...>`
 * shape so tests never touch `osascript` / `xclip`. Default reader
 * dispatches by `process.platform`.
 */

import { spawn } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { platform } from "node:process"
import { errMessage } from "@/shared"
import type { SlashCommand } from "./slash-commands"
import type { TextInbox } from "./text-inbox"
/* ------------------------------------------------------------------ */
/* clipboard reader port                                                */
/* ------------------------------------------------------------------ */

/** Result of one clipboard probe. Closed discriminated union — extend by
 *  adding a 4th `kind` AND every exhaustive consumer must update. */
export type ClipboardContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly bytes: number }
  | { readonly kind: "empty" }
  | { readonly kind: "no_backend"; readonly hint: string }
  | { readonly kind: "error"; readonly message: string }

export type ClipboardReader = () => Promise<ClipboardContent>

/* ------------------------------------------------------------------ */
/* SlashContext extension                                              */
/* ------------------------------------------------------------------ */

declare module "./slash-commands" {
  interface SlashContext {
    /** Injection seam for tests + future surfaces (Web/Tauri brings its
     *  own clipboard API). Absent ⇒ the default reader dispatches by
     *  `process.platform`. */
    readonly clipboardReader?: ClipboardReader | undefined
    /** Optional fs.readFile + fs.stat injection — the path-attachment
     *  branch becomes pure-of-IO when wired. */
    readonly clipboardFs?:
      | {
          readFile: (path: string) => Promise<string>
          stat: (path: string) => Promise<{ isFile: boolean; size: number }>
        }
      | undefined
  }
}

/* ------------------------------------------------------------------ */
/* spawn helper (no-throw)                                              */
/* ------------------------------------------------------------------ */

interface SpawnResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly spawnError: string | null
}

const SPAWN_TIMEOUT_MS = 5_000

/** No-throw spawn wrapper. Returns a fully-populated result even when
 *  the binary doesn't exist (`spawnError !== null` + `code 127`). */
const runOnce = (cmd: string, args: readonly string[]): Promise<SpawnResult> =>
  new Promise<SpawnResult>((resolve) => {
    let stdout = ""
    let stderr = ""
    let spawnError: string | null = null
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      resolve({ code, stdout, stderr, spawnError })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
    } catch (e) {
      finish(127)
      spawnError = errMessage(e)
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
      finish(124)
    }, SPAWN_TIMEOUT_MS)
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8")
    })
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8")
    })
    child.on("error", (e) => {
      spawnError = e.message
      clearTimeout(timer)
      finish(127)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      finish(code ?? 1)
    })
  })

/* ------------------------------------------------------------------ */
/* platform readers                                                     */
/* ------------------------------------------------------------------ */

/** macOS: try `pbpaste` for text. Image detection via osascript is noisy
 *  and the user rarely wants binary image bytes in chat — we surface the
 *  "use /image add <path>" hint and let the user save the image to disk
 *  first. `pbpaste` is part of base macOS; never missing on a real Mac. */
const readDarwin = async (): Promise<ClipboardContent> => {
  // Probe for image first so we can give a typed hint when an image was
  // copied (e.g. Cmd+Shift+4). `osascript` exits non-zero with
  // "clipboard does not contain «class PNGf»" when the clipboard isn't
  // an image — that's our signal to fall through to text.
  const imgProbe = await runOnce("osascript", ["-e", "the clipboard as «class PNGf»"])
  if (imgProbe.code === 0 && imgProbe.stdout.length > 0) {
    return { kind: "image", bytes: imgProbe.stdout.length }
  }
  const text = await runOnce("pbpaste", [])
  if (text.spawnError !== null) {
    return { kind: "no_backend", hint: `pbpaste failed: ${text.spawnError}` }
  }
  if (text.code !== 0) {
    return { kind: "error", message: text.stderr.trim() || `pbpaste exit ${text.code}` }
  }
  if (text.stdout.length === 0) return { kind: "empty" }
  return { kind: "text", text: text.stdout }
}

const readLinux = async (): Promise<ClipboardContent> => {
  // Try Wayland first (modern desktops); fall back to X11.
  const wl = await runOnce("wl-paste", ["--no-newline"])
  if (wl.spawnError === null && wl.code === 0) {
    if (wl.stdout.length === 0) return { kind: "empty" }
    return { kind: "text", text: wl.stdout }
  }
  const xc = await runOnce("xclip", ["-selection", "clipboard", "-o"])
  if (xc.spawnError === null && xc.code === 0) {
    if (xc.stdout.length === 0) return { kind: "empty" }
    return { kind: "text", text: xc.stdout }
  }
  return {
    kind: "no_backend",
    hint: "install `wl-clipboard` (wayland) or `xclip` (x11) and retry",
  }
}

const readWindows = async (): Promise<ClipboardContent> => {
  // `powershell Get-Clipboard` is best-effort; we treat absence as "not
  // wired" since Windows isn't a Phase 1 platform.
  const ps = await runOnce("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard"])
  if (ps.spawnError !== null) {
    return { kind: "no_backend", hint: "powershell.exe not found (Windows CLI required)" }
  }
  if (ps.code !== 0) {
    return { kind: "error", message: ps.stderr.trim() || `powershell exit ${ps.code}` }
  }
  // PowerShell tacks a trailing CRLF on every read; strip exactly one.
  const text = ps.stdout.replace(/\r?\n$/, "")
  if (text.length === 0) return { kind: "empty" }
  return { kind: "text", text }
}

export const defaultClipboardReader: ClipboardReader = async () => {
  if (platform === "darwin") return readDarwin()
  if (platform === "linux") return readLinux()
  if (platform === "win32") return readWindows()
  return {
    kind: "no_backend",
    hint: `unsupported platform: ${platform}`,
  }
}

/* ------------------------------------------------------------------ */
/* path detection + file read                                          */
/* ------------------------------------------------------------------ */

/** Cap on the file body when the clipboard text resolves to a path. Mirrors
 *  `web_fetch`'s 1 MB default — both are "out-of-band attach the next
 *  turn" and the model context budget is the same. */
export const PASTE_FILE_MAX_BYTES = 1_000_000

interface ResolvedFile {
  readonly path: string
  readonly body: string
  readonly bytes: number
  readonly truncated: boolean
}

/** Probe the clipboard text as an absolute file path. Returns:
 *   - `null` ⇒ not a path (or path doesn't exist); caller treats as plain text.
 *   - `{ kind: "ok", … }` ⇒ resolved + read.
 *   - `{ kind: "error", message }` ⇒ path looked like a file but read failed
 *     (permission, IO, oversize before-read); caller surfaces the message.
 *
 *  Only ABSOLUTE paths are considered — a single word like `README.md`
 *  could be either a relative path or a literal "this is the text I copied"
 *  string; we don't speculate. */
const probePath = async (
  raw: string,
  fs: {
    readFile: (path: string) => Promise<string>
    stat: (path: string) => Promise<{ isFile: boolean; size: number }>
  },
): Promise<{ kind: "ok"; file: ResolvedFile } | { kind: "error"; message: string } | null> => {
  const text = raw.trim()
  if (text.length === 0) return null
  // Reject multi-line — a path is one line.
  if (text.includes("\n")) return null
  if (!isAbsolute(text)) return null
  let st: { isFile: boolean; size: number }
  try {
    st = await fs.stat(text)
  } catch {
    return null
  }
  if (!st.isFile) return null
  // Refuse oversize BEFORE reading so we don't OOM on a 4GB log.
  if (st.size > PASTE_FILE_MAX_BYTES) {
    return {
      kind: "error",
      message: `file too large: ${st.size} bytes (cap ${PASTE_FILE_MAX_BYTES})`,
    }
  }
  try {
    const body = await fs.readFile(text)
    return {
      kind: "ok",
      file: { path: text, body, bytes: st.size, truncated: false },
    }
  } catch (e) {
    const m = errMessage(e)
    return { kind: "error", message: `read failed: ${m}` }
  }
}

const defaultFs = {
  readFile: (path: string) => readFile(path, "utf8"),
  stat: async (path: string) => {
    const s = await stat(path)
    return { isFile: s.isFile(), size: s.size }
  },
}

/* ------------------------------------------------------------------ */
/* delivery                                                            */
/* ------------------------------------------------------------------ */

const MAX_LABEL_LEN = 100

const truncateLabel = (s: string): string =>
  s.length <= MAX_LABEL_LEN ? s : `${s.slice(0, MAX_LABEL_LEN - 3)}...`

const deliver = (args: {
  readonly inbox: TextInbox | undefined
  readonly label: string
  readonly body: string
  readonly out: (s: string) => void
  readonly err: (s: string) => void
}): number => {
  if (args.inbox === undefined) {
    args.out(`${args.body}\n`)
    args.out(`/paste: ok (${args.body.length} chars; inbox not wired — printed inline)\n`)
    return 0
  }
  const res = args.inbox.add({
    kind: "paste",
    label: truncateLabel(args.label),
    text: args.body,
  })
  if (res.kind === "over_cap") {
    args.err(`/paste: inbox full (cap=${res.cap}); use /paste/web sparingly or restart REPL\n`)
    return 1
  }
  args.out(`/paste: queued (${args.body.length} chars, ${args.inbox.size()} in inbox)\n`)
  return 0
}

/* ------------------------------------------------------------------ */
/* command                                                              */
/* ------------------------------------------------------------------ */

export const pasteCmd: SlashCommand = {
  name: "/paste",
  describe: "Paste clipboard text (or file from clipboard path) to next turn",
  category: "session",
  async run(args, ctx) {
    if (args.length > 0) {
      ctx.err(`/paste: takes no arguments; got ${args.length}\n`)
      return 1
    }
    const reader = ctx.clipboardReader ?? defaultClipboardReader
    const content = await reader()
    if (content.kind === "no_backend") {
      ctx.err(`/paste: ${content.hint}\n`)
      return 1
    }
    if (content.kind === "error") {
      ctx.err(`/paste: clipboard read failed: ${content.message}\n`)
      return 1
    }
    if (content.kind === "empty") {
      ctx.err("/paste: clipboard is empty\n")
      return 1
    }
    if (content.kind === "image") {
      ctx.err(
        `/paste: clipboard contains an image (${content.bytes} bytes). Save it to disk then use \`/image add <path>\`.\n`,
      )
      return 1
    }
    // text-kind
    const fs = ctx.clipboardFs ?? defaultFs
    const path = await probePath(content.text, fs)
    if (path !== null && path.kind === "error") {
      ctx.err(`/paste: ${path.message}\n`)
      return 1
    }
    if (path !== null && path.kind === "ok") {
      return deliver({
        inbox: ctx.textInbox,
        label: path.file.path,
        body: path.file.body,
        out: ctx.out,
        err: ctx.err,
      })
    }
    return deliver({
      inbox: ctx.textInbox,
      label: "clipboard",
      body: content.text,
      out: ctx.out,
      err: ctx.err,
    })
  },
}

/** Test-only re-exports. */
export const __test = {
  runOnce,
  readDarwin,
  readLinux,
  readWindows,
  probePath,
  deliver,
  truncateLabel,
  defaultFs,
}
