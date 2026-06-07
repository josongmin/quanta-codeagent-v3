# ADR-0499: plugin/skill manifest codex-compat INGEST (strict schemas reject real codex artifacts)

- **상태**: Accepted
- **날짜**: 2026-06-07
- **관련**:
  - Ticket: `docs/tickets/misc-jun-7/02-manifest-codex-compat.md`
  - Normalizer (new, pure): `src/skill/manifest-compat.ts` (`normalizePluginManifest` / `normalizeSkillFrontmatter` / frozen `SKILL_KEBAB_RENAME`)
  - Plugin schema: `src/skill/plugin-manifest.ts` (`PluginManifestCompatSchema` `.strip()` + optional `repository`; `parsePluginManifest` knob-gated entry)
  - Skill schema + parser: `src/skill/skill-frontmatter.ts` (`SkillFrontmatterCompatSchema` `.strip()` + conservative defaults; `splitAndCollect` compat-only YAML block-list lookahead)
  - Discovery read-site fix: `src/skill/discover.ts` (`ingestCompatData` — renames kebab before `declaredAllowedTools`)
  - Loader wiring: `src/skill/plugin-loader.ts` (routes through `parsePluginManifest`)
  - Tests: `tests/unit/manifest-codex-compat-hellgate.test.ts` (+ hermetic fixtures `tests/fixtures/manifest-compat/`)
  - Knob: `QUANTA_MANIFEST_COMPAT` (`src/shared/runtime-config.ts` `manifestCompat`, `gateOnStrict` `=== "1"`, default-OFF)
  - Competitor source: Codex 0.135 (`.extracted_source/userdata/codex/plugins/cache/...`, `.../skills/*/SKILL.md`, `.../skill-creator/scripts/quick_validate.py:40`)

## Context

quanta claims "Faithful absorption of the Codex plugin layout" (`plugin-manifest.ts:4`) but its
strict Zod schemas EMPIRICALLY REJECT the real Codex 0.135 artifacts shipped in `.extracted_source`.
Three concrete, artifact-verified rejections:

1. `plugin.json` carries `"skills": "./skills/"` (a STRING directory path) — quanta declares
   `skills: z.array(z.string())` ⇒ `Expected array, received string`.
2. `plugin.json` carries top-level `"repository"` (string URL) — absent from the schema, which is
   `.strict()` ⇒ `Unrecognized key: "repository"`.
3. `SKILL.md` uses kebab `allowed-tools:` (a YAML BLOCK-LIST) and `user-invocable:` — quanta wants
   camel `allowedTools` (array) / `userInvocable` (bool) and is `.strict()`. Worse, `discover.ts`
   reads only `data.allowedTools` (camel), so a kebab `allowed-tools` block-list is SILENTLY DROPPED
   at tool-scoping time — a safety field (the tool allowlist) vanishing without error.

Codex's own validator (`quick_validate.py:40`) fixes the allowed frontmatter set as
`{name, description, license, allowed-tools, metadata}`, bounding exactly what we must accept.

## Decision

A two-layer, SECURITY-gated, read-only INGEST compat path. **The orchestrator's Knobs phase shipped
`QUANTA_MANIFEST_COMPAT` as a `gateOnStrict` (`=== "1"`, default-OFF) knob** — overriding the
ticket's §4.c "no knob / always-on" recommendation. We follow the knob: loosening manifest
validation is a real (if safe-by-construction) loosening, so it is opt-in and DEFAULT-OFF
BYTE-IDENTICAL. Absent the knob, every path is byte-for-byte the pre-ticket behavior (codex
artifacts still REJECT; quanta-native files parse identically).

**Layer 1 — pure normalizer (`manifest-compat.ts`).** A frozen, enumerated `(raw) → normalized`
mapper run BEFORE `safeParse`:
- string `skills` → one-element array (`"./skills/"` → `["./skills/"]`); array `skills` untouched.
- kebab→camel rename of ONLY the two enumerated keys (`SKILL_KEBAB_RENAME` = `{allowed-tools,
  user-invocable}`) — NOT a generic auto-caser (which would silently promote a hostile `evil-grant`
  into a real field). On a kebab/camel COLLISION the native camel WINS and the kebab is dropped.

**Layer 2 — relaxed OUTER schema, strict INNER blocks.** Compat schemas switch the OUTER
`.strict()` → `.strip()` (genuinely-unknown top-level keys are DROPPED, never read downstream), add
an additive optional `repository` (string-URL OR `{url,type?}`), default `userInvocable` to `false`
(conservative: not user-invocable unless declared — a `true` default would auto-expose every codex
skill as a `/slash`), and default the quanta-only `category`/`stability`/`allowedTools` for foreign
ingest (`skill` / `experimental` / `[]` — `[]` grants NO tools, the safe scoping). The
SECURITY-load-bearing INNER blocks stay `.strict()` UNCHANGED: `MCPServerSpecSchema`,
`PluginInterfaceSchema` (`capabilities` enum), `PluginAuthorSchema`, the `allowedTools` element shape
(`z.array(z.string().min(1))`), and the closed `Capability` enum.

The strict `splitAndCollect` parser learns the codex `allowed-tools:` YAML block-list shape via a
compat-only lookahead (mirroring the ADR-0457 nested-map lookahead); the lookahead is never even
called unless the knob is armed. The discovery read-site (`discover.ts`) renames the kebab key before
`declaredAllowedTools`, fixing the silent tool-drop.

## Security invariant

Loosening the OUTER schema CANNOT widen any grant, because every grant-bearing field is an INNER
strict-validated field. Unknown outer keys are `.strip()`-dropped and never interpreted. The
normalizer renames ONLY two enumerated keys; a hostile `extra-tools` / `allow-tools` is stripped. On
a kebab/camel duplicate, native camel wins — a broad kebab `allowed-tools` can NEVER override a
narrow native `allowedTools`. All of this is asserted red-on-injection in the hellgate.

## Consequences

- quanta can now INGEST the real Codex plugin/skill ecosystem (spreadsheets/presentations/documents/
  browser + the rr/rr2/ss skill family) that it TODAY hard-rejects, and the latent tool-scoping
  silent-drop bug is fixed — all gated behind a strict opt-in.
- Default-OFF reproduces the exact current behavior (a worse-but-honest posture than the ticket's
  preferred always-on; chosen because the Knobs phase classified this as a security-relevant
  loosening). Operators opt in with `QUANTA_MANIFEST_COMPAT=1`.

## Deferred (open questions)

- §9.3 write-BACK (emitting codex-shaped files) — out of scope; a separate behavior change.
- §9.4 Claude-specific kebab keys (`hooks`/`apps`) — NOT added speculatively (absent from cached
  codex artifacts; per `no-heuristics-only-validated`, extend the closed map only against a real
  artifact).
- §9.5 `description: |` YAML block-scalars (used by `chronicle/SKILL.md`) — pre-existing parser
  limitation, not introduced here; a likely follow-up.
