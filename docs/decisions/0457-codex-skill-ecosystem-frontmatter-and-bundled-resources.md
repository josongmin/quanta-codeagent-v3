# ADR-0457 — codex skill ECOSYSTEM frontmatter (argument-hint / metadata) + bundled resources

**Status:** Accepted (2026-06-03)
**Type:** Competitor-absorption slice (codex skill ecosystem completeness).
**Scope:** `src/skill/` only —
`types.ts` (new `SkillAgentInterface` / `SkillResources` types + 3 optional
`Skill` fields), `frontmatter.ts` (lenient parser: nested-map capture),
`skill-frontmatter.ts` (strict parser + Zod schema: kebab keys + nested
`metadata:` block), `skill-resources.ts` (NEW — bundled-resource walker +
minimal `agents/openai.yaml` interface parser), `discover.ts` (wire A+B+C into
discovery), `skill-tool.ts` (listing render surfaces the new fields),
`index.ts` (re-exports) — plus its hellgate
`tests/unit/skill-ecosystem-frontmatter-hellgate.test.ts`. No other files
touched. Additive, no env gate, no new dependency.

ADR-number note: 0455 was the highest existing decision in this worktree's base
(`25462831`); a concurrently-active sibling session holds 0456. This slice took
the next clearly-free number, 0457.

## Context

A gap audit against codex's on-disk skill ecosystem
(`.extracted_source/userdata/codex/skills/`) found that quanta's skill CORE is
already AHEAD of codex (7-scope tiering ADR-0134, playbook frontmatter ADR-0203,
ReDoS-hardened glob activation, admin-install policy, a strict loud-failure
frontmatter parser). What was missing was ECOSYSTEM completeness — three small,
purely-additive surfaces codex skills ship that quanta silently dropped:

- **A. `argument-hint`** (e.g. `argument-hint: "[scope]"`) — a usage hint shown
  after the skill name in a listing (`rr [scope]`). codex's `rr` / `ss` / `rr2`
  all declare it. quanta's strict schema is `.strict()` and its strict text
  parser only accepted `[A-Za-z][A-Za-z0-9_]*` keys, so a kebab key would be
  rejected; the lenient discovery parser dropped it as an unread key.
- **B. `metadata.short-description`** — a guaranteed-short UI blurb codex authors
  declare under a nested `metadata:` block (`rr2` has it). Neither quanta parser
  captured one level of nesting, and the strict schema had no `metadata` field.
- **C. bundled resources** — codex's skill-creator establishes sibling dirs next
  to `SKILL.md`: `agents/openai.yaml` (UI/harness metadata), `scripts/`
  (executable automation), `references/` (on-demand docs), `assets/` (output
  files). quanta discovery recorded none of them.

## Decision

All three are absorbed as **OPTIONAL / additive** surfaces. A SKILL.md that
declares none of them parses and renders byte-identical to pre-0457.

### A. `argument-hint`
- `Skill.argumentHint?: string` (new optional field).
- Lenient parser (`frontmatter.ts`) already keeps unknown flat keys; the kebab
  key `argument-hint` is read in `discover.ts` via `data["argument-hint"]`.
- Strict parser (`skill-frontmatter.ts`): the top-level key regex now allows
  `-` (`[A-Za-z][A-Za-z0-9_-]*`), and the Zod schema gains
  `"argument-hint": z.string().min(1).optional()` so `.strict()` ACCEPTS it
  (previously rejected).
- Listing render: `skillCatalogueRow` (extracted from `createSkillTool`) emits
  `- <name> <argumentHint>: <blurb>` → `- rr [scope]: …`.

### B. `metadata.short-description`
- `Skill.shortDescription?: string` (new optional field).
- Lenient parser gains ONE level of nested-map capture: an empty-value `key:`
  followed by indented `child: scalar` lines is stored as the flat dotted key
  `key.child` (so the `Record<string, string | string[]>` data shape is
  unchanged). `discover.ts` reads `data["metadata.short-description"]`.
- Strict parser captures the same nested block (via a non-throwing lookahead
  that only opens a nested-map parent when the next content line is an indented
  child) into a real `Record<string, string>`, and the schema gains
  `metadata: z.record(z.string(), z.unknown()).optional()`.
- Listing render PREFERS `shortDescription` over the (potentially long)
  `description` when present.

### C. bundled resources (`skill-resources.ts`, NEW)
- `Skill.resources?: SkillResources` with
  `{ agentsYaml?: SkillAgentInterface; scripts?; references?; assets? }`.
- `discoverSkillResources(skillMdPath)` walks the four sibling dirs of a
  directory-form skill. `scripts` / `references` / `assets` record direct
  file-name lists ONLY (sorted, presence-based). Their CONTENTS are NOT loaded
  into model context — on-demand only (the skill body reads them via the normal
  read tool when its instructions say to). Token discipline is the whole point.
- `agents/openai.yaml` is parsed by a tiny hand-rolled `interface:`-block parser
  (`parseOpenaiYamlInterface`) into `SkillAgentInterface`
  (`displayName`/`shortDescription`/`defaultPrompt`/`iconSmall`/`iconLarge`/
  `brandColor`). NO yaml dependency is added: the file has no `---` fence so the
  two SKILL.md frontmatter parsers do not apply, and only the small, known
  shape is handled (other blocks like `dependencies:` / `policy:` are ignored).

## Consistency & fail-safety (the load-bearing invariants)

- **Strict + lenient stay consistent.** Both parse paths expose `argument-hint`
  and `metadata.short-description` from the SAME codex SKILL.md (proven by a
  cross-path hellgate test). The strict parser keeps its loud-failure posture:
  a genuinely-empty top-level scalar still fails with "empty value", and a
  non-string nested child is rejected. The nested-map lookahead NEVER turns a
  previously-failing input into a silent success — it only fires when an
  indented child actually follows.
- **Discovery never crashes on a malformed bundled resource.** Every resource
  read/parse is wrapped in a swallow that omits just that resource (mirroring
  the pre-existing fail-safe discovery posture for oversized / unreadable
  SKILL.md). A garbage `agents/openai.yaml` ⇒ `resources.agentsYaml` omitted,
  the skill itself still discovered.
- **Byte-identical regression anchor.** A plain SKILL.md yields no new keys, no
  new `Skill` fields, and the exact pre-0457 listing row `- name: description`.

## Consequences

- The codex `rr` / `ss` / `rr2` skills (modulo their block-list `allowed-tools`,
  which is a separate CORE-parser concern out of scope here) now surface their
  `argument-hint` and `short-description` in quanta's listing.
- A future GUI surface can consume `Skill.resources.agentsYaml` (icons, brand
  color, default prompt) without re-parsing on-disk yaml.

## Deferred (honest)

- **Block-list `allowed-tools:` in the STRICT parser.** codex's real SKILL.md
  files declare tools as a YAML block list; the strict parser supports flow
  lists only (`["Read"]`). This predates 0457 and is intentionally unchanged —
  discovery (lenient) already accepts both forms.
- **`scripts/` execution.** Presence + names are recorded; nothing runs them. An
  install-time/automation seam to execute `scripts/` is future work.
- **Icons / brand color in a GUI surface.** `agentsYaml.iconSmall/iconLarge/
  brandColor` are parsed but no surface renders them yet (CLI has no chip UI).
- **`dependencies:` / `policy:` blocks of `agents/openai.yaml`.** Parsed-around
  (ignored) for now; only the `interface:` block is consumed.
