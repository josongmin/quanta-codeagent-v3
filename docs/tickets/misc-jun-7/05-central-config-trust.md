# Ticket — central on-disk config loader + per-project trust gate

**Date:** 2026-06-07
**Status:** Design (NOT implementation). This ticket proposes seams; it ships no code.
**Gap:** `docs/backlog/jun-7-gap-other-agent.md` §12.1 (P7) — verified jun-07 src grep (`projectTrust`/`trustDialog`/`workspaceTrust`/`trust_level` grep **0** in `src/`).
**Slice:** a NEW `@/config` disk-loader slice (layered file reader + typed `Settings` merge + a per-project **trust-store**), feeding `@/shared` `runtime-config` as a **closed port** (`runtime-config` consults the loader ONLY when the knob is on; env still wins). `@/agent/command-hooks` consumes the resolved settings instead of its own one-off reader. No change to the `@/shared` env-parse contract — the disk loader is an *additional source* registered under env.
**Candidate ADR:** next free (≥ 0497). (0496 is the current high-water mark in `docs/decisions/`.)
**Default posture:** OFF, **byte-identical**. Absent the knob, **NO disk config is read at all** — `runtimeConfig()` stays exactly the frozen env-parse it is today (`runtime-config.ts:1483-1486`), no file IO, no trust-store allocation. The disk loader is purely additive: `runtime-config` consults it ONLY when `QUANTA_DISK_CONFIG` (or equivalent) is on. The **trust gate defaults to UNTRUSTED**, which is the SAFE default: an untrusted repo's project/local layers that grant capabilities are IGNORED. Crucially — **enabling the disk loader without trusting the repo must still fail-closed**: `QUANTA_DISK_CONFIG=on` in a freshly-cloned hostile repo reads ONLY machine-owned layers (managed + user); the repo-local layers contribute nothing security-load-bearing until the project is explicitly trusted.
**Competitor source:** Claude Code CLI 2.1.150 (`.extracted_source/claude-code-cli/_cli-symbols.txt`); Codex 0.135 (`.extracted_source/codex/_codex-rs-0.135-symbols.txt`); IDE spec §11.1/§12 (`docs/plans/jun-7-draft-ide-integration-spec-claude.md:567-594`).
**ROI:** cost 중-고 (new slice + trust-store + merge semantics); impact 고 (security + enterprise/org config story). Prerequisite for safely honoring ANY repo-local config — several other tickets want it.

---

## 1. Problem

quanta loads settings **essentially env-only**. The single source of truth for runtime knobs is `src/shared/runtime-config.ts` — a frozen `loadFromEnv(process.env)` (`runtime-config.ts:1094-1095, 1483-1486`) that is, by design, "the SINGLE place that touches `process.env`" (`runtime-config.ts:1-2`). There is **no central on-disk config loader of the Claude/Codex shape** and **no per-project trust concept** anywhere in `src/`. Two consequences:

1. **Env-only doesn't scale.** There is no user/project/local **layering**, no **managed-settings** layer for orgs to pin non-overridable policy, no documented precedence. Every operator/enterprise knob is a `QUANTA_*` env var. There is no way to express a persisted per-project posture ("this repo is trusted; this repo is not") or a machine-wide managed policy ("permissions are locked, repos may not loosen them").

2. **No project-trust gate — this is the security crux.** quanta today has only *per-ACTION* trust (the `@/permission` `trust-scope` registry — `trust-scope.ts:1-30`, an ask-skip cache keyed by structurally-equivalent action, default-OFF). It has **no startup per-project trust posture**. So the moment quanta *does* start reading repo-local config (and pieces of it already do — see §2), it would honor **attacker-controlled** hooks / MCP servers / permission grants from a cloned hostile repo. Reading repo-local config is a remote-code-execution-adjacent surface: a `.quanta/settings.json` shipped in a hostile repo could declare a `PreToolUse` command hook, an MCP server launcher, or a permission `allow` that the harness then executes. The **trust gate** is the security control that makes a layered loader safe to build at all. Without it, layering is a liability, not a feature.

---

## 2. Current state (src-verified)

