/**
 * Agentless (Xia 2024) Stage-1 file-level localization — the LLM-driven
 * version of the previously regex-only `extractFiles`.
 *
 * What this is
 * ============
 * The Agentless paper's Stage 1 ("file-level localization") prompts an LLM
 * with the issue text + the repository file tree and asks for a ranked list
 * of files most likely to contain the bug. We implement that prompt + a
 * strict line-pair parser, and let the caller (bench driver) decide whether
 * to use it (env-gated, default-OFF).
 *
 * What this is NOT
 * ================
 * - NOT Stage 2 (function/line-level localization). That stage requires
 *   chunking each candidate file and a second LLM round; out of scope here.
 * - NOT a heuristic. The prompt format is verbatim from the paper; the
 *   parser only accepts `FILE: <path>` / `REASON: <text>` pairs and rejects
 *   any path that does not appear in the supplied file tree (hallucination
 *   guard).
 *
 * Slice posture
 * =============
 *   - no I/O of its own (the `fileTree` enumerator is a dep — caller decides
 *     how the tree is gathered: `bash ls`, `node:fs` walk, git ls-tree, …)
 *   - timeout / fallback live OUTSIDE this module — the bench seam handles
 *     them so this stays purely "prompt + parse + dedup"
 *   - the LLM port is the existing `LLMPort` (streaming); we collect the
 *     entire response into a single string and parse it
 *   - on any failure (zero files in tree, empty LLM text, no FILE: lines)
 *     we return `{ files:[], rationales:[], rawResponse:"…" }` — the
 *     caller sees an empty array and falls back to whatever it likes
 */

import type { LLMPort, Message, StreamEvent } from "@/llm"

/** Dependency surface for `agentlessLocalize`. All I/O is injectable so the
 *  function is hermetic in tests. */
export interface AgentlessLocalizeDeps {
  /** Existing LLM port — same shape as the bench driver uses. */
  readonly llm: LLMPort
  /** Build the file tree as a newline-separated list of relative paths
   *  (relative to repo root). Caller controls how it's enumerated (`bash ls`
   *  vs walking `node:fs` vs custom). Pure function for test injectability. */
  readonly fileTree: () => Promise<string[]>
  /** Optional cap on file tree size (number of paths). Default 3000.
   *  Anything beyond this is truncated (head of the list kept). */
  readonly maxFiles?: number
  /** Optional cap on LLM input characters allocated to the file tree section
   *  (defensive vs. very long paths in a 3000-file tree). Default ~12K. */
  readonly maxTreeChars?: number
  /** How many files to ask the LLM to rank. Default 5. */
  readonly topK?: number
}

export interface AgentlessLocalizeResult {
  /** Ranked files (most likely first). May be empty when extraction failed
   *  or the LLM returned an unparseable reply. */
  readonly files: readonly string[]
  /** Per-file rationale from the LLM. `rationales[i]` corresponds to
   *  `files[i]`. Same length as `files`. */
  readonly rationales: readonly string[]
  /** Raw LLM response (or empty string on stream failure). Exposed for
   *  debugging only — callers MUST NOT inject this into agent prompts. */
  readonly rawResponse: string
  /** F1 (observe-only) — file-tree build telemetry so the caller can emit a
   *  `localize` trace WITHOUT re-running (and risking drift from) the
   *  truncation logic in `renderFileTree`. Absent on the early-return failure
   *  paths that never built a tree (empty statement / bad opts / fileTree
   *  threw / empty tree). Pure data; never fed into any prompt. */
  readonly tree?: {
    /** Total paths the enumerator returned BEFORE any cap. */
    readonly fileCount: number
    /** Whether a maxFiles / maxTreeChars cap dropped any entry. */
    readonly truncated: boolean
    /** Chars the rendered tree consumed (present only when truncated). */
    readonly truncatedChars?: number
  }
}

const DEFAULT_MAX_FILES = 3000
const DEFAULT_MAX_TREE_CHARS = 12_000
const DEFAULT_TOP_K = 5

