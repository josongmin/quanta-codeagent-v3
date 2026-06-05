# RFC — N4: Skill/Plugin Authoring Tools (SOTA++)

> Status: DESIGN (not implemented). Date: 2026-06-04. Scope: a way for the AGENT
> to author new skills/plugins programmatically — scaffold a `SKILL.md` +
> frontmatter, validate it against the REAL strict schema, and install it into a
> skills directory — so the agent can extend its own capability surface.
>
> **This is a self-modification feature.** An installed skill is text the agent
> then loads and follows, and its `allowedTools:` advise the host's enforcement
> seam. Authoring + installing a skill therefore changes the agent's behaviour
> and (advisorily) its tool surface. The security spine of this RFC is the
> trust-gate + non-escalation invariant in §8. Read that first.

---

## 1. 요약 (Summary)

quanta already has a complete skill/plugin *consumption* stack: a strict
frontmatter parser/validator (`src/skill/skill-frontmatter.ts`), multi-source
discovery + precedence (`src/skill/discover.ts`, `src/skill/registry.ts`), an
admin-policy install-enforcement decision layer
(`src/skill/install-enforcement.ts`), a strict plugin-manifest schema
(`src/skill/plugin-manifest.ts`), and DXT plugin isolation
(`src/plugin-isolation/`). What is **absent** is any *authoring* path exposed to
the agent: grep confirms there is NO `skill_create` / `skill_validate` /
`skill_install` tool and no `skill-creator` system skill (only
`createSkillTool` = the runtime `Skill` *invocation* tool —
`src/skill/skill-tool.ts:97`).

This RFC proposes a thin authoring slice that REUSES every existing validator
and writer-adjacent invariant rather than re-deriving them:

1. `skill_scaffold` — emit a template `SKILL.md` (+ optional resource dirs) into
   a *staging* buffer, never directly to a live skills dir.
2. `skill_validate` — run the staged content through the real
   `parseSkillMarkdown` strict parser (`src/skill/skill-frontmatter.ts:573`) and
   the size cap (`src/skill/skill-size.ts`), returning the exact line-numbered
   error.
3. `skill_install` — write a validated skill into a **jailed** skills directory
   (`<home>/.quanta/skills/<name>/SKILL.md` or `<repo>/.quanta/skills/...`),
   gated through `decideInstall` (`src/skill/install-enforcement.ts:117`) and a
   trust/confirmation gate.

Plus a `plugin_scaffold` variant emitting `.quanta-plugin/plugin.json`
(`src/skill/plugin-manifest.ts`). Default-OFF, trust-gated, fully fenced to
`@/skill` + a tiny `@/tool` factory.

**Decision (security):** authoring tools are **default-OFF** behind
`QUANTA_SKILL_AUTHORING`. `skill_install` is a **mutating, HITL `ask`-tier**
tool that (a) is jailed to the canonical skills roots, (b) routes through
`decideInstall` so admin `bannedSkills` / scope policy still apply, (c) **MUST
NOT** install a skill whose `allowedTools:` exceed the *installing turn's* own
permitted tool surface (non-escalation invariant), and (d) requires explicit
user confirmation for any non-`personal` scope. Scaffold + validate are
read-only/in-memory and carry lower gating. See §8.

---

## 2. 경쟁사 레퍼런스 — Codex 3390 creator skills (verified, read on disk)

Three preinstalled system skills under
`.extracted_source/userdata/codex/skills/.system/`. All three were read
verbatim; the workflow + on-disk shapes below are extracted, not inferred.

### 2.1 `skill-creator/SKILL.md` (verified)
A *guidance* skill (text instructions + bundled `scripts/`), not a tool. Key
extracted points:
- **Anatomy** (lines 56–73): `skill-name/SKILL.md` (required) + optional
  `agents/openai.yaml` (UI metadata) + `scripts/` / `references/` / `assets/`.
- **Frontmatter is minimal**: only `name` + `description` are read for
  triggering (lines 79, 346–356). "Do not include any other fields in YAML
  frontmatter." `metadata.short-description` is the one extra they allow.
- **6-step process** (lines 223–234): understand → plan resources → `init_skill.py`
  (scaffold) → edit → `quick_validate.py` (validate) → iterate/forward-test.