**The env SSOT (parity-of-shape only — it's env, not disk):**
- `runtime-config.ts` is the frozen env chokepoint: `loadFromEnv(env)` returns `Object.freeze({...})` (`runtime-config.ts:1094-1095`), cached on first `runtimeConfig()` (`runtime-config.ts:1483-1486`). "Adding a new env var goes here" (`runtime-config.ts:19`). Every consumer reads from `runtimeConfig()`, never `process.env` directly (a scanner bans the latter — `runtime-config.ts:25`). This is the chokepoint a disk source must plug **under**.

**Does quanta read ANY central disk config today? — NO (central), but YES (one narrow repo-local read):**
- `src/agent/command-hooks/settings-loader.ts:4` says it plainly, verbatim: *"quanta has no central Claude-style `settings.json` loader today, so this is a focused reader for exactly the `hooks` block."* `loadCommandHookBindings(settingsPath)` (`settings-loader.ts:81-93`) reads **one** file path and parses **only** its `hooks` block into `CommandHookBinding[]`; missing/ENOTDIR ⇒ `[]`, malformed ⇒ `[]` (`settings-loader.ts:13, 58-66, 89`). It is **not** a layered config loader — it is a single-key, single-file reader.
- It is wired at the async composition root: `apps/agent/index.ts:200-208` calls `loadCommandHookBindings(join(process.cwd(), "settings.json"))` **only** when `gateOn(process.env, "QUANTA_COMMAND_HOOKS")` (default-OFF). **This is the one place quanta reads a repo-local file as config today** — and it is `process.cwd()`-relative (repo-local) with **no trust gate** in front of it. The comment notes "loading bindings does NOT arm anything" — arming is separately gated (`settings-loader.ts:15-17`) — but the *read* is already repo-local-trusting.
- The `@/migration` slice reads `.claude/settings.json` (`migration/translators/claude-code-config.ts:113-118`, `migration/external-config/detect.ts:52-64`) and **writes** `<project>/settings.json#permissions`/`#hooks` (`migration/external-config/persist.ts:278-317`) — but that is a one-shot *import/translate* path, not a live layered loader, and it explicitly fail-closes on a corrupt existing file (`persist.ts:281, 312`).

**Trust concept in src — NONE at the project/startup level:**
- `projectTrust` / `trustDialog` / `workspaceTrust` / `trust_level` grep **0** in `src/`.
- The only `isTrusted` is a per-source **credential-helper** predicate (`llm/credential-helper.ts:106, 165`; wired in `runner/assemble/llm.ts:177-251`, `apps/cli/internal.ts:214, 536`) — "is this LLM credential source trusted to shell out" — NOT a project-trust posture.
- The only `trust-scope` is the per-ACTION ask-skip registry (`permission/trust-scope.ts`, `permission/trust-scope-store.ts`), default-OFF, NOT a startup gate.
- The H2 **untrusted-context envelope** exists (`agent/untrusted-envelope.ts` via `host/runtime/agent-config-assembler.ts:66, 465`; `agent/types.ts:1281`; `agent/prompt.ts:246-253`) — it wraps untrusted *content* in a system-reminder, default-OFF. It is reusable as the "this came from an untrusted source" signal, but it is content-marking, not config-gating.

**Net:** quanta has the env SSOT, a one-key repo-local hook reader (ungated by trust), a per-action trust cache, and an untrusted-content envelope. It has **no layered disk-config loader and no per-project trust gate**. The §2 narrow repo-local read (`apps/agent/index.ts:206`) is exactly the surface the trust gate must retroactively cover.

---

## 3. Competitor mechanism (verified)

### 3.1 Claude Code CLI — layered settings + trust dialog

**Layer files (IDE spec §12 verbatim, `jun-7-draft-ide-integration-spec-claude.md:577-594`):** the settings schema is validated for three on-disk shapes:
> Validated for `**/.claude/settings.json`, `settings.local.json`, `**/{ClaudeCode,claude-code}/managed-settings.json`.

The documented layers (precedence high→low): **managed** (`managed-settings.json`, machine/org-owned) > **user** (`~/.claude/settings.json`) > **project** (`<repo>/.claude/settings.json`, repo-committed) > **local** (`settings.local.json`, repo-local-uncommitted). Security keys carried by these layers (`jun-7-draft-ide-integration-spec-claude.md:581-594`): `permissions{allow,deny,ask,defaultMode,disableBypassPermissionsMode,additionalDirectories,allowManagedPermissionRulesOnly}`, `sandbox{…}`, `hooks{… disableAllHooks, allowManagedHooksOnly, allowedHttpHookUrls …}`, `mcp/plugins{enableAllProjectMcpServers, enabled/disabledMcpjsonServers}`, `model`.

**`--setting-sources` flag (verbatim, `jun-7-draft-ide-integration-spec-claude.md:127`):** `--setting-sources user,project,local` selects which layers are honored (confirmed in `_cli-symbols.txt` `setting-sources`/`setting sources` at lines ~255095, 256770, 269928-269946). `--managed-settings` is a separate flag (`jun-7-draft-ide-integration-spec-claude.md:129`).

**`allowManagedPermissionRulesOnly` (verbatim, `jun-7-draft-ide-integration-spec-claude.md:582`; `_cli-symbols.txt:248282, 248942`):** when set in the **managed** layer, ONLY managed permission rules are honored — user/project/local cannot add permission rules. This is the **managed-is-non-overridable** primitive for security keys. The hook analogue is `allowManagedHooksOnly`.

**Trust dialog (`_cli-symbols.txt`):** `hasTrustDialogAccepted` (×12, e.g. `_cli-symbols.txt:248496, 248507, 249389, 269703`) is the per-project trust flag; `setPathTrusted` (`_cli-symbols.txt` `lo` export bag, ~line 248282 region) flips it; trust is persisted **per project path** in the global config's `projects[<path>]` map (`b_().projects[H]` / `qw()` / `Zj()` accessors in the same region — `projects` is keyed by canonicalized project path). **"Untrusted workspaces: not supported"** (`jun-7-draft-ide-integration-spec-claude.md:567-568`) — the extension refuses to operate in an untrusted VS Code workspace at all.

**Untrusted-source-ignored (verbatim, `_cli-symbols.txt:248744`):** `tengu_settings_auto_mode_untrusted_source_ignored` — settings from an **untrusted source are ignored**. The generalization: a repo-controlled settings source MUST NOT inject capability-granting config into a session that hasn't trusted that repo. (Ticket 04 §3.1/§6 already leans on this exact telemetry name for the auto-mode rule overlay.)

### 3.2 Codex 0.135 — `config.toml` layers + per-project `trust_level`

**Layered TOML (`_codex-rs-0.135-symbols.txt`):** `config.toml` is the central config (`~/.codex/config.toml`, `_codex-rs-0.135-symbols.txt:47878`), with a **managed** layer above user: *"Overridden by legacy managed_config.toml"* (`:3666`), *"Only writes to the user config are allowed"* / *"user layer not found in updated layers"* (`:47765`). Layer model: managed > user > project. `--strict-config` errors on unknown fields (`:47875` `STRICT_CONFIG` / "Error out when config.toml contains fields that are not recognized").

**Per-project trust (gap doc §12.1 + corpus):** `[projects."<path>"] trust_level = trusted | untrusted` (gap-doc-cited `userdata/codex/config.toml:14-30`) — a **persisted per-project trust posture** that gates the whole approval/sandbox policy on directory entry, plus a first-run trust dialog. Codex also gates hooks behind trust: `--dangerously-bypass-hook-trust` "Enabled hooks may run without review for this invocation" (`_codex-rs-0.135-symbols.txt:47306`) — i.e. hooks are trust-gated by default and bypass is a loud, explicit, per-invocation flag.

**Shared shape across both competitors:** (a) a layered on-disk config with a **machine-owned managed layer that repo layers cannot override** for security keys, and (b) a **persisted, path-keyed, default-untrusted per-project trust gate** that decides whether repo-local capability-granting config is honored at all.

---

## 4. Design

A new `@/config` slice: a **closed-port** disk-config loader that (a) reads the layered files into a typed `Settings`, (b) merges by documented precedence with **managed non-overridable** for security keys, (c) applies a **per-project trust gate** that drops repo-local capability grants when the project is untrusted, and (d) feeds the merged result into `@/shared` `runtime-config` as an additional source **under env**. Default-OFF, fail-closed on untrusted.

### 4.a The layered loader (closed port)

A pure `@/config` module `loadSettings(paths, trust): ResolvedSettings`:
- **Layers (high→low precedence), matching the competitor shape:** `managed` > `user` > `project` > `local`. Discovery paths:
  - `managed` — machine/org-owned, OUTSIDE the repo (macOS/Linux discovery path is an Open Question §9). Read-only, never repo-relative.
  - `user` — `$QUANTA_CONFIG_DIR/settings.json` (default `~/.quanta/settings.json`), analogous to Claude's `CLAUDE_CONFIG_DIR`.
  - `project` — `<repo>/.quanta/settings.json` (repo-committed, repo-controllable).
  - `local` — `<repo>/.quanta/settings.local.json` (repo-local, uncommitted, repo-controllable).
- **Per-source parse is fail-soft** exactly like `settings-loader.ts`: missing ⇒ skip layer, malformed JSON ⇒ skip layer + one stderr warn (NEVER throw, NEVER half-apply a corrupt file — mirrors `settings-loader.ts:13, 58-66` and `migration/external-config/persist.ts:281`). A real IO fault (EACCES) on a *required* layer propagates (parity with `settings-loader.ts:87-91`).
- **Typed `Settings`** is a small, explicit schema (NOT free-form): the security-load-bearing keys (`permissions`, `hooks`, `mcp`, tool grants) and the benign keys (formatting/display prefs) are **distinct fields** so the trust gate can discriminate (§4.c). Unknown keys are dropped (optionally `--strict-config`-style error — Open Question §9).
- A `--setting-sources` analogue (knob or arg) selects which layers participate, parity with Claude's `--setting-sources user,project,local` (`jun-7-draft-ide-integration-spec-claude.md:127`).

### 4.b Merge semantics (managed wins, managed is non-overridable for security keys)

- **Default precedence:** higher layer wins per key (`managed` ⊐ `user` ⊐ `project` ⊐ `local`). List-valued keys (`permissions.allow/deny/ask`) **union** within a layer band but a higher band can still tighten.
- **Managed non-overridable (the org control):** when the managed layer sets `allowManagedPermissionRulesOnly` (Claude verbatim, `jun-7-draft-ide-integration-spec-claude.md:582`), lower layers **cannot add** permission rules — only managed permission rules apply. Same for `allowManagedHooksOnly`. This is the byte-for-byte port of Claude's primitive and is asserted by hellgate (§7).
- **deny always wins over allow** within the resolved permission set (defense-in-depth; never let a lower-band `allow` widen past a higher-band `deny`).

### 4.c The per-project trust gate (the security crux)

A `@/config` **trust-store**: a persisted record keyed by **canonical repo path**, default **UNTRUSTED**.
- **Record shape:** `Map<canonicalProjectPath, { trusted: boolean; grantedAt: epoch-ms }>`, persisted to the user config dir (NOT the repo — Open Question §9 on exact location), path-pinned (trusting `/a` does NOT trust `/b`; trusting `/a` does NOT trust `/a/sub` unless separately granted — same path-canonicalization discipline as ticket 04 §4.b's effect-signature).
- **Default UNTRUSTED.** A path with no record is untrusted. Trusting a project is an **explicit user action** (an interactive trust prompt, parity with Claude's `hasTrustDialogAccepted` / `setPathTrusted` and Codex's first-run dialog). Reuse the existing untrusted-content envelope (`agent/untrusted-envelope.ts`) as the in-band "this source was untrusted" signal where model-facing text needs it.
- **Gate semantics — the load-bearing rule:** for an **untrusted** project, the **repo-local layers (project + local)** contribute **NOTHING security-load-bearing**. Only `managed` + `user` (machine-owned, NOT attacker-shippable) layers apply. Specifically, from an untrusted repo's project/local layers, these are **IGNORED**: `permissions.allow` (capability widening), `hooks` (command execution), `mcp` server launchers, tool grants. Benign keys (formatting/display prefs) from an untrusted repo's layers MAY apply (they grant no capability) — but the conservative default is to drop the whole repo band and only honor benign keys if a follow-up decides it's worth the complexity (Open Question §9).
- **Asymmetry — tightening is always allowed:** repo-local `permissions.deny` / `soft_deny` / sandbox-narrowing from an untrusted repo MAY still apply (a repo *tightening* its own boundary is safe; only *loosening*/capability-granting requires trust). This mirrors ticket 04 §4.a's overlay fence: project-layer rules apply in the tightening direction only.
- **Fail-closed:** `QUANTA_DISK_CONFIG=on` on an untrusted repo reads managed+user, drops repo capability grants, and **logs which repo layers were dropped for untrust** (parity with `tengu_settings_*_untrusted_source_ignored`). Enabling the loader without trust NEVER silently honors a hostile repo's hook/MCP/permission.

### 4.d Feeding `runtime-config` as a closed port (env still wins)

- `@/config` exposes a pure `resolveDiskConfig(env, cwd): ResolvedSettings | undefined` — `undefined` when the knob is OFF (no IO, no allocation).
- `runtime-config.ts` `loadFromEnv` gains an **optional disk source consulted UNDER env**: `parseX(env.QUANTA_X ?? disk?.x)` — i.e. an env var still wins; the disk value is a fallback an operator can set in `settings.json`. The frozen+cached contract (`runtime-config.ts:1094-1095, 1483-1486`) is unchanged; the disk read happens once, at the same first-access freeze point. **Document the precedence explicitly: env > managed > user > (trusted) project > (trusted) local.** (Whether env should beat *managed* is an Open Question §9 — for an org-locked managed layer, managed-beats-env may be the right enterprise semantics.)
- `@/config` is a **closed port**: `runtime-config` (and `@/agent/command-hooks`) depend on the `@/config` interface; the concrete file IO + trust-store persistence is injected at the composition root (`apps/agent/index.ts`), parity with how `command-hookBindings` / `localEnvSelection` / `namedAgents` are loaded at the async root today (`apps/agent/index.ts:195-219`). No `@/config → @/agent` import.

### 4.e Reuse

- The `@/rules` layer model (`RuleLayer = system|user|project` — ticket 04 §2) is the precedent for layered provenance; the disk loader's managed/user/project/local map onto the same mental model (managed=system-band).
- `StructuredDenyReason` (`permission/deny-reason.ts`, ticket 04 §4.c) surfaces "this capability was dropped for untrust" as a categorical reason (NEVER the path/command — categorical only).
- The H2 untrusted-context envelope (`agent/untrusted-envelope.ts`) marks untrusted-sourced content.
- The existing `settings-loader.ts` fail-soft parse (`parseCommandHookBindings`) is the read-discipline template; the new loader generalizes it from one key to the full layered schema, and `@/agent/command-hooks` then consumes the *resolved+trust-gated* hooks instead of its own `process.cwd()`-relative read — closing the §2 ungated repo-local read.

---

## 5. Security risk (honest — this is THE risk)

**Reading repo-local config is a remote-code-execution-adjacent surface.** A hostile repo ships `.quanta/settings.json` (or `.quanta/settings.local.json`) declaring a malicious `PreToolUse` command hook, an MCP server launcher that runs an arbitrary binary, or a `permissions.allow` that auto-approves destructive actions. If quanta reads and honors that without a trust gate, cloning a repo = handing the repo author a shell. The §2 finding is exact: quanta **already** reads `<cwd>/settings.json#hooks` (`apps/agent/index.ts:206`) with **no trust gate** — that read is in-scope for this gate retroactively.

Mitigations (each maps to a competitor primitive):
- **Default-untrusted** (Codex `trust_level=untrusted` default; Claude `hasTrustDialogAccepted=false` default). A never-seen repo path is untrusted; its project/local capability grants are dropped.
- **Managed-non-overridable** (Claude `allowManagedPermissionRulesOnly` / `allowManagedHooksOnly`; Codex `managed_config.toml` "Overridden by"). An org's machine-owned managed layer cannot be loosened by ANY repo or even the user, for security keys. This is the enterprise lockdown control.
- **Trust is explicit + path-pinned** (Claude `setPathTrusted` per `projects[<path>]`). Trust is a deliberate user action recorded against a canonical path; it does not transfer to sibling/child paths.
- **Security keys gated on trust; benign keys may not be** (the §4.c discrimination). Only `permissions/hooks/mcp/tool-grant` from repo layers require trust; formatting prefs are harmless.
- **Tightening allowed, loosening gated** (ticket 04 §4.a asymmetry). A repo can only narrow its own boundary without trust, never widen.
- **Log when repo layers are dropped for untrust** (parity with `tengu_settings_*_untrusted_source_ignored`) so the drop is observable, not silent.
- **Fail-closed on enable-without-trust.** `QUANTA_DISK_CONFIG=on` is NOT a trust grant; it only turns on the loader. Untrusted ⇒ managed+user only.

Honest residual: a **trusted** repo that later turns hostile (a dependency-confusion-style attack where a previously-trusted repo's `.quanta/settings.json` is mutated by a malicious commit) still gets its capability grants honored — trust is path-level, not content-level. This is the same residual Claude/Codex carry; mitigating it (e.g. re-prompt on settings change, like Claude's `ConfigChange` hook event — `jun-7-draft-ide-integration-spec-claude.md:592`) is a follow-up, not v1.

---

## 6. Files to touch

- `src/config/` **(new slice)** — `loader.ts` (layered file reader, fail-soft per-layer parse generalizing `settings-loader.ts`), `merge.ts` (precedence merge + managed-non-overridable), `trust-store.ts` (per-project trust record, path-canonicalization, persistence), `types.ts` (typed `Settings` with security-key/benign-key discrimination), `index.ts` (the closed-port surface: `resolveDiskConfig(env, cwd, trust)`, `isProjectTrusted(path)`, `setProjectTrusted(path)`).
- `src/shared/runtime-config.ts` — register the disk source UNDER env in `loadFromEnv` (`:1094`); each relevant `parseX` falls back to `disk?.x`; document the env>managed>user>project>local precedence in the header (`:14-26`). No change to the freeze/cache contract.
- `src/agent/command-hooks/settings-loader.ts` — consume the **resolved + trust-gated** hooks from `@/config` instead of the standalone `process.cwd()`-relative read; keep `parseCommandHookBindings` as the shared parse primitive. The §2 ungated read at `apps/agent/index.ts:206` is replaced by the trust-gated path.
- `src/apps/agent/index.ts` — at the async composition root (alongside `localEnvSelection`/`commandHookBindings`/`namedAgents` at `:195-219`), inject the concrete `@/config` loader + trust-store; gate the whole thing on `QUANTA_DISK_CONFIG` (default-OFF).
- `tsconfig.base.json` — register `@/config` + `@/config/*` paths (the slice MUST be path-registered — sibling pattern to `@/permission` at `:42-43`, `@/rules` at `:60-61`).
- Knobs in `src/shared/runtime-config.ts` — `QUANTA_DISK_CONFIG` (master, default-OFF), `QUANTA_CONFIG_DIR` (user-layer dir override), a `--setting-sources` analogue + SSOT/surface manifest entries.
- `fc` catalog — register the disk-config-loader + project-trust-gate features.

---

## 7. Test / hellgate plan

- **Layer-precedence merge correct:** managed > user > project > local for a scalar key; list union within band; a higher-band `deny` overrides a lower-band `allow`. Differential against the documented precedence.
- **Managed is non-overridable:** with `allowManagedPermissionRulesOnly` set in the managed layer, a user/project/local `permissions.allow` is **NOT** applied (even for a TRUSTED repo). Same for `allowManagedHooksOnly` vs a project hook. **This is the org-lockdown assertion.**
- **OFF ⇒ env-only byte-identical (ratchet):** with `QUANTA_DISK_CONFIG` unset, `loadFromEnv` performs **NO disk read** (assert zero `readFile` calls via the injected IO port) and `runtimeConfig()` is byte-identical to today's env-parse. No trust-store allocated. (The project's default-OFF byte-identity standard.)
- **UNTRUSTED repo grants IGNORED (red-on-injection — the core security test):** an untrusted repo's project/local layer carrying `permissions.allow` / a `hooks` command / an `mcp` server launcher / a tool grant is **NOT** applied — only managed+user layers reach the resolved settings. The dropped layers are logged. Assert specifically that the malicious hook command never becomes a `CommandHookBinding`.
- **TRUSTED repo layers ARE applied:** after `setProjectTrusted(canonicalPath)`, the same project/local layers' grants ARE merged (subject to managed-non-overridable). Confirms the gate is a gate, not a hard block.
- **Trust is path-pinned:** trusting `/a` does NOT trust `/b`; trusting `/a` does NOT trust `/a/sub`; `./X` / `/a/./X` / symlink-resolved variants canonicalize to the same key (no trust leak via path aliasing).
- **Tightening-without-trust allowed:** an untrusted repo's project-layer `permissions.deny` / sandbox-narrowing IS applied (tightening is safe); its `allow` is NOT.
- **Fail-soft parse:** a malformed managed/user/project/local file ⇒ that layer skipped + one warn, NEVER a throw, NEVER a half-applied corrupt layer; a present-but-corrupt file does not clobber a valid lower layer (parity with `settings-loader.ts` + `persist.ts:281`).
- **Fail-closed on enable-without-trust:** `QUANTA_DISK_CONFIG=on` + untrusted repo ⇒ managed+user only; the §2-style `<cwd>/.quanta/settings.json#hooks` is NOT armed.

---

## 8. ROI / cost

- **Cost: 中-고.** This is a genuinely new slice — not a one-file overlay. It needs the layered loader, the precedence+managed-non-overridable merge, the path-keyed persisted trust-store, the discrimination between security and benign keys, and the runtime-config wiring. The merge semantics and the trust-gate's drop-rules are the spend (and the place bugs hide), not raw LOC. The fail-soft parse is reusable from `settings-loader.ts`.
- **Impact: 고.** Two payoffs: (1) **security** — it retroactively gates the §2 ungated repo-local read and makes any future repo-local config safe; (2) **enterprise/org config story** — managed-settings + non-overridable permission rules are table-stakes for org adoption, and quanta has *zero* today. **Prerequisite framing:** this is a precondition for safely honoring **ANY** repo-local config. Ticket 04's auto-mode rule overlay (§6, P-tie-in) wants a trust-gated `project`-layer source; the MCP `.mcp.json` and `.quanta/agents` repo-local reads (`apps/agent/index.ts:209-219`) want the same gate. Building the gate once unblocks all of them.

---

## 9. Open questions (calibrate — no magic)

1. **File format.** JSON like Claude (`settings.json`/`settings.local.json`), TOML like Codex (`config.toml`), or a quanta-native shape? JSON matches the existing `settings-loader.ts`/`@/migration` reader and the IDE-spec schema we already validate against (`jun-7-draft-ide-integration-spec-claude.md:579`) — **recommendation: JSON, reuse the Claude-shape readers we already have.** Decide before writing the schema.
2. **env vs disk precedence — does env beat *managed*?** §4.d sets env > managed > user > project > local. But an org-locked managed layer that an env var can override is not a lockdown. **Recommendation: managed beats env for the security keys flagged non-overridable; env beats disk for everything else.** Needs an explicit decision — it's the enterprise-vs-developer-ergonomics trade.
3. **Trust-store persistence + headless/CI granting.** Where does the trust record live (user config dir, a `~/.quanta/trust.json`)? And how is trust granted where there's **no interactive prompt** — CI / `--print` / a headless surface? Options: an explicit `--trust <path>` flag, an env allow-list (`QUANTA_TRUSTED_PATHS`), or "headless ⇒ untrusted, period." **Recommendation: default headless = untrusted; explicit `--trust`/env opt-in for CI that knows the repo.** Do not auto-trust in non-interactive mode (that's the exact hostile-clone case).
4. **Relationship to ticket 04's untrusted-source fence.** Ticket 04 §4.a/§6 already blocks repo-`project`-layer `allow`/`hard_deny` from the auto-mode classifier and flags "tie-in with the central-config/trust-gate gap (P7)". This ticket IS that gate. **Decision: the `@/config` trust-store becomes the single SSOT that ticket 04's overlay consults** (`isProjectTrusted(cwd)`) instead of inventing its own source-trust notion — avoid two trust concepts.
5. **Managed-settings discovery path on macOS/Linux.** Claude validates `**/{ClaudeCode,claude-code}/managed-settings.json` (`jun-7-draft-ide-integration-spec-claude.md:579`); Codex uses `managed_config.toml`. Where does quanta's managed layer live on macOS (`/Library/Application Support/...`?) vs Linux (`/etc/...`?)? Must be a path a non-admin user **cannot write** (that's the whole point of "managed"). Enumerate the OS-specific paths before implementation.
6. **Benign-key application from untrusted repos.** §4.c lets benign (formatting) keys from an untrusted repo apply while dropping security keys. Simpler+safer is to drop the entire repo band when untrusted. **Recommendation: v1 drops the whole repo band; revisit benign-key passthrough only if a real use-case demands it** (per `no-heuristics-only-validated` — don't split keys speculatively).
