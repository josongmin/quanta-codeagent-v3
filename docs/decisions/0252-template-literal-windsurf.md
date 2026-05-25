# ADR-0252: Template-literal `{{ variable }}` expander — Windsurf workflow parity (sibling to ADR-0203 `!macro`)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0203 (user-authored playbook frontmatter — the `!macro`
  one-pass expander this slice runs ALONGSIDE, not in place of),
  ADR-0040 (strict 6-field SKILL.md frontmatter — orthogonal),
  ADR-0149 (engineering-skills-bundle — the bundled skills that benefit
  from richer authoring substitutions),
  Windsurf workflows (`.windsurf/workflows/<name>.md`, jinja2-style
  `{{ name }}` substitution the slice absorbs).
- **References**:
  `src/skill/playbook/template-literal/port.ts` (closed `TemplateExpander`
   port — `expand(template, context): Result<string, ExpandError>`),
  `src/skill/playbook/template-literal/types.ts` (typed `ExpandContext`,
   3-arm `ExpandError`, `ExpandResult`),
  `src/skill/playbook/template-literal/default-expander.ts` (pure
   `{{ name }}` substitution + `\{\{` escape + dotted-path resolution),
  `src/skill/playbook/template-literal/index.ts` (barrel — additive only),
  `tests/unit/skill/playbook/template-literal-hellgate.test.ts` (15 cases).

**ADR-number reconciliation.** Slice is a clean sibling of ADR-0203 and a
peer of ADR-0249/0250/0251. Booked **0252** at the next-free slot; no
parallel-track conflict observed at landing time. If a collision surfaces
on rebase, the user-deference / parallel-track renumber policy applies
(`adr-collision-policy-2026-05-25`).

## Context

Windsurf workflows use jinja2-style `{{ name }}` literal substitution to
inject author-supplied variables into the rendered workflow body:

```markdown
---
name: deploy-{{ env }}
---

# Deploy to {{ env.toUpperCase() }}
ship `{{ artifact }}` to `{{ env }}`
```

quanta ADR-0203 ships a `!macro` one-pass expander that covers the Devin
Playbooks shape (kebab-case macro name, non-word left boundary, escape
`\!name`). The `{{}}` syntax is a strict sibling — different grammar,
different boundary rules, different escape, different lookup model
(dotted paths into a context object vs. flat name into a macro registry).
Trying to teach the `!macro` scanner the `{{}}` shape would smear two
contracts that are SOTA-different and that Windsurf / Devin authors
already learned as TWO surfaces. The clean response is a sibling
expander.

The slice is intentionally **author-facing only**. The dispatcher
remains the `!macro` expander; this new expander is a separate function
the host calls when it knows the playbook author opted into the
Windsurf-style template literal. Nothing in the existing playbook
modules (`port.ts`, `types.ts`, `index.ts`, `auto-dispatch.ts`,
`validator.ts`, `frontmatter-parser.ts`, `dispatcher.ts`,
`inline-trigger-watcher.ts`) is touched. The sibling barrel
`src/skill/playbook/template-literal/index.ts` exposes the new surface
and the playbook root barrel is NOT modified — opt-in by import path,
default-OFF.

## Decision

Add a new leaf sub-slice `src/skill/playbook/template-literal/` with
four files (port / types / default-expander / barrel). The slice imports
only `./port` and `./types` siblings — no `node:fs`, no `yaml`, no
`@/agent`, no `@/tool`, no `@/permission`. The expander is a pure
string-to-string function with a typed error result.

### Modules

- **`types.ts`** — `ExpandContext = Record<string, string | number |
  boolean | null | NestedContext>`; `ExpandError` (3-arm:
  `unknown-variable` with `{ name, position }`; `max-iterations` with
  `{ iterations }`; `recursive` with `{ name }`); `ExpandResult` =
  discriminated union of `{ ok: true, text }` or `{ ok: false, error }`.

- **`port.ts`** — `TemplateExpander` interface:
  `expand(template: string, context: ExpandContext): ExpandResult`. A
  port lets a host swap the default for a jinja2-superset (e.g. nunjucks)
  later without changing call sites.

