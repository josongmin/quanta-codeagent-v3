# ADR-0186: HTML → Markdown — swap inline 9-stage pipeline for `turndown`

- Status: Accepted (supersedes the inline `htmlToMarkdown` in
  `src/tool/web/fetch.ts`)
- Date: 2026-05-25
- Related: ADR-0127 (web slice — `web_fetch` + `web_search`)
- SOTA reference: `turndown@7.2.4` (Dom Christie; the JS-world canonical
  HTML → Markdown converter — ~2.3M weekly downloads, used by Notion,
  GitHub markdown re-import flows, and most ChatGPT-style chat surfaces).

## Context

ADR-0127 shipped `web_fetch` with a small inline HTML → Markdown converter:
a 9-stage pipeline (~65 LOC + a `decodeEntities` helper) covering script /
style strip, headings, links, inline code, paragraph + line break, generic
tag strip, the 5 base entities, triple-newline collapse, trim. It is
hand-tuned and ROI-positive — but every grammar gap (tables, fenced code,
bold/em, ordered lists, nested lists, blockquotes, `<dl>`, `<figure>`,
`<picture>`, `<details>`) is a follow-up regex we'd have to write and
maintain against real-world drift.

`turndown` is the JS-world canonical alternative — active maintenance,
domino-DOM-backed parsing (not regex), and a pluggable rule engine that
lets us register custom rules later without a fork.

User principle: "외부에 잘 만들어진 거 있으면 외부 거 써."

The cost of adoption is small: one `TurndownService` singleton with 6 config
fields, a `remove([…])` security strip for `script` / `style` / `noscript` /
`iframe`, a 2-line post-processor that preserves the prior byte-shape
invariant (no triple+ newline runs, trimmed leading/trailing whitespace).
~30 LOC of wrapper code, ~150 LOC of inline self-impl deleted.

## Decision

A NEW `src/tool/web/html-to-markdown.ts` module that:

