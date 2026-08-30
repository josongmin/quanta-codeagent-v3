/**
 * HTML → Markdown converter (ADR-0186) — `turndown@7.2.4`-backed
 * implementation that replaces the 9-stage inline pipeline previously in
 * `fetch.ts`. Same public contract: `htmlToMarkdown(html)` returns a
 * trimmed markdown string with no triple-newline runs.
 *
 * User principle: "외부에 잘 만들어진 거 있으면 외부 거 써."
 *
 * Config rationale (each choice serves the agent-callable surface, not a
 * human reader):
 *   - `headingStyle: "atx"` — `#`/`##` prefixes parse predictably; Setext
 *     underlines depend on visual width of the heading text and break in
 *     monospace-truncated logs.
 *   - `codeBlockStyle: "fenced"` — `` ``` `` lets a downstream renderer
 *     detect a language (a follow-up rule may inject `lang` from a
 *     `<code class="language-X">` hint).
 *   - `bulletListMarker: "-"` — matches our existing self-impl output and
 *     the agent's own write_file emit style.
 *   - `emDelimiter: "_"` / `strongDelimiter: "**"` — distinct sigils so a
 *     downstream parser cannot confuse `_em_` with `**strong**`.
 *   - `linkStyle: "inlined"` — `[text](url)` keeps the URL co-located with
 *     the link text; reference-style would force the model to scroll the
 *     output to find a `[1]: url` footer that may be truncated by our 50KB
 *     output cap.
 *
 * Security: `<script>`, `<style>`, `<noscript>`, `<iframe>` are removed
 * (NOT just stripped of tags — their entire text content is dropped) via
 * `turndown.remove(…)`. That guards against `<script>alert(1)</script>`
 * surviving as raw JS text in the model's view.
 *
 * Post-processing: turndown emits `\n\n\n+` runs across some block
 * transitions; we collapse to exactly `\n\n` and trim leading/trailing
 * whitespace, matching the byte-shape of the prior inline impl so existing
 * hellgate snapshots in `web-fetch-hellgate.test.ts` stay green.
 */

import type TurndownService from "turndown"
import type { Rule, TurndownOptions } from "turndown"

type TurndownConstructor = new (options?: TurndownOptions) => TurndownService

const TURNDOWN_OPTIONS = {
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "_",
  strongDelimiter: "**",
  linkStyle: "inlined",
} as const satisfies TurndownOptions

let configuredTurndown: TurndownService | undefined

const getTurndown = (): TurndownService => {
  if (configuredTurndown !== undefined) return configuredTurndown
  // Literal synchronous require preserves htmlToMarkdown's synchronous public
  // contract while keeping turndown + its domino DOM out of sessions that never
  // fetch HTML. The configured instance remains one process-wide singleton.
  const Turndown = require("turndown") as TurndownConstructor
  const service = new Turndown(TURNDOWN_OPTIONS)
  service.remove(["script", "style", "noscript", "iframe"])
  configuredTurndown = service
  return service
}

/** Configured singleton — exposed so callers can register custom rules
 *  (e.g. preserve `<code class="language-X">`, table-conversion plugin) in
 *  a future ADR. NOT a per-call instance; turndown reuses parsed-DOM and
 *  rule state between calls without leaking. */
export const turndown: TurndownService = {
  turndown: (html) => getTurndown().turndown(html),
  remove(filter) {
    getTurndown().remove(filter)
    return turndown
  },
  addRule(key: string, rule: Rule) {
    getTurndown().addRule(key, rule)
    return turndown
  },
  keep(filter) {
    getTurndown().keep(filter)
    return turndown
  },
  use(plugin) {
    getTurndown().use(plugin)
    return turndown
  },
  escape: (text) => getTurndown().escape(text),
}

/** Convert an HTML string to Markdown using the configured turndown
 *  singleton. Pure / no I/O. Matches the byte-shape of the prior inline
 *  9-stage converter: 3+ consecutive newlines collapse to exactly 2,
 *  leading + trailing whitespace trimmed. */
export const htmlToMarkdown = (html: string): string => {
  const md = getTurndown().turndown(html)
  return md.replace(/\n{3,}/g, "\n\n").trim()
}
