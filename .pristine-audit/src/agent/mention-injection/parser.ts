/**
 * ADR-0325 / ADR-0418 — Pure mention parser for user input text.
 *
 * SEVEN closed-enum mention sigils (ADR-0325 + ADR-0418 + §10.3):
 *
 *   `@skill-name`                 → MentionKind = "skill"
 *   `plugin://name`               → MentionKind = "plugin"
 *   `@@app-name`                  → MentionKind = "app"
 *   `@path/to/file` / `@foo.ts`   → MentionKind = "file"   (ADR-0418)
 *   `@FooBar` / `@MyClass.method` → MentionKind = "symbol" (ADR-0418)
 *   `@dir/` (trailing slash)      → MentionKind = "folder" (§10.3)
 *   `@git` / `@git:diff`          → MentionKind = "git"    (§10.3)
 *   `@mcp:<name>`                 → MentionKind = "mcp"      (RFC-12-2)
 *   `@subagent:<name>`            → MentionKind = "subagent" (RFC-12-2)
 *   `@thread:<id>`                → MentionKind = "thread"   (RFC-12-2)
 *
 * RFC-12-2 cascade additions (deterministic, matched by their OWN regex
 * alternative BEFORE the generic `@`-cascade, exactly like `@git`): the three
 * `@<literal>:<payload>` forms REQUIRE the `:<payload>` suffix. A BARE `@mcp` /
 * `@subagent` / `@thread` (no colon + payload) is NOT one of these kinds — it
 * falls through to the generic cascade and reads as a `skill` (so an `mcp`-named
 * skill stays reachable by bare `@mcp`, unlike `@git` which reserves the bare
 * literal). Payload alphabet is `[A-Za-z0-9_-]` (kebab server/agent names +
 * hex-and-dash UUID thread ids); a right-boundary lookahead stops the payload
 * at the first char that would continue that alphabet.
 *
 * §10.3 cascade additions (deterministic, FIRST match wins):
 *   - `@git` / `@git:(status|diff|log)` is matched by its OWN regex
 *     alternative BEFORE the generic `@`-cascade, so a `git`-named skill is
 *     unreachable by bare `@git`. The `@git` literal matches ONLY at a true
 *     right-boundary: the char after `git` (or after the subcommand) must NOT
 *     continue an identifier / path (`[A-Za-z0-9_:./~-]`). So `@git/x` is a
 *     FILE, `@git.foo` is a FILE, `@git-helper` is a SKILL, and an invalid
 *     subcommand (`@git:bogus`) falls through to `@git` ⇒ skill `git`.
 *   - A slash-path that ENDS WITH `/` routes to `folder` (priority 2a, before
 *     `file`).
 *
 * Syntax rules — DETERMINISTIC priority resolution (ADR-0418 §4, VERBATIM):
 *
 *   The parser MUST classify each `@<rest>` match deterministically.
 *   Order of attempts on the `<rest>` payload (FIRST match wins):
 *
 *     1. `@@<kebab>` (double-`@`) → kind=app, target=app-name (matched
 *        by its own regex alternative, so it never enters the @-cascade).
 *     2. `<rest>` contains `/` → kind=file. The whole path (until a
 *        whitespace / unsupported char) is the target. (slash → file)
 *     3. `<rest>` starts with `[A-Z]` (uppercase ASCII letter) →
 *        kind=symbol. Identifier alphabet `[A-Za-z0-9_]`, optional
 *        `.<identifier>` suffix (one level: `Class.method`).
 *        (uppercase-start → symbol)
 *     4. `<rest>` starts with `[a-z]` AND contains `.` → kind=file.
 *        Lowercase-leading dotted token (e.g. `@a.b`, `@foo.ts`).
 *        (dot + lowercase-start → file)
 *     5. `<rest>` is a pure ASCII kebab-case identifier
 *        `[a-z][a-z0-9-]*` (length ≤ 64) → kind=skill.
 *        (lowercase-kebab → skill)
 *
 *   `plugin://name` is parsed via its own alternative (no `@` prefix);
 *   precedence is independent of the @-cascade above. `@@app` is matched
 *   FIRST so the single-`@` alternative does not eat the leading `@`.
 *
 *   Tie-break documentation (ADR-0418 §4 — verbatim examples):
 *     - `@./Foo`     → kind=file   (contains `/`)
 *     - `@Foo.bar`   → kind=symbol (starts uppercase, `.member` allowed)
 *     - `@a.b`       → kind=file   (lowercase start + contains `.`)
 *     - `@code-review` → kind=skill (kebab, no `.` no `/`)
 *
 * Other rules (LOCKED — extending requires a new ADR):
 *
 *   1. Skill identifier alphabet: `[a-z][a-z0-9-]*` (ASCII kebab-case,
 *      starts lowercase). Length 1..64.
 *   2. File path alphabet: `[A-Za-z0-9_./~-]` (workspace-relative
 *      paths). Length 1..512 (post-sigil). Whitespace terminates.
 *   3. Symbol alphabet: `[A-Z][A-Za-z0-9_]*` optional `.[A-Za-z_][A-Za-z0-9_]*`.
 *      Length 1..128 (post-sigil).
 *   4. App identifier alphabet: ASCII kebab `[a-z][a-z0-9-]*`, length 1..64.
 *   5. Plugin identifier alphabet: ASCII kebab `[a-z][a-z0-9-]*`, 1..64.
 *   6. Left-boundary: the leading sigil MUST sit at start-of-input OR
 *      immediately after a NON-word char (JS `[^\w]`). Email `foo@bar.com`
 *      is rejected because `o` (left of `@`) is `\w`.
 *   7. Right-boundary: post-identifier char MUST NOT continue the kind's
 *      alphabet (otherwise we'd be reading a prefix). End-of-input is a
 *      boundary.
 *   8. Dedup: per `(kind, target)` pair, FIRST occurrence wins. Order is
 *      preserved.
 *   9. Code fences / inline backticks are NOT treated specially.
 *   10. Empty target after a sigil is NOT a mention.
 *
 * NO-THROW invariant: any input string produces a `readonly ParsedMention[]`.
 * Pure: no clock read, no I/O, no global state.
 */

