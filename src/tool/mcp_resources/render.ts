/** N3 — PURE rendering + failure-mapping helpers for the MCP resource/prompt
 *  tools. Lives in the tool slice (no `@/mcp`); the analogue of
 *  `mcp_tasks/list_tasks.ts`'s result-string assembly.
 *
 *  Resource/prompt CONTENT is third-party, adversary-controllable DATA. These
 *  helpers NEVER inline base64 blobs (token blowout) and cap rendered text so a
 *  hostile/large resource cannot blow up the transcript or memory. The output
 *  string is later wrapped by the H2/ADR-0471 `<untrusted-source>` envelope at
 *  the dispatch seam because the tool is registered through the `mcp`-origin
 *  array — these helpers do not (and must not) re-implement that. */

import { errMessage } from "@/shared/errors"
import { FsJailError, resolveJailed } from "@/storage"
import type { ImageWritePort } from "../image-gen/store"
import type { ToolFailure } from "../types"
import type {
  HandleResult,
  PromptEntry,
  PromptMessage,
  PromptResult,
  ResourceBlock,
  ResourceEntry,
  ResourcesFailureReason,
  ResourceTemplateEntry,
} from "./port"

/** Per-blob decoded-byte cap (8 MB) — the SAME ceiling `image_gen` uses
 *  (`IMAGE_GEN_MAX_BYTES`). Bounds a hostile/buggy MCP server from dropping an
 *  unbounded artifact into the workspace via a single `resources/read`. */
export const BLOB_MAX_BYTES = 8 * 1024 * 1024

/** Defensive cap on the rendered tool output. A hostile server can return
 *  megabytes of text; we cap the assembled string the same way the tasks tool
 *  caps its listing (`list_tasks.ts:14`). Not a magic threshold invented here —
 *  the same 50k value the sibling tool already uses. */
export const MAX_OUTPUT = 50_000

export const truncate = (s: string): string =>
  s.length <= MAX_OUTPUT ? s : `${s.slice(0, MAX_OUTPUT)}\n… (truncated)`

/** Map a typed `HandleResult` failure onto a model-visible string + a typed
 *  `ToolFailure`. `unsupported` ⇒ the server never advertised the capability
 *  (honest, cheap); the rest are operational failures the loop survives.
 *
 *  The `message` field is host-adapter-supplied (today a bounded template), but
 *  a `transport` failure can carry an upstream `errMessage(err)` that a hostile
 *  server can make arbitrarily long. We cap it here so the failure-output path
 *  has the SAME bound as the success-content path (`renderResourceContent` etc.)
 *  — a server cannot blow up the transcript through a giant error string. */
export const mapFailure = (
  reason: ResourcesFailureReason,
  message: string,
): { output: string; failure: ToolFailure } => {
  const detail = truncate(message)
  switch (reason) {
    case "unsupported":
      return {
        output: `unsupported: the connected MCP server does not advertise this capability`,
        failure: { mode: "rejected", reason: "unsupported" },
      }
    case "too-large":
      return {
        output: `too-large: the server returned content exceeding the size cap (${detail})`,
        failure: { mode: "rejected", reason: "too-large" },
      }
    case "malformed":
      return {
        output: `malformed: the server returned an unparseable response (${detail})`,
        failure: { mode: "error", modelVisibleError: "malformed-mcp-response" },
      }
    case "transport":
      return {
        output: `transport: the MCP request failed (${detail})`,
        failure: { mode: "error", modelVisibleError: "mcp-transport-error" },
      }
  }
}

/** narrow a `HandleResult` failure branch to the rendered pair. */
export const renderFailure = <T>(
  r: Extract<HandleResult<T>, { ok: false }>,
): { output: string; failure: ToolFailure } => mapFailure(r.reason, r.message)

/** NO-THROW boundary (Tool contract §2). The `ResourcesHandle` port is
 *  documented NO-THROW (every method returns a typed `HandleResult`), but a
 *  misbehaving host adapter that THROWS instead of returning a typed failure
 *  must NOT reject the tool's async iterator (which would hang/corrupt the
 *  dispatch loop). We run the port call here and collapse any thrown rejection
 *  to a typed `transport` failure (`mode:"error"` — a system fault, not the
 *  model's), exactly as if the port had returned `{ok:false, reason:"transport"}`. */
