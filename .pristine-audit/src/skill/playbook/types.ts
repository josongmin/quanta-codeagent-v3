/**
 * User-authored playbook frontmatter types (ADR-0203).
 *
 * Faithful absorption of 5-vendor SOTA convergence on "authored procedural
 * skills" — a slice strictly above the lenient SKILL.md frontmatter, adding:
 *
 *   - `procedure`           — MECE action-verb step list (Devin Playbooks)
 *   - `success-criteria`    — declarative success predicates (Devin Spec)
 *   - `forbidden-actions`   — HARD_DENY before tool dispatch (Devin)
 *   - `macros`              — `!name` shorthand a step body can reference
 *                             (Devin macros / Windsurf workflow-from-workflow)
 *   - `trigger.comment-marker` + `trigger.watch-glob` — saved-file inline
 *     trigger (Aider `AI!` source-comment dispatch)
 *
 * EVERY field is OPTIONAL. A SKILL.md whose frontmatter omits all of them is
 * byte-identical (per ADR-0203 invariant) to the pre-0203 lenient skill. The
 * playbook slice is fully OPT-IN: nothing in `@/agent`, `@/tool`, or
 * `@/permission` reads these fields unless a host wires the validator /
 * watcher explicitly.
 *
 * Slice discipline: leaf-level types. NO imports from @/agent, @/tool,
 * @/permission. Parents in the slice tree may import these (validator etc.)
 * but they too are leaf-relative.
 */

/** A single macro name → expansion. */
export interface MacroDefinition {
  /** Macro identifier (without the leading `!`). kebab-case enforced by parser. */
  readonly name: string
  /** What the macro expands to when invoked from a procedure step. */
  readonly expansion: string
}

/** Inline-trigger config — the saved-file comment-marker dispatch path. */
export interface InlineTriggerConfig {
  /**
   * Substring marker the watcher searches for in any line of a watched file
   * after it is saved. Example: `"QUANTA!"` matches `// fix this QUANTA!`.
   * Authors pick a string unique enough not to collide with code comments.
   */
  readonly commentMarker: string
  /**
   * Glob (relative to the watch root) selecting which files the watcher should
   * scan on save. Example: `"**\/*.{ts,py,js}"`. The watcher applies the same
   * substring rules as `frontmatter.paths` — fnmatch-style, NO `**` regression.
   */
  readonly watchGlob: string
}

/**
 * The full playbook frontmatter, with all optional fields. This is the SHAPE
 * returned by {@link parsePlaybookFrontmatter}; consumers Pick<> what they
 * need.
 */
export interface PlaybookFrontmatter {
  /** MECE ordered procedure steps. */
  readonly procedure?: readonly string[]
  /** Declarative success predicates (test pass / artifact emit etc.). */
  readonly successCriteria?: readonly string[]
  /**
   * Forbidden action substrings — HARD_DENY before tool dispatch. Each entry
   * is a case-insensitive substring; if the proposed tool action's serialized
   * form contains any of these, dispatch is denied.
   */
  readonly forbiddenActions?: readonly string[]
  /** Macro registry — `!name` lookups inside `procedure` entries. */
  readonly macros?: readonly MacroDefinition[]
  /** Inline-trigger config, if declared. */
  readonly trigger?: InlineTriggerConfig
}

/**
 * Discriminated union for parse outcomes. We do NOT throw on operational
 * failure — the caller renders the `error` line number into tool output, the
 * same convention `skill-frontmatter.ts` uses.
 */
export type PlaybookParseResult =
  | { readonly ok: true; readonly value: PlaybookFrontmatter }
  | { readonly ok: false; readonly error: PlaybookParseError }

export class PlaybookParseError extends Error {
  override readonly name = "PlaybookParseError"
  constructor(
    message: string,
    /** 1-based line number where the failure was detected (best-effort). */
    readonly line: number,
  ) {
    super(`playbook frontmatter parse error (line ${line}): ${message}`)
  }
}

/**
 * Reason a forbidden-action check rejected a tool call. The reason carries
 * the literal matched substring so the host can surface a precise error.
 */
export interface ForbiddenActionMatch {
  readonly forbidden: string
  readonly matchedIn: string
}

export type ValidatorVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ForbiddenActionMatch }

/**
 * Result of a macro lookup. `undefined` is a structurally meaningful outcome
 * (the macro name was not declared); we surface it via a typed nullable
 * rather than a thrown error so the caller can decide whether a miss is a
 * hard error or a silent passthrough.
 */
export type MacroLookupResult =
  | { readonly ok: true; readonly expansion: string }
  | { readonly ok: false; readonly reason: "not-found"; readonly name: string }

/**
 * The maximum byte size for a single playbook SKILL.md file. Windsurf
 * workflows cap at 12 KB; we honor the same cap because the rendered body
 * rides into the LLM prompt verbatim and we do not want a single playbook to
 * blow out the context window. Larger files load as a typed `ok:false` —
 * never throw.
 */
export const PLAYBOOK_MAX_BYTES = 12 * 1024
