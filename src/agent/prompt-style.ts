/**
 * Prompt render STYLE axis (jul-6) — flat vs Codex-style `##` markdown sections.
 *
 * Motivation: our static base prompt renders as ONE flat `\n`-joined block whose
 * section dividers are colon-terminated prose labels ("Operating principles:",
 * "Tool routing (...):"). Codex / Claude Code both render their core prompt as a
 * markdown `##`/`###` hierarchy — models are trained markdown-native, so a clear
 * header hierarchy plausibly improves in-prompt navigation / instruction-following
 * over a 24 KB flat block. This axis lets us render the SAME text as `##` sections
 * and A/B it on SWE f2p before deciding the default.
 *
 * DESIGN — lossless, exact-match, zero-heuristic:
 *   - Every real section header in the base prompt is a COL-0, single-line,
 *     colon-terminated string. They are enumerated verbatim in
 *     {@link SECTION_HEADER_LINES} (a closed allowlist — NOT a regex over prose).
 *   - `sectioned` render maps each line: if it EXACTLY equals an allowlisted
 *     header, rewrite it as `## <header-without-trailing-colon>`; otherwise pass
 *     it through untouched. Lossless (the parenthetical guidance stays in the
 *     heading) and false-positive-free (indented body lines like "  Verification:"
 *     never match — they are not col-0 and not in the allowlist).
 *   - Headerless paragraph sections (Durable state, Exploratory questions,
 *     Completion bar) intentionally stay prose — they have no clean header line
 *     to promote, and inventing one would not be lossless.
 *
 * BYTE-IDENTICAL default: `flat` (the default / absent) never calls the transform,
 * so the rendered prompt is byte-for-byte the pre-axis output. The prefix cache
 * and every byte-identical snapshot hold. Only an explicit `sectioned` opt (its
 * own default-OFF knob) changes bytes — and that path is measure-gated.
 */

/** The render style. `flat` (default / absent) ⇒ byte-identical to the pre-axis
 *  prompt. `sectioned` ⇒ allowlisted headers promoted to `## ` markdown. */
export type PromptStyle = "flat" | "sectioned"

/**
 * Closed allowlist of the base prompt's REAL section headers — each is a col-0,
 * single-line, colon-terminated literal that appears VERBATIM in
 * `src/agent/prompt-body.ts`. A hellgate test asserts (a) every entry is present
 * in the default-rendered prompt (no stale entry) and (b) after `sectioned`
 * transform none of them survive un-promoted (no missed header). Keep this list
 * in sync with prompt-body.ts section headers — the test fails loudly on drift.
 */
export const SECTION_HEADER_LINES: readonly string[] = [
  "Policy stack (highest to lowest priority — higher layers override lower):",
  "Operating principles:",
  "Internal vocabulary (NEVER expose to users — ADR-0067; Codex L26/L217):",
  "Production code conduct (your own discipline — user-mandated invariants):",
  "Git posture (default fail-closed — Codex §18.2/§18.4/§18.5 absorption):",
  "Evidence discipline (claim ladder):",
  "Trust ladder (when sources disagree, the higher wins):",
  "Anti-signals (treat as ROUTING HINTS, never proof):",
  "Budget discipline (every call is expensive):",
  "Tool failures & exploration (ADR-0062 — Codex SKILL.md L220/L254/L353):",
  "Tool routing (the truth condition picks the tool, not the keyword):",
  "Routing examples (anchor the routing rules above):",
  "Vision priority (ADR-0319):",
  "Honesty rail (closeout — these are correctness rules, not tone):",
  "Trust and inputs:",
  "Reporting shape by task kind — pick the one that matches the request:",
  "Verification report (use when you ran or considered running verification):",
] as const

/**
 * The subset of {@link SECTION_HEADER_LINES} that are genuine SUB-sections of the
 * header immediately above them — they render as `###` (level 3), not `##`, so the
 * hierarchy reads correctly instead of 17 flat peers (jul-6 audit F2):
 *   - "Routing examples …" is a sub-part of "Tool routing …"
 *   - "Verification report …" is a sub-part of "Reporting shape …"
 * Every entry MUST also be in SECTION_HEADER_LINES (a test asserts the subset
 * relation); membership here only changes the heading LEVEL, not whether it is
 * promoted.
 */