/** System message — Agentless paper §3.1. Calm, single-shot reasoning; no
 *  multi-turn exploration. We forbid path invention so a hallucinated path
 *  doesn't make it past the parser even if the post-filter were skipped. */
const SYSTEM_MSG = [
  "You are a senior software engineer doing precise file-level fault localization.",
  "Given an issue report and a list of files in a repository, identify which",
  "files are most likely to contain the bug.",
  "",
  "Rules:",
  "- Reason calmly and decide in a single response.",
  "- Output ONLY file paths that appear VERBATIM in the supplied file tree.",
  "- Never invent paths or guess directories that are not in the tree.",
  "- If the issue is ambiguous, return FEWER files rather than padding with",
  "  low-confidence guesses.",
].join("\n")

/** Build the user message — explicit, paper-faithful format. The `EXACTLY
 *  this format` block is what the parser anchors on; do not edit lightly. */
export const buildAgentlessPrompt = (
  problemStatement: string,
  fileTreeText: string,
  topK: number,
): string =>
  [
    "# Issue",
    problemStatement,
    "",
    "# Repository file tree",
    fileTreeText,
    "",
    "# Task",
    `List the top ${topK} files most likely to contain the bug. For each file`,
    "output one line in EXACTLY this format:",
    "",
    "FILE: <path>",
    "REASON: <one sentence>",
    "",
    "Only output file paths that appear in the tree above (verbatim). Do not",
    `invent paths. If unsure, list fewer files (under ${topK}).`,
  ].join("\n")

/** Forbid prototype-pollution keys regardless of how they appear in the LLM
 *  reply or the file tree (defensive — the response is data, never executed,
 *  but we still keep the surface clean). */
const FORBIDDEN_PATHS = new Set(["__proto__", "constructor", "prototype"])

const FILE_LINE_RE = /^FILE\s*:\s*(.+?)\s*$/i
const REASON_LINE_RE = /^REASON\s*:\s*(.+?)\s*$/i
const LIST_MARKER_RE = /^\s*(?:[-*•]|\d+[.)])?\s*/

/** Extract just the path token from a `FILE:` line. Returns `undefined` if
 *  the line doesn't match. Strips backtick / quote wrappers commonly inserted
 *  by LLMs (e.g. ``FILE: `requests/models.py` ``). */