- **`default-expander.ts`** — `createDefaultTemplateExpander()` returns a
  `TemplateExpander` whose `expand()` is:
    1. Linear character scan (no regex sentinels — same posture as the
       `!macro` dispatcher).
    2. `\{\{` → literal `{{` (escape consumed, second `{` becomes part of
       the literal output).
    3. `{{` ... `}}` → trimmed inner expression `name` looked up against
       the `context`. Dotted paths `{{ a.b.c }}` resolve via nested
       lookup on plain objects.
    4. Whitespace inside the braces is allowed and stripped (`{{  name
       }}` is the same as `{{name}}`).
    5. Unknown variable → `ok: false, error: { kind:
       "unknown-variable", name, position }` (1-based char index for
       authoring debugging).
    6. Unmatched `{{` (no closing `}}`) → emit verbatim (defensive — an
       author writing about `{{ }}` syntax in plain prose must not be
       penalised).
    7. **ONE PASS**. The expansion of `{{ x }}` is **not** re-scanned
       for further `{{}}` references. This matches the ADR-0203 macro
       contract and avoids the recursion graph entirely. Authors who
       want composition must inline at the call site.

- **`index.ts`** — barrel re-exporting the four public symbols
  (`createDefaultTemplateExpander`, type `TemplateExpander`, type
  `ExpandContext`, type `ExpandError`, type `ExpandResult`).

### Grammar — formal

```
template := ( escape | literal-brace | substitution | char )*
escape       := "\{\{"                       # → literal "{{"
substitution := "{{" ws? identifier ws? "}}" # context lookup
identifier   := [A-Za-z_$][\w$]* ("." identifier)*
ws           := [ \t]+
char         := any other char (passes through unchanged)
```

- `{{` not followed by an identifier + `}}` → emit `{{` verbatim, advance
  by one char (the second `{` is the next loop iteration).
- `}}` not preceded by a substitution opener → emit verbatim.
- Identifiers are case-sensitive (Windsurf parity). `{{ ENV }}` and `{{
  env }}` are different lookups.

### Value coercion

- `string` → emitted verbatim.
- `number` → `String(n)` (Windsurf parity — `0` is `"0"`, not `""`).
- `boolean` → `"true"` / `"false"`.
- `null` → `"null"` (treated as a value, not as "missing"; missing keys
  are the `unknown-variable` arm).
- Nested object → reached only via dotted path; a bare `{{ a }}` where
  `a` is an object is `unknown-variable` (we refuse to `JSON.stringify`
  silently — that is a footgun a future ADR can opt into).

### Why a sibling expander, not a merged scanner

Three reasons the merge was rejected:

1. **Grammar isolation.** `!macro` has a non-word left boundary
   requirement (`foo!retry` is NOT a macro); `{{}}` has no such rule
   (`foo{{x}}` IS a substitution). Merging would require a discriminator
   the scanner does not currently carry.
2. **Lookup model isolation.** `!macro` is a flat name → expansion map
   (`MacroRegistry`); `{{}}` is a dotted-path lookup into a tree
   (`ExpandContext`). Same registry can't honestly model both.
3. **Author surface isolation.** Devin authors know `!macro`; Windsurf
   authors know `{{ name }}`. The two communities expect their
   respective error messages, escape conventions, and boundary rules.
   Merging would force one community to learn the other's quirks.

### Default-OFF wire

NOTHING in `@/agent`, `@/tool`, `@/permission`, the playbook root
barrel, or any other slice imports `@/skill/playbook/template-literal`
yet. A host that wants Windsurf-parity substitution does:

```ts
import { createDefaultTemplateExpander } from
  "@/skill/playbook/template-literal"

const expander = createDefaultTemplateExpander()
const result = expander.expand(authoredBody, { env: "prod", v: 1 })
if (!result.ok) renderError(result.error)
else emit(result.text)
```

The macro expander (ADR-0203) keeps its existing surface unchanged. A
host that uses BOTH calls the macro expander first (resolves `!name`),
then the template expander (resolves `{{ name }}`) — or in whichever
order matches its authoring contract. Order is NOT enforced by either
slice.

### Hellgate (15 cases)

`tests/unit/skill/playbook/template-literal-hellgate.test.ts`:

