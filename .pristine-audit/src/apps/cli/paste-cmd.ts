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
import { imageBlockFromBytes } from "./image-loader"
import type { ImageQueue } from "./image-queue"
import type { SlashCommand } from "./slash-commands"
import type { TextInbox } from "./text-inbox"
/* ------------------------------------------------------------------ */
/* clipboard reader port                                                */
/* ------------------------------------------------------------------ */

/** Result of one clipboard probe. Closed discriminated union — extend by
 *  adding a 4th `kind` AND every exhaustive consumer must update. */
export type ClipboardContent =
  | { readonly kind: "text"; readonly text: string }
  // #18 — an image now carries the DECODED bytes + media type (was a bare count),
  // so `/paste` can attach it to the next turn via the image queue instead of
  // only counting and refusing.
  | { readonly kind: "image"; readonly bytes: Buffer; readonly mediaType: string }
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
    /** #18 — single-shot image queue (the SAME instance `/image add` mutates and
     *  the next-turn `PromptSource.next()` drains). When wired, a clipboard IMAGE
     *  paste enqueues here; absent ⇒ `/paste` degrades to the "save to disk +
     *  /image add" hint (byte-identical to the pre-#18 image branch). */
    readonly imageQueue?: ImageQueue | undefined
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

/** #18 — binary variant of {@link runOnce}: captures stdout as a raw {@link
 *  Buffer} (image bytes corrupt under `toString("utf8")`). stderr stays a string
 *  (diagnostic text). Same no-throw + timeout contract. */
interface BinarySpawnResult {
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: string
  readonly spawnError: string | null
}