const matchFileLine = (line: string): string | undefined => {
  const m = FILE_LINE_RE.exec(line)
  if (!m || m[1] === undefined) return undefined
  return m[1].trim().replace(/^[`"']+|[`"']+$/g, "")
}

/** Extract the rationale text from a `REASON:` line. Returns `undefined` if
 *  the line doesn't match. Length-capped (500 chars) to bound 1MB-single-line
 *  pathological replies. */
const matchReasonLine = (line: string): string | undefined => {
  const m = REASON_LINE_RE.exec(line)
  if (!m || m[1] === undefined) return undefined
  return m[1].trim().slice(0, 500)
}

/** Strict parser. Accepts `FILE: <path>` followed (possibly after blank lines
 *  / numbered prefixes / leading whitespace) by `REASON: <text>`. A path
 *  that is not in `fileTreeSet` is silently dropped (hallucination guard).
 *  Duplicates (after the first occurrence) are dropped. The `FILE:` token is
 *  matched case-insensitively but the path itself is kept verbatim — the
 *  fileTreeSet membership check is exact (case-sensitive). */
export const parseAgentlessResponse = (
  raw: string,
  fileTreeSet: ReadonlySet<string>,
): { files: string[]; rationales: string[] } => {
  const files: string[] = []
  const rationales: string[] = []
  if (typeof raw !== "string" || raw.length === 0) return { files, rationales }

  // Split on any newline; strip CR; tolerate leading "1." / "-" / "*" /
  // whitespace before the FILE:/REASON: token. We intentionally do NOT
  // accept any other prefix variants — the prompt is explicit.
  const seen = new Set<string>()
  const lines = raw.split(/\r?\n/)
  // Tightly bound work: with N ≤ a few hundred response lines, this is fine.
  // (Hellgate covers 10K-line responses.)
  const MAX_LINES = 5_000
  const upper = Math.min(lines.length, MAX_LINES)

  let pendingFile: string | undefined
  for (let i = 0; i < upper; i++) {
    const rawLine = lines[i]
    if (rawLine === undefined) continue
    const stripped = rawLine.replace(LIST_MARKER_RE, "")
    const filePath = matchFileLine(stripped)
    if (filePath !== undefined) {
      pendingFile = filePath
      continue
    }
    const reason = matchReasonLine(stripped)
    if (reason === undefined || pendingFile === undefined) continue
    const path = pendingFile
    pendingFile = undefined
    // Filter chain — hallucination guard, prototype-pollution guard, dedup.
    if (!fileTreeSet.has(path) || FORBIDDEN_PATHS.has(path) || seen.has(path)) continue
    seen.add(path)
    files.push(path)
    rationales.push(reason)
  }
  return { files, rationales }
}

/** Truncate the file tree to fit the prompt budget. Two stages:
 *    1. cap on number of entries (`maxFiles`)
 *    2. cap on total characters of the joined text (`maxTreeChars`)
 *  We prefer entries earlier in the list (caller supplies them in any order
 *  it likes — production wiring puts likely-relevant subtrees first). */
const renderFileTree = (
  paths: readonly string[],
  maxFiles: number,
  maxTreeChars: number,
): { text: string; set: Set<string>; truncated: boolean; chars: number } => {
  const set = new Set<string>()
  const buf: string[] = []
  let chars = 0
  // F1 observe-only: the file-count cap and the char cap are BOTH truncation
  // (a gold file past either window is silently dropped).
  let truncated = false
  const cap = Math.max(0, Math.min(paths.length, maxFiles))
  if (paths.length > cap) truncated = true
  for (let i = 0; i < cap; i++) {
    const p = paths[i]
    if (typeof p !== "string" || p.length === 0) continue
    if (FORBIDDEN_PATHS.has(p)) continue
    // +1 for the newline.
    const next = chars + p.length + 1
    if (next > maxTreeChars) {
      // Char cap fired before we exhausted the file-count window ⇒ the rest of
      // the (valid) paths were dropped.
      truncated = true
      break
    }
    set.add(p)
    buf.push(p)
    chars = next
  }
  return { text: buf.join("\n"), set, truncated, chars }
}

/**
 * Run Agentless Stage-1 localization. Returns an empty `files` array when:
 *   - `problemStatement` is empty / non-string
 *   - the file tree is empty (or every entry was filtered out)
 *   - the LLM stream fails (caught; error message in `rawResponse`)
 *   - the response had no parseable `FILE:`/`REASON:` line pairs
 *
 * No fallback / retry / timeout logic lives here — the caller (e.g.
 * `bench-issue-hint` wiring) layers those on. This function is a single
 * pure prompt + parse cycle.
 */
/** Resolved + bounds-checked option block. `undefined` means "config invalid;
 *  caller MUST return empty result". */
const resolveOpts = (
  deps: AgentlessLocalizeDeps,
): { maxFiles: number; maxTreeChars: number; topK: number } | undefined => {
  const maxFiles = deps.maxFiles ?? DEFAULT_MAX_FILES
  const maxTreeChars = deps.maxTreeChars ?? DEFAULT_MAX_TREE_CHARS
  const topK = deps.topK ?? DEFAULT_TOP_K
  if (!Number.isFinite(topK) || topK < 1) return undefined
  if (!Number.isFinite(maxFiles) || maxFiles < 1) return undefined
  if (!Number.isFinite(maxTreeChars) || maxTreeChars < 1) return undefined
  return { maxFiles, maxTreeChars, topK }
}

/** Consume only the text surface we actually need. `stream_reset` tombstones
 *  any previously seen partial so the returned text matches
 *  `assembleFromEvents(...).message.content.filter(text)` without buffering
 *  the full event array. */
const collectTextFromStream = async (iter: AsyncIterable<StreamEvent>): Promise<string> => {
  let raw = ""
  for await (const ev of iter) {
    switch (ev.type) {
      case "stream_reset":
        raw = ""
        break
      case "text_delta":
        raw += ev.delta
        break
      default:
        break
    }
  }
  return raw
}

/** Drive the LLM stream and assemble the text reply. Returns `undefined` if
 *  the stream failed (in which case the caller surfaces an empty result with
 *  an `errorString(e)` rawResponse) or the empty string for a stream that
 *  produced no text. */
const runLocalizeStream = async (
  llm: LLMPort,
  userText: string,
): Promise<{ rawResponse: string } | { error: string }> => {
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: userText }] }]
  try {
    const iter = llm.stream({ messages, system: SYSTEM_MSG, tools: [] })
    return { rawResponse: await collectTextFromStream(iter) }
  } catch (e) {
    return { error: errorString(e) }
  }
}