- **Scaffold script** `scripts/init_skill.py <name> --path <dir> [--resources …]`
  (lines 296–318): creates the dir, a `SKILL.md` with TODO placeholders, optional
  `agents/openai.yaml`, optional resource dirs.
- **Validate script** `scripts/quick_validate.py <path>` (lines 362–370):
  "checks YAML frontmatter format, required fields, and naming rules." Validation
  is a hard gate; on failure, fix and re-run.
- **Naming rules** (lines 236–243): lowercase + digits + hyphens, normalize to
  hyphen-case, ≤64 chars, folder named exactly after the skill.
- **Install location default** (lines 256, 292): `$CODEX_HOME/skills` else
  `~/.codex/skills` — auto-discovered.

### 2.2 `skill-installer/SKILL.md` (verified)
- Installs skills into `$CODEX_HOME/skills/<name>` from a curated GitHub list or
  arbitrary repo path (lines 39–51).
- **Aborts if the destination skill dir already exists** (line 47) — no silent
  overwrite. `--force`/overwrite only for `.system` skills if the user insists.
- Network scripts require sandbox escalation (line 34) → security touchpoint.
- After install: "Restart Codex to pick up new skills" (line 31) — install ≠
  hot-reload.

### 2.3 `plugin-creator/SKILL.md` (verified)
- Scaffolds `<parent>/<plugin-name>/.codex-plugin/plugin.json` (lines 50–51) via
  `scripts/create_basic_plugin.py <name> [--with-skills --with-hooks --with-mcp
  --with-apps --with-marketplace …]` (lines 38–43).
- Manifest filled with **placeholders** (`[TODO: …]`) kept until a human fills
  them (line 141) — author-time scaffolding never auto-commits real values.
- Optional companions: `skills/`, `hooks/`, `scripts/`, `assets/`, `.mcp.json`,
  `.app.json` (lines 60–66).
- `.agents/plugins/marketplace.json` entries carry `policy.installation`
  (`NOT_AVAILABLE`/`AVAILABLE`/`INSTALLED_BY_DEFAULT`) + `policy.authentication`
  (`ON_INSTALL`/`ON_USE`) + `category` (lines 76–91). This is Codex's
  install-policy axis; quanta's analogue is `decideInstall` + admin-policy.

**Extracted pattern (the part we adopt):** scaffold → validate-as-hard-gate →
install-to-discovery-dir, with naming normalization and **abort-on-existing**.
**The part we DON'T adopt as-is:** Codex ships these as *guidance skills that
shell out to Python scripts*. quanta's posture is harness-enforced typed tools
(`agent-loop-4way-comparison`), so we model authoring as first-class tools whose
validation is the SAME strict TS parser the runtime uses — no second validator
that can drift from the loader (the `feature-catalog`/`tool-surface` drift-guard
philosophy, `src/tool/surface/manifest.ts:14`).

---

## 3. 현재 quanta 상태 (grep-verified)

### 3.1 Skill infra EXISTS
- **Strict frontmatter schema + parser** (the authoring SSOT):
  `src/skill/skill-frontmatter.ts`. `SkillFrontmatterSchema`
  (`:61`) is `z.object({…}).strict().superRefine(…)` with fields:
  `name` (kebab `^[a-z0-9][a-z0-9-]*$`, `:66`), `description` (`:69`),
  `userInvocable: z.boolean()` (`:67`), `allowedTools: z.array(string)` (`:69`),
  `category: 'skill'|'extension'` (`:30`), `stability:
  'experimental'|'stable'|'deprecated'` (`:33`), optional `scope` /
  `installState` / `adminInstalledBy` (`:74–76`), optional codex-ecosystem
  `argument-hint` + `metadata` record (`:83–84`). `parseSkillMarkdown(content)`
  (`:573`) returns a discriminated `ParseResult` with a 1-based
  `FrontmatterParseError.line` (`:110`). This is the validator the authoring
  tool MUST reuse — there must be exactly one frontmatter authority.
- **Lenient discovery parser** (separate, by design):
  `src/skill/frontmatter.ts` `parseFrontmatter` (`:168`) — used by discovery; it
  is deliberately lenient (`:50` comment). Authoring must validate against the
  STRICT one, not this.