import type { MentionKind, ParsedMention } from "./types"

/** Max identifier length (post-sigil) for skill / app / plugin. */
const MAX_KEBAB_LEN = 64
/** Max path length (post-sigil) for `file`. */
const MAX_FILE_LEN = 512
/** Max symbol length (post-sigil) for `symbol`. */
const MAX_SYMBOL_LEN = 128
/** Max payload length for RFC-12-2 `@mcp:` / `@subagent:` names + `@thread:`
 *  ids. 128 covers a `crypto.randomUUID()` (36) thread id with headroom and
 *  any realistic kebab server / agent name. */
const MAX_RFC12_PAYLOAD_LEN = 128

/**
 * Master regex. Each alternative captures the FULL match via named groups:
 *
 *   - `app`     : `@@<kebab>` (must precede the `@<rest>` alternative).
 *   - `plugin`  : `plugin://<kebab>` (independent of `@`).
 *   - `at`      : `@<rest>` — POST-MATCH classified into file / symbol /
 *                 skill by `classifyAtPayload`. The `<rest>` capture is
 *                 `atPayload`.
 *
 * The trailing negative-lookahead for `app` / `plugin` (`(?![a-z0-9-])`)
 * enforces the kebab right-boundary. The `at` alternative uses a broader
 * payload regex; right-boundary is enforced per-kind in `classifyAtPayload`.
 */
const MENTION_RE =
  /(?<app>@@(?<appName>[a-z][a-z0-9-]*))(?![a-z0-9-])|(?<plugin>plugin:\/\/(?<pluginName>[a-z][a-z0-9-]*))(?![a-z0-9-])|(?<git>@git(?::(?<gitSub>status|diff|log))?)(?![A-Za-z0-9_:./~-])|(?<mcp>@mcp:(?<mcpName>[A-Za-z0-9_-]+))(?![A-Za-z0-9_-])|(?<subagent>@subagent:(?<subagentName>[A-Za-z0-9_-]+))(?![A-Za-z0-9_-])|(?<thread>@thread:(?<threadId>[A-Za-z0-9_-]+))(?![A-Za-z0-9_-])|(?<at>@(?<atPayload>[A-Za-z_./~][A-Za-z0-9_./~-]*))/g