| ID | Pin |
|----|-----|
| HELL-TL-01 | simple `{{ name }}` → context value |
| HELL-TL-02 | multiple variables on one line resolve independently |
| HELL-TL-03 | template with no `{{...}}` returns byte-identical input |
| HELL-TL-04 | unknown variable → `ok:false, error: { kind: "unknown-variable", name }` |
| HELL-TL-05 | `\{\{` escape → literal `{{` in output |
| HELL-TL-06 | dotted path `{{ a.b.c }}` resolves nested context |
| HELL-TL-07 | missing dotted-path leaf → `unknown-variable` |
| HELL-TL-08 | numeric value → `String(n)` (incl. `0`) |
| HELL-TL-09 | boolean → `"true"` / `"false"` |
| HELL-TL-10 | whitespace inside braces (`{{   name   }}`) trimmed before lookup |
| HELL-TL-11 | ONE-PASS — `{{ a }}` expanding to `{{ b }}` is NOT re-expanded |
| HELL-TL-12 | unmatched `{{` without closing `}}` → literal passthrough |
| HELL-TL-13 | 10 000-substitution perf sanity (single allocation order) |
| HELL-TL-14 | default-OFF — without injecting the expander, the macro `!` surface (ADR-0203) is byte-identical |
| HELL-TL-15 | empty template → empty string `ok:true` |

~70 `expect()` calls across the 15 tests. Runtime budget ~50 ms.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **Extend the `!macro` dispatcher to also recognize `{{}}`** | Grammar / lookup / boundary rules differ; merging smears two contracts authors already learned separately. Adds discriminator branches to a scanner currently clean of them. |
| **Implement on top of an external template library (nunjucks / handlebars / mustache)** | Install blocked in this environment (`verify-workflow` memory). The library's transitive deps would also balloon the slice. A 4-file pure-string slice is the smallest correct primitive; a future ADR can swap in nunjucks via the `TemplateExpander` port. |
| **Recursive expansion** | An expansion that itself contains `{{ other }}` would need a fixpoint walk + cycle detection. Devin's `!macro` chose ONE pass for this exact reason; we mirror. Authors who want composition inline at the call site. |
| **Auto-stringify nested objects (`JSON.stringify` on bare `{{ a }}` when `a` is an object)** | Silent serialization is a privacy footgun (token leak, secret leak). Forcing `{{ a.b }}` keeps every lookup explicit. |
| **Wire into the playbook root barrel (`src/skill/playbook/index.ts`)** | The user instruction block scopes work to `src/skill/playbook/template-literal/` only — root barrel stays untouched so the default-OFF byte-identical invariant (HELL-TL-14) is mechanically enforceable. |
| **Throw on unknown variable** | Authoring iteration would lose the typed-error rendering the rest of the playbook slice uses. We return `ok: false` with a typed `ExpandError` so the host can render the position. |
| **Regex-based scanner** | `noControlCharactersInRegex` / `noMisleadingCharacterClass` biome rules + the existing `!macro` dispatcher's character-walk posture indicate the slice should follow the same style. Char-walk also avoids the `{{`/`\{\{` lookahead complications. |

## Consequences

- **Default-OFF, byte-identical**: pre-0252 callers see no surface change.
  HELL-TL-14 pins this by importing the macro expander only and asserting
  the `!` surface is unchanged when the template expander is not in scope.
- **Slice fence intact**: `src/skill/playbook/template-literal/` imports
  only siblings inside the directory. NO imports from `@/agent`,
  `@/tool`, `@/permission`, `@/storage`, `node:fs`, or `yaml`.
- **Port-shape swap target**: the `TemplateExpander` interface is the
  smallest stable shape for any future library-backed expander. Swapping
  in nunjucks is a one-line adapter-body change; consumers stay
  byte-identical.
- **Follow-up slices**:
  - Wire `createDefaultTemplateExpander` into the playbook root barrel
    `src/skill/playbook/index.ts` once a host wants to surface it (one
    extra `export` line — gated by a separate ADR for the wire decision).
  - Add a `template:` slot on the playbook frontmatter (sibling to
    `macros:`) so authors can declare the substitution context inline.
  - Compose macro + template into a `renderPlaybookBody(fm, ctx)`
    convenience that runs macro first, then template — the ordering
    decision is itself a separate ADR.