- **Discovery + load**: `src/skill/discover.ts` `discoverSkills(dir)` (`:269`)
  scans `<dir>/<name>/SKILL.md` (dir form, `:206`) + flat `<name>.md`
  (`:232`), applies the 30 MB size cap (`src/skill/skill-size.ts`,
  `MAX_SKILL_SIZE_BYTES = 30*1024*1024`, `:23`), infers scope from path
  (`inferScopeFromPath`, `:72`), returns sorted `Skill[]`. `buildSkillRegistry`
  (`src/skill/registry.ts:228`) merges 7 sources by precedence.
- **Install-enforcement decision layer**: `src/skill/install-enforcement.ts`
  `decideInstall(attempt, policy)` (`:117`) — pure (policy, attempt)⇒outcome:
  banned-skill DENY, admin-scope requires `org-policy.json`, disable-protection
  for admin-required. `auditEvent` discriminator drives the audit log. **This is
  the exact seam `skill_install` routes through.**
- **Skills dirs (where install writes)**: `defaultSkillSources`
  (`src/skill/registry.ts:61`): admin=`<orgConfigDir>/admin-skills`,
  repo=`<repoRoot>/.quanta/skills`, team=`<repoRoot>/.team-skills`,
  user=`<homeDir>/.quanta/skills`, personal=`<homeDir>/.quanta/personal-skills`,
  system=bundled. These are the only legal install targets (the jail allowlist).
- **Plugin manifest schema**: `src/skill/plugin-manifest.ts`
  `PluginManifestSchema` (`:93`, `.strict()`), `PluginInterfaceSchema` (`:70`),
  `MCPServerSpecSchema` (`:39`), canonical layout constants
  `PLUGIN_DIR_NAME = ".quanta-plugin"` / `PLUGIN_MANIFEST_FILE = "plugin.json"`
  / `PLUGIN_MCP_FILE = ".mcp.json"` / `PLUGIN_SKILLS_DIR = "skills"` (`:123–126`).
  Note: quanta renamed `.codex-plugin/` → `.quanta-plugin/` deliberately
  ("no foreign brand in paths", `:12`).
- **DXT plugin isolation**: `src/plugin-isolation/` (dxt-loader, plugin-host,
  lifecycle, bun-spawner). Out of scope to author here; a `plugin_scaffold`
  produces the manifest, not the isolation runtime.
- **System-skill bundling pattern** (the template for a `skill-creator` system
  skill, should we pick that option): `src/skill/system-skills/<name>/SKILL.md`
  + `index.ts`, discovered via `discoverSystemSkills()` /
  `systemSkillsDir()` (`src/skill/system-skills/index.ts`).

### 3.2 Authoring ABSENT (grep-verified)
- `grep -rn "skill_create|skill_install|skill_validate|scaffold|createSkill|
  installSkill"` over `src/**` returns ZERO authoring tools. Every `createSkill*`
  hit is the runtime invocation tool (`createSkillTool`,
  `src/skill/skill-tool.ts:97`) or resolver factories
  (`createSkillResolver`, `createSkillOnlyResolver`) — none author/write skills.
- No `skill`/authoring row exists in the tool-surface manifest
  (`src/tool/surface/manifest.ts`); `grep -n skill` on it returns nothing. The
  agent cannot author a skill today.

### 3.3 Tool-surface registration contract (how a new tool must land)
`src/tool/surface/manifest.ts` is the LLM-tool-access SSOT (`:1–47`). A
two-way drift guard (`tests/unit/tool-surface-manifest-hellgate.test.ts`)
asserts every registered tool name appears here and every manifest row is a real
tool. So adding `skill_scaffold`/`skill_validate`/`skill_install` REQUIRES a
manifest row each, with a `gate` (`env-flag` / `config-slot`, `:64–67`), a
per-surface `default` (`:78`), and a `risk` class (`:82`,
`meta`/`mutating`). New gated tools land default-OFF (`opt-in`) on bench for
reproducibility.

---

## 4. 설계 (Design)

Three tools (the SOTA++ choice) + one system guidance skill (Codex-parity, cheap
to add later). The tools are first-class because quanta's philosophy is
harness-enforced typed tools whose validation == the runtime validator.

