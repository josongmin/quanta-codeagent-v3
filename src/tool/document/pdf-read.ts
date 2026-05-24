/**
 * `pdf_read` tool (ADR-0137, Part 2) — read a PDF file from disk and surface
 * it via `ToolResult.documents` as an Anthropic NATIVE document block (base64
 * + `application/pdf`). NO client-side text extraction lib: Claude reads the
 * PDF natively (vision + text + forms + scanned pages).
 *
 * Slice posture (RFC §3.1; mirrors `image/read.ts`):
 *   - Imports ONLY: `zod`, `node:path`, `node:fs/promises`, `Bun.file`,
 *     `@/llm` (for `DocumentBlock`), `../types`. NO `@/agent`, `@/permission`,
 *     `@/storage`.
 *   - No-throw: every failure mode yields a typed `ok:false` `ToolResult`.
 *   - exactOptionalPropertyTypes-clean: `documents` is added on the OK result
 *     only; ok:false results never carry the field (the composer treats
 *     absent === empty).
 *
 * Security:
 *   - Leaf-symlink reject (`lstat().isSymbolicLink()`) — prevents the model
 *     from indirecting through a symlink into a forbidden path.
 *   - 32 MB cap (Anthropic Messages API document-block ceiling).
 *   - MIME from MAGIC BYTES (`%PDF-` = 0x25 0x50 0x44 0x46 0x2D), NOT
 *     extension — a `.pdf` that's actually plaintext is rejected as
 *     "not a PDF (magic-byte mismatch)". Magic-byte SSOT mirror of
 *     ADR-0126 `read_image`'s sniffer.
 */

import { lstat } from "node:fs/promises"
import { z } from "zod"
import type { DocumentBlock } from "@/llm"
import { FsJailError } from "@/storage"
import { resolveJailedDoc } from "../_shared/resolve-jailed-doc"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"

export const readPdfInputSchema = z.object({
  path: z.string().min(1).describe("Repo-relative or absolute path to the PDF file"),
})
export type ReadPdfInput = z.infer<typeof readPdfInputSchema>

/** Anthropic Messages API document-block media type. Today only PDFs are
 *  natively supported via this channel. A future widening (e.g. `text/plain`)
 *  expands `SUPPORTED_DOCUMENT_MEDIA_TYPES` AND adds a sniffer here. */
export const PDF_MEDIA_TYPE = "application/pdf" as const
export type SupportedDocumentMediaType = typeof PDF_MEDIA_TYPE

/** Anthropic document-block raw-byte cap (32 MB). We reject above this at the
 *  tool boundary so the provider never returns a 400 for an over-cap upload. */
export const MAX_PDF_BYTES = 32 * 1024 * 1024

/** Magic-byte sniff for PDFs. The standard PDF header is `%PDF-` (5 bytes:
 *  0x25 0x50 0x44 0x46 0x2D). Returns true IFF the first 5 bytes match.
 *
 *  PDF spec allows up to 1024 bytes of leading whitespace / junk before the
 *  header for "header-tolerant" readers, but the agent surface is strict:
 *  if the header isn't byte-0, the file isn't a clean PDF and we'd rather
 *  reject than feed a corrupted upload to the provider. */
export const sniffPdfMagic = (bytes: Uint8Array): boolean =>
  bytes.length >= 5 &&
  bytes[0] === 0x25 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x44 &&
  bytes[3] === 0x46 &&
  bytes[4] === 0x2d

const errResult = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

/** Pre-flight (schema parse + abort + path resolve via unified FS jail).
 *  Path safety is delegated to {@link resolveJailedDoc} (Slice S7) — see
 *  `src/tool/_shared/resolve-jailed-doc.ts` for rationale. The catch-and-
 *  translate preserves the historical "path outside cwd: …" message + typed
 *  `permission_denied` failure so existing hellgate tests stay green. */
