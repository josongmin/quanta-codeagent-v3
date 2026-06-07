# Ticket — plugin/skill manifest Codex-compat (ingest real competitor artifacts)

**Date:** 2026-06-07
**Status:** Design (NOT implementation). This ticket proposes seams; it ships no code.
**Gap:** `docs/backlog/jun-7-gap-other-agent.md` §2.1 / §2.2 / §2.4 — gap-class **P2** ("스킬/플러그인 manifest 실제 codex 아티팩트 거부", `gap` table row P2, line 66). Verified jun-07 src grep.
**Slice:** `@/skill` (the two strict schemas + the discovery path) + one new pure normalizer module inside `@/skill`. No new slice required.
**Candidate ADR:** next free **≥ 0497** (0493–0496 are taken; 0493 already cites `.strict()` in `skill-frontmatter.ts:85-88`).
**Default posture:** This is a **LOOSENING of validation**, framed conservatively. The invariant is **byte-identity / no-regression: a manifest that parses today MUST parse identically tomorrow; only previously-REJECTED ones now parse.** Two-part posture:
  1. **Outer relax (safe-by-construction).** Switch the OUTER `PluginManifestSchema` / `SkillFrontmatterSchema` from `.strict()` → `.passthrough()` (or `.strip()`) so unknown TOP-LEVEL keys are **ignored, never interpreted**. KEEP `.strict()` on the security-load-bearing INNER blocks (`interface` capabilities, `mcpServers`, `allowedTools` element shape) so a hostile manifest cannot smuggle privilege through an unknown field. This is NOT knob-gated because "ignore an unknown key" cannot widen any grant.
  2. **Pre-parse normalizer (the actual interop work).** A closed-port normalizer maps kebab→camel (`allowed-tools`→`allowedTools`, `user-invocable`→`userInvocable`), coerces string `skills`→`["./skills/"]`, and surfaces `repository`. Whether the normalizer runs always or behind an OPT-IN compat knob is Open Question §9.1 — recommendation: always-on for read-only INGEST (it only renames/coerces, never grants), no knob.
**Competitor source:** Codex 0.135 (`.extracted_source/userdata/codex/...`, real cached plugins + skills; `_codex-rs-0.135-symbols.txt`).
**ROI:** cost 저, impact 중 (interop / ecosystem leverage). P2 is flagged "비용 저 / interop 고" in the gap table (line 66).

---

## 1. Problem

quanta claims "Codex plugin/skill absorption" but its strict Zod schemas **empirically reject the real Codex artifacts** shipped in `.extracted_source`. Three concrete rejections (each src-verified + artifact-verified):

1. **`plugin.json` string `skills`.** Real Codex `plugin.json` carries `"skills": "./skills/"` — a **string** pointing at a directory. quanta's `PluginManifestSchema` declares `skills: z.array(z.string()).optional()` (`plugin-manifest.ts:106`) ⇒ `safeParse` fails with `Expected array, received string`.
2. **`plugin.json` top-level `repository`.** Real Codex `plugin.json` carries `"repository": "https://github.com/openai/openai"` (string). The schema has no `repository` field and is `.strict()` (`plugin-manifest.ts:109`) ⇒ fails with `Unrecognized key: "repository"`.
3. **`SKILL.md` kebab frontmatter.** Real Codex `SKILL.md` uses `allowed-tools:` (kebab, **YAML block-list** form) and `user-invocable:` (kebab). quanta's `SkillFrontmatterSchema` requires camelCase `allowedTools` (array) and `userInvocable` (boolean) and is `.strict()` (`skill-frontmatter.ts:69, 68, 90`) ⇒ the block-list trips the restricted parser ("empty value" on the bare `allowed-tools:` line) and the camel field is absent. Even if it parsed, `discover.ts:159` reads `data.allowedTools` (camel only), so the kebab tool whitelist is **silently dropped** — a tool-scoping safety field vanishing without error.

**Consequence:** quanta cannot ingest the Codex (and likely Claude) plugin/skill ecosystems as-is. Every real competitor plugin/skill is a hard parse failure or a silent tool-allowlist drop. The "we absorbed Codex's plugin layout" claim (`plugin-manifest.ts:4` "Faithful absorption of the Codex plugin layout") is false at the boundary: we copied the *shape names* but reject the *actual files*.

---

## 2. Current state (src-verified)