### 4.1 New slice `src/skill/authoring/` (fenced to `@/skill`)
Pure helpers; NO tool/ctx imports (leaf-slice rule, mirrors discovery slice
fences). Files:
- `scaffold.ts` — `buildSkillScaffold(spec) → { path, files: Record<string,
  string> }`. Emits a `SKILL.md` whose frontmatter is generated from a
  validated `ScaffoldSpec` and serialized to the SAME strict subset
  `skill-frontmatter.ts` accepts (kebab `name`, `description`, `userInvocable`,
  `allowedTools`, `category`, `stability`). Optional empty `scripts/` /
  `references/` / `assets/` markers. Name normalization mirrors Codex (lowercase,
  hyphen-case, ≤64) and MUST satisfy the schema regex before emit.
- `validate.ts` — `validateSkillSource(content) → ParseResult<…>`: a THIN
  delegate to `parseSkillMarkdown` (`skill-frontmatter.ts:573`) PLUS the size
  cap (`skill-size.ts`) PLUS a non-escalation check hook (§4.4). It returns the
  line-numbered error verbatim. **No new validation logic** — single authority.
- `install.ts` — `planSkillInstall(spec) → InstallPlan` is the PURE part (target
  dir resolution against the §4.3 allowlist + abort-on-existing decision +
  `decideInstall` call). The actual `writeFile`/`mkdir` lives behind a small
  injected `SkillWriterPort` so the slice stays fs-free + testable (mirrors the
  `discoverSkillSourcesIn` closed-port pattern, `registry.ts:141`).
- `plugin-scaffold.ts` — `buildPluginScaffold(spec)` emitting
  `.quanta-plugin/plugin.json` validated against `PluginManifestSchema`
  (`plugin-manifest.ts:93`) with `[TODO: …]` placeholders for human-required
  fields (URLs, brand) — Codex `plugin-creator` parity.

### 4.2 Tool factories `src/tool/skill-authoring-tool.ts` (in `@/tool`)
- `skill_scaffold` — input `{ name, description, allowedTools?, category?,
  stability?, userInvocable?, resources? }`. Returns the scaffolded
  `SKILL.md` text (+ resource layout) as `output`. **`isReadOnly: () => true`**
  (in-memory; writes nothing). `risk: "meta"`.
- `skill_validate` — input `{ content }` (or a staging handle). Runs
  `validateSkillSource`; on failure returns `parse error (line N): …`. **Read-
  only.** `risk: "meta"`. This is the hard gate authors iterate against.
- `skill_install` — input `{ name, content, scope? }`. Validates (re-runs the
  validator — never trusts a prior `skill_validate`), resolves the jailed
  target, runs `decideInstall`, runs the non-escalation check, then writes via
  `SkillWriterPort`. **`isReadOnly: () => false`**, **`hitlTier: () =>
  "ask"`** (`src/tool/types.ts:976`) so the dispatch HITL gate prompts the
  user. `risk: "mutating"`.
- `plugin_scaffold` — analogous to `skill_scaffold`, emits the manifest;
  read-only/in-memory. A `plugin_install` is deliberately deferred (DXT
  isolation wiring is a separate, heavier surface — §8 alternatives).