const runOnceBinary = (cmd: string, args: readonly string[]): Promise<BinarySpawnResult> =>
  new Promise<BinarySpawnResult>((resolve) => {
    const chunks: Buffer[] = []
    let stderr = ""
    let spawnError: string | null = null
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      resolve({ code, stdout: Buffer.concat(chunks), stderr, spawnError })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
    } catch (e) {
      spawnError = errMessage(e)
      finish(127)
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
      chunks.push(b)
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
/* image decoding                                                       */
/* ------------------------------------------------------------------ */

/** #18 — PNG signature (first 8 bytes). Used to reject non-image bytes a
 *  clipboard tool might emit when no real image is present. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const looksLikePng = (buf: Buffer): boolean =>
  buf.length >= PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)

/** #18 — parse the hex blob `osascript -e 'the clipboard as «class PNGf»'` prints
 *  for a clipboard image: `«data PNGf89504E47…»`. Returns the decoded {@link
 *  Buffer} (verified to start with the PNG signature), or `null` when the output
 *  is not a parseable PNGf data literal. Pure (no IO) so it is unit-testable
 *  without a GUI clipboard. */
export const parseOsascriptPngfHex = (stdout: string): Buffer | null => {
  const m = stdout.match(/«data PNGf([0-9A-Fa-f]+)»/)
  const hex = m?.[1]
  if (hex === undefined || hex.length === 0 || hex.length % 2 !== 0) return null
  let buf: Buffer
  try {
    buf = Buffer.from(hex, "hex")
  } catch {
    return null
  }
  return looksLikePng(buf) ? buf : null
}

/** #18 — a binary clipboard tool (`runOnceBinary` in prod; a fake in tests). */
export type BinarySpawn = (cmd: string, args: readonly string[]) => Promise<BinarySpawnResult>

/** #18 — run ONE binary image probe and classify the result. Returns an `image`
 *  ClipboardContent ONLY when the command succeeded (`code 0`, no spawn error)
 *  AND the captured stdout is a real PNG (magic-checked, so a tool that prints an
 *  error/usage banner to stdout can never masquerade as an image); otherwise
 *  `null` ⇒ the caller falls through to the next probe / the text path. Pure
 *  w.r.t. its injected `spawn`, so the Linux/Windows image branch is
 *  deterministically testable without a real clipboard tool. */
export const tryImageProbe = async (
  spawn: BinarySpawn,
  cmd: string,
  args: readonly string[],
): Promise<{
  readonly kind: "image"
  readonly bytes: Buffer
  readonly mediaType: string
} | null> => {
  const r = await spawn(cmd, args)
  if (r.spawnError === null && r.code === 0 && looksLikePng(r.stdout)) {
    return { kind: "image", bytes: r.stdout, mediaType: "image/png" }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* platform readers                                                     */
/* ------------------------------------------------------------------ */

/** macOS: probe for a clipboard IMAGE first (Cmd+Shift+4 etc.) and DECODE it to
 *  bytes via the hex literal `osascript` prints, so `/paste` can attach it to the
 *  next turn. `osascript` exits non-zero with "clipboard does not contain «class
 *  PNGf»" when the clipboard isn't an image — that's our signal to fall through
 *  to `pbpaste` text. `pbpaste` is part of base macOS; never missing on a real
 *  Mac. (#18 — no extra binary dependency: the PNGf hex is parsed in-process.) */
const readDarwin = async (): Promise<ClipboardContent> => {
  const imgProbe = await runOnce("osascript", ["-e", "the clipboard as «class PNGf»"])
  if (imgProbe.code === 0 && imgProbe.stdout.length > 0) {
    const bytes = parseOsascriptPngfHex(imgProbe.stdout)
    // Parsed a real PNG ⇒ deliver the bytes. Couldn't parse (unexpected format)
    // ⇒ fall through to the text path rather than refuse outright.
    if (bytes !== null) return { kind: "image", bytes, mediaType: "image/png" }
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
  // #18 — probe for a clipboard IMAGE first (PNG), binary-capturing stdout.
  // Wayland `wl-paste --type image/png`, then X11 `xclip -t image/png -o`. A tool
  // that's absent (spawnError) or has no image (non-zero / empty / non-PNG bytes)
  // falls through to the text path. Verified only by the PNG magic so a tool that
  // echoes an error onto stdout can't masquerade as an image.
  const wlImg = await tryImageProbe(runOnceBinary, "wl-paste", [
    "--type",
    "image/png",
    "--no-newline",
  ])
  if (wlImg !== null) return wlImg
  const xcImg = await tryImageProbe(runOnceBinary, "xclip", [
    "-selection",
    "clipboard",
    "-t",
    "image/png",
    "-o",
  ])
  if (xcImg !== null) return xcImg
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

/** #18 — PowerShell one-liner that writes the clipboard image to stdout as raw
 *  PNG bytes. `Get-Clipboard -Format Image` yields a `System.Drawing.Bitmap`;
 *  we save it to a `MemoryStream` as PNG and write the bytes to the raw stdout
 *  handle (NOT the text pipeline, which would CRLF-mangle binary). Emits nothing
 *  (empty stdout) when the clipboard holds no image ⇒ the probe falls through to
 *  the text path. Exported so the win32 e2e can assert the exact command. */
export const WINDOWS_CLIPBOARD_IMAGE_PS1 =
  "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;" +
  "$img=[System.Windows.Forms.Clipboard]::GetImage();" +
  "if($img){$ms=New-Object System.IO.MemoryStream;" +
  "$img.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png);" +
  "$bytes=$ms.ToArray();" +
  "$out=[System.Console]::OpenStandardOutput();$out.Write($bytes,0,$bytes.Length);$out.Flush()}"

const readWindows = async (): Promise<ClipboardContent> => {
  // #18 — probe for a clipboard IMAGE first, binary-capturing the raw PNG bytes
  // the PowerShell snippet writes to stdout. Magic-checked, so a non-image / a
  // powershell error printed to stdout can't masquerade. Absent / no image ⇒
  // falls through to the text `Get-Clipboard` path.
  const img = await tryImageProbe(runOnceBinary, "powershell.exe", [
    "-NoProfile",
    "-STA",
    "-Command",
    WINDOWS_CLIPBOARD_IMAGE_PS1,
  ])
  if (img !== null) return img
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

/** #18 — deliver a clipboard IMAGE to the next turn via the image queue (the
 *  SAME queue `/image add` feeds). Absent queue ⇒ degrade to the pre-#18 "save
 *  to disk + /image add" hint (byte-identical default). Extracted from
 *  `pasteCmd.run` so the dispatcher stays under biome's cognitive-complexity
 *  ceiling. */
const deliverClipboardImage = (args: {
  readonly bytes: Buffer
  readonly mediaType: string
  readonly queue: ImageQueue | undefined
  readonly out: (s: string) => void
  readonly err: (s: string) => void
}): number => {
  if (args.queue === undefined) {
    args.err(
      `/paste: clipboard contains an image (${args.bytes.length} bytes), but the image queue is not wired in this surface. Save it to disk then use \`/image add <path>\`.\n`,
    )
    return 1
  }
  let block: ReturnType<typeof imageBlockFromBytes>
  try {
    block = imageBlockFromBytes(args.bytes, args.mediaType)
  } catch (e) {
    args.err(`/paste: ${errMessage(e)}\n`)
    return 1
  }
  const res = args.queue.add({ path: "clipboard", block })
  if (res.kind === "over_cap") {
    args.err(`/paste: image queue full (cap=${res.cap}); use \`/image clear\` to free slots\n`)
    return 1
  }
  args.out(
    `/paste: queued clipboard image (${args.bytes.length} bytes, ${args.queue.size()} in image queue)\n`,
  )
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
      return deliverClipboardImage({
        bytes: content.bytes,
        mediaType: content.mediaType,
        queue: ctx.imageQueue,
        out: ctx.out,
        err: ctx.err,
      })
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
  runOnceBinary,
  readDarwin,
  readLinux,
  readWindows,
  probePath,
  deliver,
  truncateLabel,
  defaultFs,
  parseOsascriptPngfHex,
  looksLikePng,
  tryImageProbe,
  WINDOWS_CLIPBOARD_IMAGE_PS1,
}