/** Pure kebab identifier check for skill / app / plugin. */
const KEBAB_RE = /^[a-z][a-z0-9-]*$/
/** Symbol identifier (uppercase-leading), optional `.member` suffix. */
const SYMBOL_RE = /^[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/
/** File-path alphabet allowed AFTER the `@`. */
const FILE_PATH_RE = /^[A-Za-z0-9_./~][A-Za-z0-9_./~-]*$/

/**
 * Left-boundary predicate (rule 6). `prevChar` is the codepoint
 * immediately BEFORE the match start (or `""` at start-of-input). A
 * mention starts only when the previous char is not a JS word char.
 */
const isLeftBoundaryOk = (prevChar: string): boolean => {
  if (prevChar === "") return true
  return /[^\w]/.test(prevChar)
}

/** Narrow the regex-captured payload to the file-path alphabet, trimming
 *  trailing characters that escape the alphabet. Returns null if EMPTY
 *  after narrowing. */
const narrowFilePayload = (payload: string): string | null => {
  let end = payload.length
  while (end > 0) {
    const ch = payload[end - 1] ?? ""
    if (FILE_PATH_RE.test(ch)) break
    end--
  }
  if (end === 0) return null
  const candidate = payload.slice(0, end)
  if (!FILE_PATH_RE.test(candidate)) return null
  return candidate
}

/** Narrow the regex-captured payload to the symbol alphabet. The master
 *  regex may have captured trailing path-like chars (`-`, `/`, `~`); we
 *  accept the longest symbol-alphabet prefix. */
const narrowSymbolPayload = (payload: string): string | null => {
  const m = payload.match(/^[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?/)
  if (m === null) return null
  if (!SYMBOL_RE.test(m[0])) return null
  return m[0]
}

/** Narrow the regex-captured payload to the kebab alphabet (skill case). */
const narrowKebabPayload = (payload: string): string | null => {
  const m = payload.match(/^[a-z][a-z0-9-]*/)
  if (m === null) return null
  if (!KEBAB_RE.test(m[0])) return null
  // Right-boundary: char immediately after the kebab must NOT continue
  // the kebab alphabet. `.` and `/` would have been routed to file/symbol
  // earlier, so the only "continues the alphabet" residue is `[a-z0-9-]`;
  // the greedy regex already consumed all of those, so a non-empty
  // remainder here is always a genuine terminator — accept.
  if (m[0].length < payload.length) {
    const next = payload[m[0].length] ?? ""
    if (/[a-z0-9-]/.test(next)) return null
  }
  return m[0]
}

type AtClass = { kind: MentionKind; target: string } | null

/** Narrow + length-cap a file payload into a `file` classification. */
const asFile = (payload: string): AtClass => {
  const cleaned = narrowFilePayload(payload)
  if (cleaned === null || cleaned.length > MAX_FILE_LEN) return null
  return { kind: "file", target: cleaned }
}

/** §10.3 — narrow a slash-path payload into a `folder` classification when it
 *  ENDS WITH `/` (Cursor `@Folders` parity). A path that doesn't end in `/`
 *  after narrowing is NOT a folder (caller falls through to `asFile`). */
const asFolder = (payload: string): AtClass => {
  const cleaned = narrowFilePayload(payload)
  if (cleaned === null || cleaned.length > MAX_FILE_LEN) return null
  if (!cleaned.endsWith("/")) return null
  return { kind: "folder", target: cleaned }
}

/** Narrow + length-cap a symbol payload into a `symbol` classification. */
const asSymbol = (payload: string): AtClass => {
  const cleaned = narrowSymbolPayload(payload)
  if (cleaned === null || cleaned.length > MAX_SYMBOL_LEN) return null
  return { kind: "symbol", target: cleaned }
}

/** Narrow + length-cap a kebab payload into a `skill` classification. */
const asSkill = (payload: string): AtClass => {
  const kebab = narrowKebabPayload(payload)
  if (kebab === null || kebab.length > MAX_KEBAB_LEN) return null
  return { kind: "skill", target: kebab }
}

/**
 * Classify the payload of an `@<rest>` match per the ADR-0418 §4 priority
 * cascade. Returns the classified `(kind, target)` pair, or `null` if the
 * payload doesn't fit any kind.
 *
 * Cascade order (FIRST match wins): slash→file, uppercase→symbol,
 * lowercase+dot→file, lowercase-kebab→skill.
 */
const classifyAtPayload = (payload: string): AtClass => {
  if (payload.includes("/")) {
    // §10.3 priority 2a — a trailing-slash slash-path is a FOLDER; otherwise
    // it is a FILE (priority 2). The folder check is gated on the narrowed
    // payload still ending in `/`, so an over-captured trailing char that is
    // trimmed away never spuriously flips a file into a folder.
    return asFolder(payload) ?? asFile(payload)
  }
  if (/^[A-Z]/.test(payload)) return asSymbol(payload) // priority 3
  if (/^[a-z]/.test(payload) && payload.includes(".")) return asFile(payload) // priority 4
  if (/^[a-z]/.test(payload)) return asSkill(payload) // priority 5
  return null
}

/** Build a {@link ParsedMention} from a verbatim-raw kebab match (app /
 *  plugin). Returns null when the identifier blows the kebab cap. */
const kebabMention = (
  kind: "app" | "plugin",
  target: string,
  start: number,
  raw: string,
): ParsedMention | null => {
  if (target.length > MAX_KEBAB_LEN) return null
  return { kind, target, span: { start, end: start + raw.length }, raw }
}

/** RFC-12-2 — build a {@link ParsedMention} for a `@<literal>:<payload>` kind
 *  (mcp / subagent / thread). The regex already enforced the payload alphabet
 *  + right-boundary, so the only remaining gate is the length cap. Returns null
 *  when the payload blows {@link MAX_RFC12_PAYLOAD_LEN}. The span uses the raw
 *  match verbatim (the payload was matched exactly, never over-captured). */
const literalMention = (
  kind: "mcp" | "subagent" | "thread",
  target: string,
  start: number,
  raw: string,
): ParsedMention | null => {
  if (target.length === 0 || target.length > MAX_RFC12_PAYLOAD_LEN) return null
  return { kind, target, span: { start, end: start + raw.length }, raw }
}

/** Classify the captured `@<rest>` payload + project it into a
 *  {@link ParsedMention}. The `raw` is RECONSTRUCTED from the narrowed
 *  target (`@${target}`) so an over-captured payload does not inflate the
 *  span past the consumed slice. */
const atMention = (payload: string, start: number): ParsedMention | null => {
  const classified = classifyAtPayload(payload)
  if (classified === null) return null
  const raw = `@${classified.target}`
  return {
    kind: classified.kind,
    target: classified.target,
    span: { start, end: start + raw.length },
    raw,
  }
}

/** RFC-12-2 — dispatch the three `@<literal>:<payload>` alternatives (mcp /
 *  subagent / thread) from the regex groups. Extracted from `validateMatch` so
 *  that hot classifier stays under the cognitive-complexity ratchet. Returns
 *  the projected mention, or `null` when NONE of the three groups matched (the
 *  caller then falls through to the generic `@`-cascade). */
const literalDispatch = (
  groups: Record<string, string | undefined>,
  start: number,
  raw: string,
): ParsedMention | null => {
  if (groups.mcp !== undefined && groups.mcpName !== undefined) {
    return literalMention("mcp", groups.mcpName, start, raw)
  }
  if (groups.subagent !== undefined && groups.subagentName !== undefined) {
    return literalMention("subagent", groups.subagentName, start, raw)
  }
  if (groups.thread !== undefined && groups.threadId !== undefined) {
    return literalMention("thread", groups.threadId, start, raw)
  }
  return null
}

/**
 * Validate one regex match against all syntax rules. Returns the
 * would-be {@link ParsedMention} or `null` if rejected. Pure.
 */
const validateMatch = (m: RegExpMatchArray, text: string): ParsedMention | null => {
  const start = m.index
  if (start === undefined) return null

  const prevChar = start === 0 ? "" : (text[start - 1] ?? "")
  if (!isLeftBoundaryOk(prevChar)) return null

  const groups = m.groups ?? {}

  if (groups.app !== undefined && groups.appName !== undefined) {
    return kebabMention("app", groups.appName, start, m[0])
  }
  if (groups.plugin !== undefined && groups.pluginName !== undefined) {
    return kebabMention("plugin", groups.pluginName, start, m[0])
  }
  // §10.3 — `@git` reserved literal (matched BEFORE the generic `@` cascade so
  // a `git`-named skill is unreachable by bare `@git`). The subcommand is a
  // closed enum (`status|diff|log`); bare `@git` defaults to `status`.
  if (groups.git !== undefined) {
    const sub = groups.gitSub ?? "status"
    return { kind: "git", target: sub, span: { start, end: start + m[0].length }, raw: m[0] }
  }
  // RFC-12-2 — the three `@<literal>:<payload>` kinds, matched BEFORE the
  // generic `@` cascade so a `mcp`/`subagent`/`thread`-named skill is only
  // reachable by the BARE form (no `:payload`). The regex already enforced the
  // payload alphabet + right-boundary; here we length-cap and project.
  const literal = literalDispatch(groups, start, m[0])
  if (literal !== null) return literal
  if (groups.at !== undefined && groups.atPayload !== undefined) {
    return atMention(groups.atPayload, start)
  }
  return null
}

/**
 * Parse `userInputText` and return the (deduped, in-order) list of
 * explicit mentions. NO-THROW: degenerate inputs produce `[]`.
 *
 * Dedup key: `${kind}\x1f${target}` — a separator that cannot appear in
 * any kind's identifier alphabet, so cross-kind targets do not collide.
 */
export const parseMentions = (userInputText: string): readonly ParsedMention[] => {
  if (typeof userInputText !== "string" || userInputText.length === 0) {
    return []
  }

  const out: ParsedMention[] = []
  const seen = new Set<string>()

  MENTION_RE.lastIndex = 0
  for (const m of userInputText.matchAll(MENTION_RE)) {
    const candidate = validateMatch(m, userInputText)
    if (candidate === null) continue

    const key = `${candidate.kind}\x1f${candidate.target}`
    if (seen.has(key)) continue
    seen.add(key)

    out.push(candidate)
  }

  return out
}