**Plugin manifest — `src/skill/plugin-manifest.ts`:**
- `PluginManifestSchema` (`:93-110`) is `.object({...}).strict()` (`:109`). Fields: `name` (kebab/snake regex), `version`, `description`, `author` (strict `PluginAuthorSchema`), `homepage?`, `license`, `keywords[]`, `mcpServers?` (record of strict `MCPServerSpecSchema`), **`skills: z.array(z.string()).optional()`** (`:106`), `interface` (strict `PluginInterfaceSchema`).
- NO `repository` field. NO `policy` / `authentication` fields (gap §2.4 / §2.5, out of this ticket's core but free-riders for the outer relax).
- Inner strict blocks: `MCPServerSpecSchema` (`:39-51`, `.strict()` + refine), `PluginAuthorSchema` (`:56-62`, `.strict()`), `PluginInterfaceSchema` (`:70-87`, `.strict()`, 14 fields incl. `capabilities: z.array(CapabilitySchema)` where `CapabilitySchema = z.enum(["Interactive","Read","Write"])` `:27`).

**Skill frontmatter — `src/skill/skill-frontmatter.ts`:**
- `SkillFrontmatterSchema` (`:61-111`) is `.object({...}).strict()` (`:90`) + `superRefine` (admin-scope invariants).
- `userInvocable: z.boolean()` Required (`:68`); `allowedTools: z.array(z.string().min(1))` Required (`:69`); `category` / `stability` enums; `scope?` / `installState?` / `adminInstalledBy?`.
- ADR-0457 already added the OPTIONAL kebab/open fields `"argument-hint"` (`:83`) and `metadata` (open record, `:84`); ADR-0493 added `"thin-client-dispatch"` (`:88`). So **kebab top-level keys are already modelled one-by-one** — but `allowed-tools` / `user-invocable` are NOT, and `.strict()` (`:90`) rejects them.
- The restricted scalar parser (`splitAndCollect` `:420`, `collectOneFrontmatterLine` `:352`) accepts kebab KEYS (`:369` regex `[A-Za-z][A-Za-z0-9_-]*`) but a bare `allowed-tools:` header with an indented `- Read` block-list trips "indented continuation lines are not supported" (`:365`) unless intercepted — the strict parser has NO general block-list support (only the ADR-0457 nested-map and the ADR-0476 `dependencies:` side-channel).
- The **lenient** parser `frontmatter.ts` (`parseFrontmatter`) DOES support block lists (`:11-13` doc, used by `discover.ts:120 toSkill`) and keeps unknown keys as-is — but `discover.ts:159 declaredAllowedTools(data.allowedTools)` reads the **camel** key only, so a lenient-parsed kebab `allowed-tools` block-list is dropped at scoping time.

**Discovery — `src/skill/discover.ts`:**
- `toSkill` (`:119`) uses the **lenient** `parseFrontmatter` (`:120`), then `declaredAllowedTools(data.allowedTools)` (`:159`). Kebab `allowed-tools` ⇒ `kind:"absent"` ⇒ falls back to legacy `tools:` (also absent for codex) ⇒ skill loads with NO tool scoping. The STRICT `parseSkillMarkdown` (the loud authority) is the one that hard-rejects.

**Competitor validator parity:** Codex's own `quick_validate.py` (`.extracted_source/userdata/codex/skills/.system/skill-creator/scripts/quick_validate.py:40`) defines `allowed_properties = {"name","description","license","allowed-tools","metadata"}` — i.e. Codex's frontmatter SSOT is `allowed-tools` (kebab) + `license`, and `user-invocable` is NOT even in its strict set (it's an extension some skills carry). This bounds exactly what we must accept.

---

## 3. Competitor shapes (verbatim from `.extracted_source`)

### 3.1 Real Codex `plugin.json` (`userdata/codex/plugins/cache/.../.codex-plugin/plugin.json`)

`spreadsheets` (and `presentations`, `documents`, `browser` — same shape):

```json
{
  "name": "spreadsheets",
  "version": "26.521.10419",
  "description": "...",
  "author": { "name": "OpenAI", "email": "support@openai.com", "url": "https://openai.com/" },
  "homepage": "https://openai.com/",
  "repository": "https://github.com/openai/openai",      // ← STRING, top-level, REJECTED today
  "license": "MIT",
  "keywords": ["sheet", "csv", "xlsx", ...],
  "skills": "./skills/",                                  // ← STRING (dir path), NOT array, REJECTED today
  "interface": { "displayName": ..., "capabilities": ["Interactive","Write"], ... }
}
```

Verbatim field shapes that differ from quanta's schema:
- **`skills`**: `string` (a directory path `"./skills/"`), NOT `string[]`. (quanta: `z.array(z.string())`.)
- **`repository`**: top-level `string` URL. (quanta: absent + `.strict()` ⇒ reject.) Note: spec allows it; the cached artifacts use the string form. (Some ecosystems use a `{type,url}` object — accept both: `string | { url: string, type?: string }`.)
- `interface` block (14 fields, incl. `composerIcon?`) is at **parity** with `PluginInterfaceSchema` — the browser plugin omits nothing required and orders `composerIcon`/`logo` differently (order-independent in Zod). So `interface` is fine as-is.
- (Scouting correction: `hooks` / `apps` fields do NOT appear in any cached `plugin.json` — gap §2.4 over-reported them. Only `repository` is real here.)

### 3.2 Real Codex `SKILL.md` frontmatter (`userdata/codex/skills/*/SKILL.md`)

`rr2` (representative of the tool-bearing skills `rr`, `rr2`, `ss`):

```yaml
---
name: rr2
description: ...
argument-hint: "[scope]"          # kebab — already accepted via ADR-0457
user-invocable: true              # ← kebab; quanta wants camel `userInvocable` (Required) — REJECTED today
allowed-tools:                    # ← kebab + YAML BLOCK-LIST form — REJECTED today
  - Read
  - Grep
  - Bash
  - Edit
metadata:                         # already accepted (open record) via ADR-0457
  short-description: ...
---
```

`briefing` / `chronicle` / `.system/skill-creator`: frontmatter is just `name` + `description` (+ optional `metadata`) — these PARSE today (no kebab tool keys), confirming the no-regression target. `chronicle` uses a YAML block-scalar `description: |` — out of scope (already its own limitation), note in Open Questions.

Verbatim shapes that differ:
- **`allowed-tools`**: kebab key, **YAML block-list** (`- Read` lines), maps to quanta's camel `allowedTools: string[]`.
- **`user-invocable`**: kebab boolean, maps to quanta's camel `userInvocable`. NOTE: quanta makes `userInvocable` **Required** (`:68`); codex treats it optional (absent in `briefing`). Compat must default it (recommendation: absent ⇒ `false`, matching the conservative "not user-invocable unless declared" stance).
- Codex's strict allowed set is `{name, description, license, allowed-tools, metadata}` (`quick_validate.py:40`) — `license` is a frontmatter key Codex permits that quanta's strict schema would reject; the outer relax (§4) covers it as ignore-unknown.

---

## 4. Design

Two layers. The outer relax is safe-by-construction (no knob); the normalizer is the interop work.

### 4.a Outer relax: `.strict()` → ignore-unknown on the OUTER schema, KEEP strict inner (security boundary)

- **Plugin:** `PluginManifestSchema` outer `.strict()` (`:109`) → `.passthrough()` (keep unknown keys) OR `.strip()` (drop them). **Recommendation: `.strip()`** — unknown top-level keys are *dropped*, so they can never be read downstream by accident (`.passthrough()` keeps them on the parsed object where a future field-rename could start interpreting them — see §5). `repository` and `skills` are handled by the normalizer (§4.b), not by the relax, so the relax exists purely to tolerate *genuinely unknown* future/foreign keys (`license`-style, `policy`, `authentication`) without a hard error.
- **Skill:** `SkillFrontmatterSchema` outer `.strict()` (`:90`) → `.strip()`. Same rationale. Codex's `license` frontmatter key now ignored, not rejected.
- **KEEP `.strict()` on the security-load-bearing INNER blocks — this is the security crux:**
  - `MCPServerSpecSchema` (`:47`) stays `.strict()` — an MCP server descriptor controls a spawned process; an unknown key here MUST stay a hard error (a typo'd `command`/`url`/`env` is a server-spawn miss or an injection surface).
  - `PluginInterfaceSchema` (`:87`) stays `.strict()` — `capabilities` is the declared-surface enum (`:77`); widening it silently broadens what the plugin claims it can do.
  - `allowedTools` element shape (`:69`) stays `z.array(z.string().min(1))` strict — this is the **tool allowlist**, the single most security-load-bearing field. The normalizer may *rename the key* (kebab→camel) but the VALUE is validated by the unchanged strict inner schema. An unknown/renamed field can NEVER become a tool grant.
  - `CapabilitySchema` enum (`:27`) stays closed.
- **Net invariant:** loosening the OUTER schema cannot widen any grant, because every grant-bearing field is an INNER strict-validated field. Unknown outer keys are *dropped (`.strip()`) and never interpreted*.

### 4.b Pre-parse normalizer (new module `src/skill/manifest-compat.ts`, pure, closed-port)

A pure `(raw: unknown) → normalized: unknown` mapper run **before** `safeParse`, for BOTH plugin manifests and skill frontmatter. Closed set of transforms — anything outside it is left untouched for the (now-relaxed) schema to handle:

- **kebab→camel key rename (skill frontmatter):** an explicit closed map `{ "allowed-tools": "allowedTools", "user-invocable": "userInvocable" }`. NOT a generic kebab→camel auto-caser (that would silently rename a future hostile `evil-grant`→`evilGrant` into a real field — §5). Only the two known interop keys are renamed; everything else is left as-is for `.strip()`. If BOTH the kebab and camel key are present (conflict), the **camel (native) key wins** and the kebab is dropped+logged (a quanta-native file is authoritative over an injected duplicate).
- **string `skills` → array (plugin manifest):** `typeof raw.skills === "string"` ⇒ `[raw.skills]`. (The schema's `skills` is then a 1-element array `["./skills/"]`; discovery already treats it as a path list.) An array `skills` is untouched (no-regression for quanta-native files).
- **`repository` tolerated (plugin manifest):** add `repository: z.union([z.string().url(), z.object({ url: z.string().url(), type: z.string().optional() }).strip()]).optional()` to the schema (so it's *captured*, not just stripped — we may want to surface it). This is an additive optional field; a manifest without it parses byte-identical.
- **`user-invocable` default:** after rename, if `userInvocable` is absent, the normalizer does NOT inject it — instead the schema's `userInvocable` becomes `z.boolean().default(false)` (additive: a file that declares it is unchanged; codex files omitting it default to non-invocable). This is the one schema-shape change beyond `repository`. (Alternative: keep Required and have the normalizer inject `false` — equivalent; schema-default is cleaner and self-documenting.)
- **Block-list `allowed-tools`:** the strict `parseSkillMarkdown` parser must learn the kebab `allowed-tools:` block-list, OR (cheaper) discovery routes codex skills through the LENIENT `frontmatter.ts` parser (which already does block lists) + the normalizer + a `safeParse` against the relaxed schema. **Recommendation: extend `discover.ts` to normalize the lenient-parsed `data` (rename `allowed-tools`→`allowedTools`) so `declaredAllowedTools` at `:159` reads the renamed key** — this fixes the silent-drop at the read site, which is the actual safety bug, with no new block-list parser. The strict `parseSkillMarkdown` path (used by validation tooling) gets the same normalizer pre-pass.

- **Closed-port + ignore-not-interpret:** the normalizer's transform set is a frozen, enumerated list. Unknown fields are NEVER interpreted — they pass through to `.strip()` and are dropped (with a debug log of dropped keys, §5). A plugin CANNOT grant itself a tool/permission via an unknown or creatively-named field, because (a) unknown keys are stripped, (b) only the two enumerated kebab keys are renamed, and (c) all grant-bearing values are validated by unchanged strict inner schemas.

### 4.c Knob (Open Question §9.1 — recommendation: no knob for read-only ingest)

The normalizer only *renames/coerces shape* on INGEST; it never widens a grant, so gating it behind a default-OFF knob buys nothing but a worse default (quanta still rejects real codex files unless the operator flips a flag). **Recommendation: always-on normalizer for read-only ingest, no knob.** If a knob is wanted for caution, `QUANTA_MANIFEST_COMPAT` (default-ON) — but justify default-ON, since default-OFF reproduces the current broken state. (Contrast: write-BACK normalization — emitting codex-shaped files — IS a behavior change and would be knobbed; out of scope, see §9.3.)

---

## 5. Security risk (honest)

Relaxing `.strict()` is a real loosening; being honest about what it can mask and the mitigations:

- **Passthrough can mask typos.** A misspelled `mcpServerss` or `interfac` on a quanta-native manifest used to be a loud error; with the outer relax it's silently ignored. Mitigation: (a) use `.strip()` not `.passthrough()` so the typo'd key is *dropped* (the field it meant to set is then absent → its own Required/refine error fires, OR its optionality means the author notices the missing behavior); (b) **log every dropped/unknown top-level key** at debug so drift is observable (parity with the spirit of `quick_validate.py`'s "Unexpected key(s)" message, downgraded from fatal to logged); (c) keep inner blocks strict so the high-value typos (`command`→`commnd` in an MCP server) STILL hard-fail.
- **Smuggling a field a FUTURE version interprets.** If v(n) ignores `policy` but v(n+1) starts reading it, a manifest that set `policy` under v(n) silently activates behavior under v(n+1). Mitigation: `.strip()` (the field is GONE post-parse, not lurking on the object); and the rule "a new field that grants/controls anything ships as an INNER strict field with its own validation, never read off a passthrough bag."
- **Privilege via unknown/renamed field — the load-bearing threat.** A hostile plugin tries to grant itself tools/permissions it shouldn't. Mitigations, in order: (1) the normalizer renames ONLY the two enumerated kebab keys — a hostile `extra-tools` / `allow-tools` / `allowedToolsExtra` is NOT renamed and is stripped; (2) the tool allowlist VALUE is always validated by the unchanged strict `z.array(z.string().min(1))` — a renamed key still can't carry a non-string or a wildcard the schema rejects; (3) capabilities/MCP stay closed-enum strict. **Unknown fields are IGNORED, never interpreted — that is the whole security contract of this ticket.**
- **kebab/camel duplicate confusion.** A manifest with BOTH `allowed-tools` (broad) and `allowedTools` (narrow) — which wins? Rule: native camel wins, kebab dropped+logged. The hellgate asserts a broad kebab `allowed-tools` CANNOT override a narrow native `allowedTools` to widen the grant.

---

## 6. Files to touch

- `src/skill/manifest-compat.ts` *(new, pure)* — the normalizer: `normalizePluginManifest(raw): unknown` (string `skills`→array; leave `repository` for the schema) + `normalizeSkillFrontmatter(data): Record<...>` (closed kebab→camel rename map; native-wins on conflict; dropped-key log). Slice-pure: no IO, no `process.env`, no clock. Frozen transform table exported for the hellgate.
- `src/skill/plugin-manifest.ts` — outer `.strict()` (`:109`) → `.strip()`; add `repository: z.union([string-url, {url,type?}]).optional()`; leave `skills` as `z.array(z.string()).optional()` (normalizer feeds it an array). Inner `.strict()` on `MCPServerSpecSchema` (`:47`) / `PluginInterfaceSchema` (`:87`) / `PluginAuthorSchema` (`:62`) UNCHANGED.
- `src/skill/skill-frontmatter.ts` — outer `.strict()` (`:90`) → `.strip()`; `userInvocable: z.boolean().default(false)` (`:68`); `allowedTools` element schema (`:69`) UNCHANGED (strict value). The strict `parseSkillMarkdown` (`:577`) runs `normalizeSkillFrontmatter` on `split.rawData` before `safeParse` (`:587`).
- `src/skill/discover.ts` — in `toSkill` (`:119`), run `normalizeSkillFrontmatter(data)` (or read the renamed key) BEFORE `declaredAllowedTools(data.allowedTools)` at `:159`, so a kebab `allowed-tools` block-list (lenient-parsed) is read, not silently dropped. This is the fix for the silent-tool-drop safety bug.
- `src/shared/runtime-config.ts` — IF knobbed (§4.c, not recommended): `QUANTA_MANIFEST_COMPAT` (default-ON) + surface/SSOT manifest entry. Default recommendation: no knob.
- `tools/feature-catalog/features/` (+ `baseline.json`) — register the compat feature in the fc catalog.

---

## 7. Test / hellgate plan

Fixtures are the REAL artifacts already in `.extracted_source` (copied into `tests/fixtures/` so the test is hermetic).

- **Real codex `plugin.json` parses.** `spreadsheets/.../plugin.json` (string `skills`, top-level `repository`) ⇒ `PluginManifestSchema.safeParse(normalizePluginManifest(raw)).success === true`; `skills === ["./skills/"]`; `repository === "https://github.com/openai/openai"`. Same for `browser` (object-or-string repository both accepted).
- **Real codex `SKILL.md` parses + tools captured.** `rr2/SKILL.md` (kebab `allowed-tools` block-list, kebab `user-invocable`) ⇒ frontmatter parses; `allowedTools === ["Read","Grep","Bash","Edit"]` (NOT silently dropped); `userInvocable === true`. `briefing/SKILL.md` (name+description only) parses with `userInvocable === false` (default).
- **No-regression (byte-identity).** Every EXISTING `src/skill/system-skills/*/SKILL.md` (camel `allowedTools` flow-list) parses to the **identical** `SkillFrontmatter` it produces today (snapshot/ratchet). A quanta-native `plugin.json` with array `skills` and no `repository` parses identically. This is the load-bearing invariant: previously-passing inputs unchanged.
- **Hostile grant smuggling — REJECTED / IGNORED (red-on-injection):**
  - frontmatter with an unknown `extra-tools: ["Bash"]` (NOT in the rename map) ⇒ stripped; `allowedTools` reflects ONLY the real declared set; the smuggled tool is NOT granted.
  - frontmatter with a renamed-collision `allowed-tools: ["Read","Grep","Bash","Edit","Write"]` AND native `allowedTools: ["Read"]` ⇒ native wins; effective allowlist is `["Read"]` (broad kebab CANNOT widen narrow native).
  - `plugin.json` with an unknown top-level `capabilities: [...]` (trying to bypass the `interface.capabilities` enum) ⇒ stripped; the inner strict `PluginInterfaceSchema.capabilities` enum is the only capability surface; an unknown enum member there still hard-fails.
  - `mcpServers` entry with an unknown key ⇒ STILL hard-fails (inner `.strict()` unchanged).
- **kebab→camel mapping is EXACT.** Only `allowed-tools`/`user-invocable` rename; `some-other-kebab` does NOT. `argument-hint` (already an accepted optional kebab key, ADR-0457) is NOT clobbered.
- **Dropped-key observability.** A manifest with an unknown key logs it at debug (asserted via the log sink), so drift stays visible.

All injection claims get a red-on-injection regression test (the project's "guard effectiveness" standard).

---

## 8. ROI / cost

- **Cost: 저.** Outer `.strict()`→`.strip()` is a one-token change ×2 + one optional `repository` field + one `.default(false)`. The normalizer is a pure ~50-line closed map. No new parser (reuse the lenient block-list parser for `allowed-tools`). The fixtures already exist in `.extracted_source`.
- **Impact: 중 (interop / ecosystem leverage).** Unlocks ingest of the entire real Codex plugin/skill ecosystem (spreadsheets/presentations/documents/browser + the `rr`/`rr2`/`ss` skill family) that quanta TODAY hard-rejects, and fixes a latent **safety bug** (kebab `allowed-tools` tool-scoping silently dropped at `discover.ts:159`). Turns the "Faithful absorption of the Codex plugin layout" claim from aspirational into actually-true. P2 flagged "비용 저 / interop 고" (gap table line 66).

---

## 9. Open questions (calibrate — no magic)

1. **Knob vs always-relax.** Recommendation §4.c: no knob for read-only ingest (default-OFF reproduces the current broken state, which is a worse default). Confirm we are comfortable shipping the outer relax always-on. If a knob is mandated, it MUST default-ON and the ticket must justify why a CAUTION knob exists for a safe-by-construction change.
2. **Which fields are security-load-bearing (stay strict)?** This ticket fixes the set as: `interface.capabilities` enum, `mcpServers` descriptors, `allowedTools` element shape, `Capability` enum. Is anything else grant-bearing (e.g. a future `permissions` / `policy` block)? Rule going forward: a new grant-bearing field ships as an INNER strict field, never read off the stripped bag. Confirm the set is complete.
3. **Normalize on write-back or read-only ingest?** This ticket is read-only INGEST (rename/coerce on parse). Emitting codex-shaped files (write-back) is a separate behavior change that WOULD be knobbed and is out of scope. Confirm we don't need round-trip fidelity (parse codex → re-emit codex) in v1.
4. **Claude vs Codex shape differences.** This ticket is verified against Codex 0.135 artifacts. Claude plugins/skills may carry additional kebab keys (e.g. `hooks` pointers — the gap §2.4 scouting flagged these but they're ABSENT from cached codex `plugin.json`). Before claiming "Claude compat," grep real Claude plugin/skill artifacts and extend the closed rename map / optional-field set. Do NOT speculatively add `hooks`/`apps` without a real artifact (per `no-heuristics-only-validated`).
5. **`description: |` block scalars.** `chronicle/SKILL.md` uses a YAML block-scalar description — the restricted parser rejects multi-line scalars today (pre-existing limitation, not introduced here). Is block-scalar `description` worth a follow-up, or do we accept it as a known non-ingestible shape? Likely follow-up (several real skills use it).
6. **`user-invocable` default semantics.** Recommendation: absent ⇒ `false` (conservative; not user-invocable unless declared). Codex's own validator doesn't even list `user-invocable` as allowed (`quick_validate.py:40`), so absence is the common case. Confirm `false` (not `true`) is the right default — a `true` default would auto-expose every ingested codex skill as a `/slash` command, which is the riskier choice.