export const callPort = async <T>(
  produce: () => Promise<HandleResult<T>>,
): Promise<HandleResult<T>> => {
  try {
    return await produce()
  } catch (e) {
    // Canonical `errMessage` over an open-coded `instanceof Error` ladder: it
    // additionally survives a hostile object whose `.toString` / `@@toPrimitive`
    // THROWS (a NO-THROW boundary must not re-throw while building its own error
    // string). Identical output for the Error / string cases the port can raise.
    return { ok: false, reason: "transport", message: errMessage(e) }
  }
}

// --- resources -------------------------------------------------------------

export const renderResourceList = (entries: ReadonlyArray<ResourceEntry>): string => {
  if (entries.length === 0) return "(no resources)"
  const lines = entries.map((e) => {
    const name = e.name !== undefined ? ` — ${e.name}` : ""
    const mime = e.mimeType !== undefined ? ` (${e.mimeType})` : ""
    const desc = e.description !== undefined ? `: ${e.description}` : ""
    return `  - ${e.uri}${name}${mime}${desc}`
  })
  return truncate(
    [`${entries.length} resource${entries.length === 1 ? "" : "s"}:`, ...lines].join("\n"),
  )
}

/** PURE — keep only the DIRECT children of `dirUri` from a flat resource list.
 *
 *  MCP has no `resources/read-dir` RPC; a directory is modeled as a `resources/
 *  list` prefix (Claude tags subdirs with mimeType `inode/directory`). A "direct
 *  child" is an entry whose uri (a) is strictly under `dirUri` and (b) has no
 *  further `/`-separated segment beyond the first. The dir entry itself and any
 *  grandchild are excluded. A trailing slash on either side is normalized so
 *  `file:///a/` and `file:///a` behave the same. Duplicated in `@/mcp/resources`
 *  (`directResourceChildren`) so the source client can compose the same shape
 *  without `@/tool`→`@/mcp` — any drift is caught by the aggregation hellgate. */
export const filterDirectChildren = (
  entries: ReadonlyArray<ResourceEntry>,
  dirUri: string,
): ResourceEntry[] => {
  const base = dirUri.endsWith("/") ? dirUri : `${dirUri}/`
  return entries.filter((e) => {
    if (e.uri === dirUri || e.uri === base) return false
    if (!e.uri.startsWith(base)) return false
    const rest = e.uri.slice(base.length).replace(/\/+$/, "")
    return rest.length > 0 && !rest.includes("/")
  })
}

/** Render the direct-children listing of a directory-shaped resource uri. Near-
 *  identical to {@link renderResourceList} but tags the PARENT uri in the header
 *  and always surfaces each child's mimeType (so a `inode/directory` subdir is
 *  visibly a directory the model can recurse into). Capped by `MAX_OUTPUT`. */
export const renderResourceDirList = (
  parentUri: string,
  entries: ReadonlyArray<ResourceEntry>,
): string => {
  if (entries.length === 0) return `${parentUri}\n(no direct children)`
  const lines = entries.map((e) => {
    const name = e.name !== undefined ? ` — ${e.name}` : ""
    const mime = e.mimeType !== undefined ? ` (${e.mimeType})` : ""
    const desc = e.description !== undefined ? `: ${e.description}` : ""
    return `  - ${e.uri}${name}${mime}${desc}`
  })
  return truncate(
    [
      `${entries.length} direct child${entries.length === 1 ? "" : "ren"} of ${parentUri}:`,
      ...lines,
    ].join("\n"),
  )
}

/** Render `resources/templates/list` — each entry keys on a `uriTemplate` (RFC
 *  6570) the model fills in before `mcp_read_resource`. Same shape + cap as
 *  {@link renderResourceList}. */
export const renderResourceTemplateList = (
  entries: ReadonlyArray<ResourceTemplateEntry>,
): string => {
  if (entries.length === 0) return "(no resource templates)"
  const lines = entries.map((e) => {
    const name = e.name !== undefined ? ` — ${e.name}` : ""
    const mime = e.mimeType !== undefined ? ` (${e.mimeType})` : ""
    const desc = e.description !== undefined ? `: ${e.description}` : ""
    return `  - ${e.uriTemplate}${name}${mime}${desc}`
  })
  return truncate(
    [`${entries.length} resource template${entries.length === 1 ? "" : "s"}:`, ...lines].join("\n"),
  )
}

/** Render `resources/read` content blocks. Text blocks are concatenated with a
 *  source header; BLOB blocks are NEVER inlined (a placeholder is emitted so the
 *  model knows binary content exists without flooding the transcript with
 *  base64). Output is capped. */