export const agentlessLocalize = async (
  problemStatement: string,
  deps: AgentlessLocalizeDeps,
): Promise<AgentlessLocalizeResult> => {
  const emptyResult: AgentlessLocalizeResult = { files: [], rationales: [], rawResponse: "" }
  if (typeof problemStatement !== "string" || problemStatement.length === 0) {
    return emptyResult
  }
  const opts = resolveOpts(deps)
  if (opts === undefined) return emptyResult
  const { maxFiles, maxTreeChars, topK } = opts

  let paths: readonly string[]
  try {
    paths = await deps.fileTree()
  } catch {
    return emptyResult
  }
  if (!Array.isArray(paths) || paths.length === 0) return emptyResult
  const {
    text: fileTreeText,
    set: fileTreeSet,
    truncated,
    chars,
  } = renderFileTree(paths, maxFiles, maxTreeChars)
  // F1 observe-only telemetry — carried on EVERY return path from here down so
  // the caller can emit the `localize` trace without re-deriving truncation.
  const tree: AgentlessLocalizeResult["tree"] = {
    fileCount: paths.length,
    truncated,
    ...(truncated ? { truncatedChars: chars } : {}),
  }
  if (fileTreeSet.size === 0) return { ...emptyResult, tree }

  const userText = buildAgentlessPrompt(problemStatement, fileTreeText, topK)
  const stream = await runLocalizeStream(deps.llm, userText)
  if ("error" in stream) return { ...emptyResult, rawResponse: stream.error, tree }
  const rawResponse = stream.rawResponse
  if (rawResponse.length === 0) return { ...emptyResult, rawResponse, tree }

  const { files, rationales } = parseAgentlessResponse(rawResponse, fileTreeSet)
  // Trim to topK — the LLM occasionally over-produces.
  const cap = Math.min(files.length, topK)
  return {
    files: files.slice(0, cap),
    rationales: rationales.slice(0, cap),
    rawResponse,
    tree,
  }
}

/** Compose a hint markdown block from a localize result. Empty `files` ⇒
 *  empty string (byte-identical sentinel — same contract as
 *  `composeIssueHint`). */
export const composeAgentlessHint = (r: AgentlessLocalizeResult): string => {
  if (r.files.length === 0) return ""
  const lines: string[] = ["## Issue Hints (Agentless localization)", ""]
  lines.push(`Top-${r.files.length} files most likely to contain the bug:`)
  for (let i = 0; i < r.files.length; i++) {
    const path = r.files[i]
    const reason = r.rationales[i] ?? ""
    // Index 1-based for human readability.
    if (reason !== "") lines.push(`${i + 1}. \`${path}\` — ${reason}`)
    else lines.push(`${i + 1}. \`${path}\``)
  }
  lines.push("")
  lines.push("Use these as starting points but verify with your own tools.")
  return lines.join("\n")
}

/** Defensive — never let a thrown non-Error reach the `rawResponse` field
 *  as `[object Object]` or similar. */
const errorString = (e: unknown): string => {
  if (e instanceof Error) return `LLM stream failed: ${e.message}`
  if (typeof e === "string") return `LLM stream failed: ${e}`
  return "LLM stream failed: unknown error"
}