export const SUBSECTION_HEADER_LINES: readonly string[] = [
  "Routing examples (anchor the routing rules above):",
  "Verification report (use when you ran or considered running verification):",
] as const

const SUBSECTION_SET: ReadonlySet<string> = new Set(SUBSECTION_HEADER_LINES)

/**
 * Exact-match heading RENAME overrides (jul-6 audit F3) — Codex-style clean names
 * that also disambiguate the two "Trust …" headers, which read as a confusing
 * near-duplicate once promoted to peer markdown headers:
 *   - "Trust ladder …"    → source-of-truth precedence (which SOURCE wins)
 *   - "Trust and inputs …" → untrusted-input / prompt-injection handling
 * A header not listed here falls back to the default `##`/`###` + colon-strip. The
 * value is the FULL rendered line (level prefix included). SECTIONED-ONLY — the
 * flat prompt keeps the original wording byte-identical.
 */
const HEADER_RENDER_OVERRIDE: ReadonlyMap<string, string> = new Map([
  [
    "Trust ladder (when sources disagree, the higher wins):",
    "## Source-of-truth ladder (when sources disagree, the higher wins)",
  ],
  ["Trust and inputs:", "## Untrusted inputs & injection defense"],
])

/**
 * Synthetic section headers INJECTED before an orphaned rule block (jul-6 audit
 * F1). The batch task-pack rules (`[R-ENV] … [R-NO-EXPLORE-OVER-EDIT]`) carry no
 * header of their own, so in flat prose they float — and once the surrounding
 * sections become markdown they visually orphan under the preceding `###`. Each
 * entry inserts `block` immediately BEFORE the first line that EXACTLY equals
 * `anchor` (a stable, tested string, not a regex). Anchor absent (e.g. a non-batch
 * pack whose first rule differs) ⇒ no insertion (graceful). SECTIONED-ONLY.
 */
export const HEADER_INJECT_BEFORE: readonly { anchor: string; block: readonly string[] }[] = [
  {
    anchor: "- [R-ENV] Do NOT install third-party dependencies or persistently modify the",
    block: ["", "## Environment & task rules", ""],
  },
]

/** O(1) lookup set of the exact header strings. */
const HEADER_SET: ReadonlySet<string> = new Set(SECTION_HEADER_LINES)

/** Render one allowlisted header to its markdown form: an explicit rename override
 *  if declared, else `###` for a sub-section / `##` for a top section, with the one
 *  trailing colon stripped (parenthetical guidance kept). Exported so tests assert
 *  the EXACT rendered line per header rather than re-deriving the rule. Pure. */
export const renderSectionHeader = (header: string): string => {
  const override = HEADER_RENDER_OVERRIDE.get(header)
  if (override !== undefined) return override
  return `${SUBSECTION_SET.has(header) ? "###" : "##"} ${header.replace(/:$/, "")}`
}

/**
 * Apply the render style to an already-assembled base prompt string.
 * `flat` ⇒ returns the input unchanged (byte-identical). `sectioned` ⇒ splits on
 * `\n` and, per line: (1) inject any synthetic header whose anchor matches this
 * line, then (2) promote an allowlisted header to its markdown form, else pass
 * through. Every original line survives verbatim except allowlisted headers (which
 * are rewritten); only the injected headers add lines.
 */
export const applyPromptStyle = (assembled: string, style: PromptStyle): string => {
  if (style === "flat") return assembled
  const out: string[] = []
  for (const line of assembled.split("\n")) {
    const inject = HEADER_INJECT_BEFORE.find((i) => i.anchor === line)
    if (inject !== undefined) out.push(...inject.block)
    out.push(HEADER_SET.has(line) ? renderSectionHeader(line) : line)
  }
  return out.join("\n")
}