export const renderResourceContent = (
  uri: string,
  blocks: ReadonlyArray<ResourceBlock>,
): string => {
  if (blocks.length === 0) return `# ${uri}\n(empty resource — no content blocks)`
  const parts: string[] = []
  for (const b of blocks) {
    const mime = b.mimeType !== undefined ? ` (${b.mimeType})` : ""
    if (typeof b.text === "string") {
      parts.push(`# ${b.uri}${mime}\n${b.text}`)
    } else if (typeof b.blob === "string") {
      parts.push(`[binary block ${b.uri}${mime}, ${b.blob.length} base64 chars — not inlined]`)
    } else {
      parts.push(`[empty block ${b.uri}${mime} — no text or blob]`)
    }
  }
  return truncate(parts.join("\n\n"))
}

/** Derive the REQUESTED (pre-jail) relative destination for a blob uri, confined
 *  to an `mcp-blobs/` prefix so third-party bytes never mingle with the model's
 *  own files.
 *
 *  HELLAUDIT (R1): `resolveJailed` alone is NOT sufficient containment. A uri
 *  like `mcp://s/../package.json` yields `mcp-blobs/../package.json`, which
 *  resolves to `<cwd>/package.json` — INSIDE the jail but OUTSIDE `mcp-blobs/`.
 *  An adversarial server would then clobber a real workspace file with
 *  attacker-chosen bytes. So we REFUSE (not silently relocate) any derived path
 *  whose normalized segments contain a `..` traversal or an absolute anchor;
 *  blobs are hard-confined to `mcp-blobs/`. The jail is the SECOND line of
 *  defense (escapes above `cwd`), this is the first (escapes above `mcp-blobs/`). */
const blobRelPath = (uri: string): { ok: true; rel: string } | { ok: false; reason: string } => {
  // strip a scheme + authority (`file:///a/b` → `/a/b`, `mcp://s/x` → `/x`);
  // keep the path so a server's own layout is mirrored under the prefix.
  const noScheme = uri.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
  const slash = noScheme.indexOf("/")
  const rawPath = slash >= 0 ? noScheme.slice(slash + 1) : noScheme
  const cleaned = rawPath.length > 0 ? rawPath : "blob.bin"
  // Split on BOTH separators (a Windows-style `..\` must not sneak past a
  // forward-slash-only check), drop empties/`.`, and refuse any `..` segment.
  const segments = cleaned.split(/[/\\]+/).filter((s) => s.length > 0 && s !== ".")
  if (segments.length === 0) return { ok: true, rel: "mcp-blobs/blob.bin" }
  if (segments.some((s) => s === "..")) {
    return { ok: false, reason: "'..' traversal in resource uri is not allowed for blob save" }
  }
  return { ok: true, rel: `mcp-blobs/${segments.join("/")}` }
}

/** Render `resources/read` content blocks, SAVING blob blocks to disk.
 *
 *  Text blocks render inline (capped, header-tagged) exactly as
 *  {@link renderResourceContent}. A `.blob` block is base64-decoded to bytes,
 *  size-capped, and written through the injected {@link ImageWritePort} at a
 *  path resolved by the SAME `@/storage#resolveJailed` chokepoint `read`/`write`/
 *  `image_gen` use (confined to `cwd`). The base64 is NEVER inlined; instead the
 *  model sees `blobSavedTo:<jailed-path>` (or a typed refusal on jail escape /
 *  decode failure / oversize). NO-THROW: every failure becomes a line, not an
 *  iterator rejection.
 *
 *  This is why the read tool is NOT `isReadOnly()` — a blob read WRITES a file. */