### 4.3 Install jail (where install writes)
The ONLY legal targets are the canonical roots from `defaultSkillSources`
(`registry.ts:61`), resolved at the composition root and passed in (the slice
never reads env directly):
- default / unprivileged: `personal` = `<homeDir>/.quanta/personal-skills/<name>/`
- explicit user opt: `user` = `<homeDir>/.quanta/skills/<name>/`
- `repo` = `<repoRoot>/.quanta/skills/<name>/` (team-visible → confirmation)
- `admin` / `team` / `system` are **NOT** agent-writable from this tool (admin
  install is a human/org-policy action via `decideInstall`'s admin branch).

The resolved path is checked with the existing path-jail helper (`is-path-inside`
/ the `@/shared/runtime-config` jail used across the codebase) so a crafted
`name` containing `../` or an absolute path cannot escape the chosen root.
`name` is independently re-validated against the kebab regex before becoming a
path segment. **Abort-on-existing** by default (Codex parity,
`skill-installer:47`); overwrite requires an explicit `overwrite: true` + a
second confirmation.

### 4.4 Non-escalation invariant (the core safety check, §8)
`skill_install` MUST reject a skill whose declared `allowedTools:` is a SUPERSET
of the *installing turn's* permitted tool surface. Rationale: the agent could
otherwise author a skill that, once invoked, advises the host to grant tools the
current turn never had — a self-granted privilege escalation. The check:
`installedAllowedTools ⊆ currentTurnPermittedTools`. The current permitted set
is read from the dispatch context the host passes into the tool (the same
authority `skillToolAllowlist` feeds, `skill-tool.ts:19`). On violation → DENY
with the offending tool names. (Today `allowedTools` is advisory at the loader,
`skill-tool.ts:56–66`; this RFC does NOT change that, but it DOES forbid the
agent from *minting* a higher-privilege advisory than it currently holds.)

### 4.5 Reuse map (no re-derivation)
| Need | Reused from |
|---|---|
| Frontmatter validation | `parseSkillMarkdown` (`skill-frontmatter.ts:573`) |
| Schema (fields/regex/enums) | `SkillFrontmatterSchema` (`:61`) |
| Size cap | `MAX_SKILL_SIZE_BYTES` (`skill-size.ts:23`) |
| Install policy / banned / admin | `decideInstall` (`install-enforcement.ts:117`) |
| Install dirs (jail allowlist) | `defaultSkillSources` (`registry.ts:61`) |
| Plugin manifest schema | `PluginManifestSchema` (`plugin-manifest.ts:93`) |
| Plugin layout constants | `PLUGIN_DIR_NAME` … (`plugin-manifest.ts:123`) |
| Audit trail | `decideInstall.auditEvent` → existing `src/skill/audit-log.ts` |

---

## 5. 통합 (Integration)

- **Default-OFF + trust-gated.** All three tools registered only when
  `QUANTA_SKILL_AUTHORING` is set (gate `env-flag`, `manifest.ts:64`).
  `skill_install` additionally requires the host's HITL gate to be enabled to
  honour its `ask` tier; if HITL is off, `skill_install` falls back to DENY for
  any non-`personal` scope (fail-closed).
- **Tool-surface manifest rows** (REQUIRED — drift guard, `manifest.ts:14`):
  add `skill_scaffold` (`risk: meta`, default `opt-in` everywhere),
  `skill_validate` (`risk: meta`, `opt-in`), `skill_install` (`risk: mutating`,
  `opt-in` everywhere — never default-ON), `plugin_scaffold` (`risk: meta`,
  `opt-in`). All carry `gate: { kind: "env-flag", env: "QUANTA_SKILL_AUTHORING" }`
  and an `adr:` ref (this RFC's ADR number when filed).
- **Feature catalog** (`tools/feature-catalog/`, fc axis): one fc entry
  "skill/plugin authoring" with reachability pointing at the
  `src/tool/skill-authoring-tool.ts` factory + `src/skill/authoring/` slice.
- **Wiring**: the composition root (`@/host/runtime/agent-config-assembler`,
  per `manifest.ts:8`) constructs the tools with the resolved skills roots +
  the `SkillWriterPort` + the admin policy (already loaded for
  `decideInstall`). Behind the env gate, so off by default on every surface.
- **CLI / slash**: optionally ship a `skill-creator` system skill
  (`src/skill/system-skills/skill-creator/SKILL.md`, Codex parity §4.6) that is
  `userInvocable: true` so `/skill-creator` walks a human through the
  scaffold→validate→install flow using the tools. This is the human-facing
  affordance; the tools are the agent-facing one.
- **Post-install discovery**: install writes into a discovery root, so a new
  `buildSkillRegistry` snapshot (next session, or an explicit re-scan) picks it
  up — matching Codex's "restart to pick up new skills" (`skill-installer:31`).
  Hot-reload within the same turn is explicitly out of scope (§8).

### 4.6 (option) `skill-creator` system skill
A bundled guidance skill mirroring Codex's, but pointing at the typed tools
instead of Python scripts. Cheap, additive, default-discoverable. Recommended as
a Phase 3 follow-up, not a blocker.

---

## 6. 테스트 계획 (Test plan)

### Hellgate (adversarial, `*-hellgate.test.ts`)
- **Scaffold shape**: `skill_scaffold` output round-trips through
  `parseSkillMarkdown` with `ok: true` for every field permutation (each
  `category`/`stability`/`allowedTools` combo). Generated `name` always
  satisfies the kebab regex; non-conforming input names are normalized or
  rejected.
- **Validation rejects bad frontmatter**: feed the validator known-bad inputs
  (missing `---` fence, numeric scalar, `yes`/`True` boolean, duplicate key,
  unknown key under `.strict()`, non-kebab `name`, `adminInstalledBy` without
  admin scope) and assert the exact `FrontmatterParseError.line`. Proves the
  authoring tool inherits the loader's strictness with no drift.
- **Install path jailed**: `name` = `../../etc/x`, absolute paths, symlink
  targets, `..%2f` encodings, unicode-confusable separators → all rejected
  before any write; the resolved path is provably inside the chosen root.
- **Re-install / overwrite**: existing skill dir → abort by default; `overwrite:
  true` without confirmation still denied; with confirmation, replaces only the
  named skill, never a sibling.
- **Non-escalation (§4.4)**: installing-turn has tools `[read, grep]`; attempt
  to install a skill declaring `allowedTools: [read, grep, bash]` → DENY naming
  `bash`. Subset → allowed.
- **decideInstall integration**: banned skill name (admin policy) → DENY +
  `banned_install_blocked` audit event; `admin` scope from the tool → DENY
  (agent cannot self-install at admin scope).
- **Size cap**: > 30 MB content → rejected by the shared cap.
- **Plugin scaffold**: emitted `.quanta-plugin/plugin.json` parses under
  `PluginManifestSchema`; placeholders are present and the schema's required
  URL/brand fields are flagged as TODO (not auto-filled with junk).

### E2E
- `create → validate → install → discoverable`: `skill_scaffold` → `skill_validate`
  (ok) → `skill_install` (personal scope, confirmed) → a fresh
  `buildSkillRegistry` over the temp home finds the new skill with the expected
  scope (`personal`) and `allowedTools`. Asserts the loop closes end to end on a
  temp fs fixture (no real `$HOME` touched — closed-port writer + injected dirs).

### Drift guard
- `tests/unit/tool-surface-manifest-hellgate.test.ts` MUST stay green after the
  3–4 new rows (every new tool name present + real).

---

## 7. 단계 (Phases)

1. **Phase 1 — slice + validator reuse** (`src/skill/authoring/`): `scaffold`,
   `validate` (delegate to `parseSkillMarkdown` + size cap), pure `planSkillInstall`
   + `SkillWriterPort`, non-escalation check. Hellgate for scaffold/validate.
   No tools wired yet (pure, default-dead).
2. **Phase 2 — tools + manifest + gate**: `src/tool/skill-authoring-tool.ts`
   (`skill_scaffold` / `skill_validate` / `skill_install`), manifest rows,
   `QUANTA_SKILL_AUTHORING` gate, HITL `ask` tier on install, composition-root
   wiring (off by default). Install + e2e hellgate.
3. **Phase 3 — plugin variant + system skill**: `plugin_scaffold` +
   `PluginManifestSchema` reuse; optional `skill-creator` bundled guidance skill
   (§4.6); fc entry.

---

## 8. 리스크 / 대안 (Risks / Alternatives)

### 🛑 SECURITY — self-modifying capability (primary risk)
An agent that can author + install a skill is **modifying the behaviour and
(advisorily) the tool surface of the agent that then runs**. The skill body
becomes instructions the model follows; the `allowedTools:` advise the host's
enforcement seam. Without controls this is a self-grant/privilege-escalation
vector. Mandatory mitigations (all in §4):
1. **Default-OFF** behind `QUANTA_SKILL_AUTHORING`. No surface ships it on.
2. **Trust-gated install**: `skill_install` is `isReadOnly:false`, HITL
   `ask`-tier → user confirmation; if HITL is disabled, fail-closed (DENY for any
   non-`personal` scope). Any `repo`/team-visible scope ALWAYS requires explicit
   confirmation.
3. **Non-escalation invariant (§4.4)**: an installed skill's `allowedTools:`
   MUST be ⊆ the installing turn's permitted tools. The agent cannot mint a
   higher-privilege skill than it currently holds. This is the single most
   important check — without it, "author a skill with `bash` then invoke it" is a
   self-escalation.
4. **Install jail (§4.3)**: writes confined to canonical skills roots; `admin` /
   `team` / `system` are not agent-writable; `name` re-validated + path-jailed
   against traversal.
5. **Policy + audit**: every install routes through `decideInstall`
   (`install-enforcement.ts:117`) so `bannedSkills` / admin scope still apply,
   and `auditEvent` lands in the audit log — every self-modification is traced.
6. **Validate-before-write, re-validate at install**: `skill_install` never
   trusts a prior `skill_validate`; it re-runs the strict parser so a TOCTOU edit
   between validate and install cannot smuggle malformed/oversized content.
7. **No same-turn hot-reload**: an installed skill is only discoverable on the
   next registry snapshot (Codex "restart to pick up" parity), so the agent
   cannot author-then-immediately-invoke within one uninterrupted turn —
   forcing the confirmation/turn boundary to sit between authoring and use.

### Validation strictness (risk)
Two parsers exist: strict (`skill-frontmatter.ts`) and lenient
(`frontmatter.ts`). Authoring MUST validate against the **strict** one (the
authoring SSOT, `skill-frontmatter.ts:50`); otherwise an authored skill could
pass a lenient check and surprise a stricter consumer. The `superRefine` rules
(admin-scope ⇒ required, `:92`) must also hold — the scaffold should never emit a
contradictory admin/installState pair (and the tool forbids agent-authored admin
scope anyway).

### Alternatives considered
- **Guidance skill only (Codex-style, shell to scripts)**: lower effort, but it
  re-implements validation in a script that can drift from the TS loader, and it
  leans on shell rather than harness-enforced typed tools. Rejected as the
  primary path (kept as the optional §4.6 human affordance).
- **`plugin_install` now**: deferred. Installing a plugin pulls in DXT isolation
  + MCP server spawn (`src/plugin-isolation/`, `MCPServerSpecSchema`) — a much
  larger trust surface (the plugin can register *executable* MCP servers). Out
  of scope; `plugin_scaffold` (manifest authoring only, no spawn) is the safe
  subset.
- **Allow agent admin-scope install**: rejected. Admin scope is an org-policy /
  human action by definition (`install-enforcement.ts` admin branch); the agent
  installing at admin scope would defeat the whole admin-policy model.
- **Hot-reload authored skill into the live turn**: rejected (see §8.7) —
  removes the turn boundary that makes the confirmation meaningful.

---

## 9. 코드 위치 요약 (Code-location summary)

**New (proposed):**
- `src/skill/authoring/scaffold.ts` — `buildSkillScaffold` (SKILL.md emit, name
  normalization).
- `src/skill/authoring/validate.ts` — `validateSkillSource` (delegates to
  `parseSkillMarkdown` + size cap + non-escalation hook).
- `src/skill/authoring/install.ts` — `planSkillInstall` + `SkillWriterPort`
  (jail resolution, abort-on-existing, `decideInstall` call).
- `src/skill/authoring/plugin-scaffold.ts` — `buildPluginScaffold` (manifest
  emit against `PluginManifestSchema`).
- `src/tool/skill-authoring-tool.ts` — `skill_scaffold` / `skill_validate` /
  `skill_install` / `plugin_scaffold` tool factories.
- `src/skill/system-skills/skill-creator/SKILL.md` — optional Phase-3 guidance
  skill.
- `tests/.../skill-authoring-*.hellgate.test.ts` — adversarial batteries (§6).
- new manifest rows in `src/tool/surface/manifest.ts`; fc entry under
  `tools/feature-catalog/`.

**Reused (must not be re-derived):**
- `src/skill/skill-frontmatter.ts:573` `parseSkillMarkdown`, `:61`
  `SkillFrontmatterSchema`, `:110` `FrontmatterParseError`.
- `src/skill/skill-size.ts:23` `MAX_SKILL_SIZE_BYTES`.
- `src/skill/install-enforcement.ts:117` `decideInstall`.
- `src/skill/registry.ts:61` `defaultSkillSources` (jail allowlist).
- `src/skill/plugin-manifest.ts:93` `PluginManifestSchema`, `:123–126` layout
  constants.
- `src/skill/discover.ts:269` `discoverSkills` / `registry.ts:228`
  `buildSkillRegistry` (post-install discovery).
- `src/skill/skill-tool.ts:19` `skillToolAllowlist` (current-turn tool authority
  for the non-escalation check).
- `src/tool/surface/manifest.ts` (registration + drift guard); `src/tool/types.ts:976`
  `hitlTier`.

**Confirmed absent (grep):** no `skill_create`/`skill_validate`/`skill_install`/
`scaffold`/`installSkill` authoring tool anywhere in `src/**`; no skill row in
`src/tool/surface/manifest.ts`.