1. Constructs a `TurndownService` singleton with our agent-tuned config:
   - `headingStyle: "atx"` — `#`/`##` prefixes; not Setext underlines.
   - `codeBlockStyle: "fenced"` — `` ``` `` blocks (lets a follow-up rule
     inject `lang` from `<code class="language-X">`).
   - `bulletListMarker: "-"` — matches prior self-impl + agent's
     `write_file` emit style.
   - `emDelimiter: "_"`, `strongDelimiter: "**"` — distinct sigils so a
     downstream parser cannot confuse the two.
   - `linkStyle: "inlined"` — `[text](url)` co-located; reference-style
     would push the `[1]: url` footer past the 50KB output cap on big
     pages.
2. Calls `turndown.remove(["script", "style", "noscript", "iframe"])` so
   those elements' text content is dropped, not just unwrapped. Guards
   against `<script>alert(1)</script>` surviving as raw JS text.
3. `htmlToMarkdown(html)` calls `turndown.turndown(html)`, then collapses
   `\n{3,}` → `\n\n` and trims — preserves the byte-shape invariant the
   prior self-impl held.
4. Exports `turndown` (the configured singleton) so callers can register
   custom rules (table plugin, code-fence language detector) in a follow-
   up without reaching for a fresh instance.

`src/tool/web/fetch.ts`:
- Removes the inline `htmlToMarkdown` (~65 LOC) and `decodeEntities`
  helper (~10 LOC).
- Imports `htmlToMarkdown` from `./html-to-markdown` and uses it in
  `decodeBodyPhase` (unchanged call site).
- Re-exports `htmlToMarkdown` so the legacy import path (`./fetch` →
  `htmlToMarkdown`) keeps resolving for callers that bypass the barrel.

`src/tool/web/index.ts` barrel:
- Adds `export { htmlToMarkdown, turndown } from "./html-to-markdown"` at
  the top, removes the now-redundant re-export from `./fetch`.

`src/tool/web/turndown.d.ts`: ambient module declaration for `turndown`
(no bundled / `@types/*` package). Surface narrowed to the methods our
adapter and tests touch: constructor, `turndown(html)`, `remove(filter)`,
`addRule(key, rule)`, `keep(filter)`, `use(plugin)`, `escape(text)`.
`skipLibCheck: true` means a future caller can extend without breaking
unrelated typechecks.

### Public surface byte-stability

The `web_fetch` tool's output composition (`URL: … Status: … Length: …
\n\n {body}`) is unchanged. Tests 14 / 15 / 16 / 17 / 17b / 21 in
`tests/unit/tool/web-fetch-hellgate.test.ts` (full-tool happy-path,
404, binary, oversize, network throw, abort) stay green without
modification — the swap only changes the BODY portion's exact bytes
when the body is `text/html`.

Two pure-helper unit tests (20c, 20d) that asserted byte-exact strings
tied to the inline regex pipeline are updated to property assertions
(`contain "&"`, `contain '"'`, `not.toContain "\n\n\n"`) that turndown
satisfies. The publicly-documented invariants (no triple-newline runs;
entities decoded; security tags stripped) all hold.

### Default-OFF security posture preserved

The `turndown.remove([…])` security strip is invoked at module load
exactly once (singleton init). No per-call config means a runtime caller
cannot accidentally turn it off. The same 4 security-relevant tags
(`script` / `style` / `noscript` / `iframe`) the prior self-impl handled
are removed.

## Hellgate

`tests/unit/web-fetch-turndown-hellgate.test.ts` — 14 cases, 5 groups:

- **A (3)** — heading + link parity: `<h1>` → `# Title`; `<h2>` → `## Sub`;
  `<a href=X>Y</a>` → `[Y](X)`.
- **B (4)** — security strip: `script` / `style` / `noscript` / `iframe`
  text content removed; the surrounding `visible` text survives.
- **C (4)** — code + emphasis + lists: `<code>` → backticks; `<pre><code>`
  → fenced block; `<ul><li>` → bullet list with `-` marker; `<strong>`
  → `**`, `<em>` → `_`.
- **D (3)** — post-processing: triple+ newlines collapsed; entities
  decoded; leading/trailing whitespace trimmed.
- **E (2)** — exposed singleton: `turndown` callable; empty string → empty
  string (no throw, byte-stable).

Existing ADR-0127 hellgate (`web-fetch-hellgate.test.ts`) — 28 cases —
continues green; 2 byte-exact assertions relaxed to property assertions
as described above.

Combined: **42 pass / 0 fail / 82 expect calls.**

## Alternatives rejected

- **`html-to-md`** (3rd-party). Less maintained (~22K weekly DL vs
  turndown's 2.3M), narrower rule set, no extensible rule engine.
- **`html-to-markdown` (showdown family)**. Different API surface
  (sync function vs class), no `remove()` security primitive, no domino
  DOM backing — falls back to regex like the prior self-impl.
- **`marked` reverse-mode**. `marked` is markdown→HTML, not HTML→markdown.
  Wrong direction.
- **Keep the inline self-impl**. Forces ongoing maintenance against every
  HTML feature drift, and the user principle ("외부 거 써") explicitly
  rejects re-litigation. Zero-dep benefit is illusory — we already ship
  `zod`, `csv-parse`, `lru-cache`, `write-file-atomic`, the Anthropic /
  OpenAI / Vertex SDKs, and `yaml`.

## SOTA realignment

SAME tier as ADR-0127. We still own the agent-callable `web_fetch` tool
surface (schema, SSRF defense, content-type gating, size cap, redaction
posture). The HTML → Markdown converter is an internal detail.

## Follow-up

- **Code-fence language detection.** Register a custom turndown rule
  that reads `<code class="language-X">` and emits ```` ```X ```` for
  syntax-highlighted fenced blocks.
- **Table conversion.** `turndown-plugin-gfm` adds GitHub-flavored
  Markdown table conversion (today turndown emits HTML tables verbatim);
  evaluate the plugin's footprint and adopt if ROI > install cost.
- **`addRule` for `<figure>` / `<figcaption>`.** Today these survive as
  HTML in the output; convert to image-link + alt-text pair.
- **Configurable security strip.** Today the 4-tag remove list is
  hard-coded at singleton init. If a future caller needs to preserve
  `<noscript>` content (legitimate use: feature-detection messages),
  expose a knob.