export const renderResourceContentSavingBlobs = async (
  uri: string,
  blocks: ReadonlyArray<ResourceBlock>,
  cwd: string,
  writePort: ImageWritePort,
): Promise<string> => {
  if (blocks.length === 0) return `# ${uri}\n(empty resource — no content blocks)`
  const parts: string[] = []
  for (const b of blocks) {
    const mime = b.mimeType !== undefined ? ` (${b.mimeType})` : ""
    if (typeof b.text === "string") {
      parts.push(`# ${b.uri}${mime}\n${b.text}`)
    } else if (typeof b.blob === "string") {
      parts.push(await saveBlob(b, mime))
    } else {
      parts.push(`[empty block ${b.uri}${mime} — no text or blob]`)
    }
  }
  return truncate(parts.join("\n\n"))

  async function saveBlob(b: ResourceBlock, mime: string): Promise<string> {
    let bytes: Buffer
    try {
      bytes = Buffer.from(b.blob as string, "base64")
    } catch (e) {
      return `[binary block ${b.uri}${mime} — base64 decode failed: ${errMessage(e)}]`
    }
    if (bytes.length === 0) {
      return `[binary block ${b.uri}${mime} — empty after base64 decode, not written]`
    }
    if (bytes.length > BLOB_MAX_BYTES) {
      return `[binary block ${b.uri}${mime} — ${bytes.length} bytes exceeds ${BLOB_MAX_BYTES} cap, not written]`
    }
    const derived = blobRelPath(b.uri)
    if (!derived.ok) {
      return `[binary block ${b.uri}${mime} — refused: ${derived.reason}]`
    }
    let jailed: string
    try {
      // NUL screening (mirrors image_gen loadReference) — a NUL makes the write
      // syscall throw below; refuse with a typed line instead.
      if (derived.rel.includes("\0")) {
        throw new FsJailError("mcp blob: NUL byte in resource uri path is not allowed")
      }
      jailed = resolveJailed(derived.rel, cwd) as string
    } catch (e) {
      if (e instanceof FsJailError) {
        return `[binary block ${b.uri}${mime} — jail escape refused: ${e.message}]`
      }
      return `[binary block ${b.uri}${mime} — path resolve failed: ${errMessage(e)}]`
    }
    // HELLAUDIT (R2): the bytes are ATTACKER-controlled, so NEVER overwrite an
    // existing file (a hostile server could clobber a prior blob or a user file
    // placed under mcp-blobs/). Refuse on collision — the model can rename + retry.
    // Mirrors image_gen's non-overwrite discipline (there: versioned siblings;
    // here: hard refusal, since we do not want to spray N attacker copies).
    let exists: boolean
    try {
      exists = await writePort.exists(jailed)
    } catch (e) {
      return `[binary block ${b.uri}${mime} — existence probe failed: ${errMessage(e)}]`
    }
    if (exists) {
      return `[binary block ${b.uri}${mime} — target ${jailed} already exists; refusing to overwrite untrusted blob]`
    }
    try {
      await writePort.writeBytes(jailed, new Uint8Array(bytes))
    } catch (e) {
      return `[binary block ${b.uri}${mime} — write failed: ${errMessage(e)}]`
    }
    return `# ${b.uri}${mime}\nblobSavedTo:${jailed} (${bytes.length} bytes)`
  }
}

// --- prompts ---------------------------------------------------------------

export const renderPromptList = (entries: ReadonlyArray<PromptEntry>): string => {
  if (entries.length === 0) return "(no prompts)"
  const lines = entries.map((e) => {
    const desc = e.description !== undefined ? `: ${e.description}` : ""
    const args =
      e.arguments !== undefined && e.arguments.length > 0
        ? `\n      args: ${e.arguments
            .map((a) => `${a.name}${a.required === true ? "*" : ""}`)
            .join(", ")}`
        : ""
    return `  - ${e.name}${desc}${args}`
  })
  return truncate(
    [`${entries.length} prompt${entries.length === 1 ? "" : "s"}:`, ...lines].join("\n"),
  )
}

/** Render one prompt message. Text content (string, or a `{type:"text",text}`
 *  block) is rendered inline; any other content shape (image / resource union —
 *  `content` is `unknown` by spec) gets a typed placeholder, NOT a parse attempt
 *  (the codec owner is the source slice). NEVER throws. */
const renderMessageContent = (content: unknown): string => {
  if (typeof content === "string") return content
  if (typeof content === "object" && content !== null && !Array.isArray(content)) {
    const rec = content as Record<string, unknown>
    if (rec.type === "text" && typeof rec.text === "string") return rec.text
    const kind = typeof rec.type === "string" ? rec.type : "unknown"
    return `[non-text content block (${kind}) — not rendered]`
  }
  return `[non-text content — not rendered]`
}

export const renderPromptResult = (name: string, result: PromptResult): string => {
  const header =
    result.description !== undefined ? `# ${name} — ${result.description}` : `# ${name}`
  const lines = (result.messages as ReadonlyArray<PromptMessage>).map(
    (m) => `${m.role}: ${renderMessageContent(m.content)}`,
  )
  if (lines.length === 0) return truncate(`${header}\n(no messages)`)
  return truncate([header, ...lines].join("\n"))
}