const preflight = (
  input: ReadPdfInput,
  ctx: ToolContext,
): { kind: "fail"; result: ToolResult } | { kind: "ok"; abs: string; visiblePath: string } => {
  const parsed = readPdfInputSchema.safeParse(input)
  if (!parsed.success) {
    return { kind: "fail", result: errResult(`invalid input: ${parsed.error.message}`) }
  }
  if (ctx.signal.aborted) {
    return { kind: "fail", result: errResult("aborted before start") }
  }
  let abs: string
  try {
    abs = resolveJailedDoc(ctx.cwd, parsed.data.path, "pdf")
  } catch (e) {
    if (e instanceof FsJailError) {
      return {
        kind: "fail",
        result: errResult(`path outside cwd: ${parsed.data.path}`, {
          mode: "permission_denied",
          path: parsed.data.path,
          isReadonly: true,
        }),
      }
    }
    throw e
  }
  return { kind: "ok", abs, visiblePath: parsed.data.path }
}

const statPhase = async (
  abs: string,
  visiblePath: string,
): Promise<{ kind: "fail"; result: ToolResult } | { kind: "ok" }> => {
  try {
    const stat = await lstat(abs)
    if (stat.isSymbolicLink()) {
      return {
        kind: "fail",
        result: errResult(`symlink not allowed: ${visiblePath}`, {
          mode: "permission_denied",
          path: visiblePath,
          isReadonly: true,
        }),
      }
    }
    if (!stat.isFile()) {
      return {
        kind: "fail",
        result: errResult(`not a regular file: ${visiblePath}`, {
          mode: "not_found",
          path: visiblePath,
        }),
      }
    }
    if (stat.size > MAX_PDF_BYTES) {
      return {
        kind: "fail",
        result: errResult(`PDF too large: ${stat.size} bytes (cap ${MAX_PDF_BYTES})`, {
          mode: "error",
          modelVisibleError: "pdf_over_cap",
        }),
      }
    }
    return { kind: "ok" }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const isEnoent =
      typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT"
    return {
      kind: "fail",
      result: errResult(
        isEnoent ? `File not found: ${visiblePath}` : `lstat failed: ${msg}`,
        isEnoent
          ? { mode: "not_found", path: visiblePath }
          : { mode: "error", modelVisibleError: msg },
      ),
    }
  }
}

const decodePhase = async (
  abs: string,
  visiblePath: string,
): Promise<{ kind: "fail"; result: ToolResult } | { kind: "ok"; bytes: Uint8Array }> => {
  let bytes: Uint8Array
  try {
    bytes = await Bun.file(abs).bytes()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      kind: "fail",
      result: errResult(`read failed: ${msg}`, { mode: "error", modelVisibleError: msg }),
    }
  }
  if (!sniffPdfMagic(bytes)) {
    return {
      kind: "fail",
      result: errResult(`not a PDF (magic-byte mismatch): ${visiblePath}`, {
        mode: "error",
        modelVisibleError: "pdf_magic_mismatch",
      }),
    }
  }
  return { kind: "ok", bytes }
}

export const pdfReadTool: Tool<ReadPdfInput> = {
  name: "pdf_read",
  description:
    "Read a PDF file and attach it to the model's view via the next tool_result " +
    "as a native Anthropic document block (no client-side text extraction). " +
    "Up to 32 MB; magic-byte enforced (%PDF-).",
  inputSchema: readPdfInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: ReadPdfInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const pre = preflight(input, ctx)
    if (pre.kind === "fail") {
      yield { type: "result", result: pre.result }
      return
    }
    const statOut = await statPhase(pre.abs, pre.visiblePath)
    if (statOut.kind === "fail") {
      yield { type: "result", result: statOut.result }
      return
    }
    const decoded = await decodePhase(pre.abs, pre.visiblePath)
    if (decoded.kind === "fail") {
      yield { type: "result", result: decoded.result }
      return
    }
    const data = Buffer.from(decoded.bytes).toString("base64")
    const document: DocumentBlock = { type: "document", data, mediaType: PDF_MEDIA_TYPE }
    yield {
      type: "result",
      result: {
        ok: true,
        output: `Read PDF: ${pre.visiblePath} (${decoded.bytes.length} bytes, ${data.length} base64 chars)`,
        documents: [document],
      },
    }
  },
}
