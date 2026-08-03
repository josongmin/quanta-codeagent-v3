# RFC-03 — Self-Improvement + Onboarding Absorption (ProposeSkills · Import UX · skill_search)

**Status**: RE-AUDITED — ToolSearch skill-mode PROTOTYPE; ProposeSkills/Import DESIGN FIRST. All work **default-OFF**, `measure-first` for efficacy.
**Source audit**: `docs/analysis/aug-02-competitor-corpus-refresh-audit.md` §7 (ProposeSkills), §5/§4.4 (`external_agent_memory_import`), §3.6 (`skill_search`).
**Author**: research agent, 2026-08-03. Conventions: hellgate (RED e2e→TDD→3R adversarial→self-audit); leaf-crate unit tests; imported content is UNTRUSTED (jul-12 `MODE_REPO_RULES_POLICY`); HITL review before any skill/hook activation.

---

## 2026-08-03 current-HEAD correction (authoritative)

Audit basis: `main@0a00ced392102073fe35eccd202bca92cabd71dc`. Focused current-head rails: **71 pass / 0 fail**. 이 절과 아래 과거 초안이 충돌하면 **이 절이 우선**한다.

| Item | corrected verdict | owner delta | admission / stop rule |
|---|---|---|---|
| C1 ProposeSkills | `skill_create` writer는 즉시 live path에 쓴다. path-exists evidence와 mutable review card는 승인 근거가 아니다. creator의 strict scaffold validator도 runtime discovery schema와 동일하지 않다. | existing `ApprovalStateMachine`이 lifecycle을 소유하고, staged content-addressed proposal artifact가 `{proposalId,draftHash,targetPreimageHash}`를 보관한다. realpath/hash/CAS는 existing `@/storage` atomic-write/canonicalization을 host adapter에서 재사용한다. | 새 approval store/hash/jail/write 구현 금지. path existence만으로 evidence-backed 판정 금지. proposal/preimage drift 시 no write. |
| B2 Import | missing converter는 **skills + memory**다. imported skill을 `userInvocable:false`로 써도 runtime catalog/tool에 들어가므로 inert하지 않다. hooks의 `needsReview` hold는 trust-gate knob와 독립이다. | imported skill은 live discovery 밖 staging 후 explicit promote. MEMORY는 authoritative source-path contract를 먼저 정하고 heuristic/double import 금지. per-item receipt/retry 또는 true preflight+commit을 선택한다. | provenance/filter 없이 live skill dir write 금지. settings/MCP/subagent/memory는 per-class diff/trust 없으면 import 금지. partial write를 transactional로 보고 금지. |
| A10 skill_search capability | standalone tool은 기존 `ToolSearch`와 중복이고 full `Skill` inventory도 남긴다. 현재 tier1/CLI skills surface도 canonical `buildSkillRegistry` 대신 discovery/precedence를 각각 수행한다. | 먼저 모든 consumers를 한 immutable `SkillRegistry.entries/lookup` snapshot으로 cutover한다. 그 뒤 기존 `ToolSearch` input에 additive `catalog:"tools"|"skills"`(default `tools`)를 추가하고 exact name/prefix/scope/category/stability filter만 사용한다. exact `Skill` tool이 body를 load한다. | registry cutover 전 search/mention 구현 금지. standalone `skill_search`, 별도 discovery/registry/cache/scorer 금지. prompt/tool-schema token A/B와 task success 동시 측정 전 economy claim 금지. |

추가 stop: 동일 `~/.claude/CLAUDE.md`를 rules와 memory 양쪽으로 추정 import하지 않는다. 아래 “same discovery schema”, “skills + sessions”, live-dir direct write 설계는 superseded candidate다.

### SOTA++ direction — proposal compiler + trusted promotion

- “self-improve”를 agent의 live self-modification으로 구현하지 않는다. evidence → deterministic draft → immutable proposal → human decision → CAS promotion의 compiler pipeline으로 제한한다.
- proposal에는 source anchors/hash, generator/model/config version, target preimage, normalized output hash, validation receipt를 넣는다. existing `ApprovalStateMachine` request는 staged artifact ref/hash를 가리키며 lifecycle을 재사용한다. mutable UI card 상태가 authority가 아니다.
- imported skill/MEMORY/config는 executable supply-chain artifact다. live discovery 밖 staging, exact diff, provenance/trust class, promotion receipt 없이는 runtime catalog에 들어가지 않는다.
- A10의 목적은 검색 tool 추가가 아니라 **catalog virtualization**이다. gate ON에서는 full skill inventory를 제거하고 existing `ToolSearch` skill mode가 `SkillRegistry` snapshot 위 deterministic field filter → exact `Skill` load를 수행한다. fuzzy/weighted ranking은 이 ticket에서 제외한다.
- promotion 뒤 새 skill catalog snapshot은 다음 turn/session boundary에서만 publish한다. MCP hot reload와 동일한 **turn-pinned snapshot 원칙**만 공유하고 공용 generation 타입/registry/god-module은 만들지 않는다.
- proposal 생성은 explicit tool/user invocation에서만 시작한다. 반복 횟수·lexical similarity·memory score로 자동 trigger하지 않으며 모델 판단은 proposal 내용에만 관여하고 promotion authority가 아니다.
- **중복 금지:** standalone `skill_search`, 새 approval state machine, live skill registry, lexical scorer, hash/jail/atomic writer, import ledger를 만들지 않는다. existing `ToolSearch`, approval machine, `SkillRegistry`, `@/storage`, external-config ledger를 사용한다.
- 허용되는 새 port는 `SkillProposalArtifactPort` 하나뿐이다. content-addressed staged bytes의 put/get/promote만 노출하고 host adapter가 existing `@/storage`를 사용한다. approval request에는 optional `artifactRef/artifactHash`만 추가한다.

## 구현 액션리스트 (authoritative)

**SOLID 경계:** `SkillRegistry`가 discovery/precedence의 단일 read authority, proposal compiler가 deterministic bytes를 생성하는 pure domain service, `SkillProposalArtifactPort`가 staging I/O 경계, existing approval machine이 decision lifecycle, external-config migration이 import orchestration을 소유한다. 어느 surface도 독자 discovery/cache/write path를 갖지 않는다.

### Symbol-level reuse / delete / new ledger

| disposition | existing/new symbol | exact action | 금지되는 평행 구현 |
|---|---|---|---|
| **KEEP AUTHORITY** | `buildSkillRegistry`, `SkillRegistry.entries/lookup` | discovery/precedence/read snapshot의 유일 owner | second registry/cache/index |
| **DELETE DUPLICATE CALLS** | `buildSkillBlock` 내부 `discoverSkills`/`discoverSystemSkills` | canonical registry snapshot injection으로 교체 | tier1-local merge/precedence |
| **DELETE DUPLICATE CALLS** | `src/apps/cli/repl/skills-surface.ts` direct discovery | 같은 snapshot의 read projection으로 교체 | CLI-local discovery/cache |
| **EXTEND** | `createToolSearchTool` | `catalog:"skills"` mode만 additive 추가 | standalone `skill_search`, skill scorer |
| **REFACTOR IN PLACE** | `createSkillCreatorTool` / `skill_create` | direct live write 대신 deterministic proposal stage를 수행 | 별도 `skill_propose` writer와 legacy live writer의 공존 |
| **REUSE** | `ApprovalStateMachinePort` | artifact hash가 결합된 기존 lifecycle 그대로 사용 | proposal review store/state machine |
| **ROUTE/REMOVE DIRECT APPLY** | `src/skill/migration.ts` | existing external-config stage/promote pipeline으로 route | 두 번째 import ledger/direct-copy apply |
| **NEW — ONE PORT ONLY** | `SkillProposalArtifactPort` | immutable staged bytes put/get/CAS promote | hash/jail/atomic-write implementation을 port 내부에 복제 |

**삭제/대체 완료 조건:** canonical cutover 뒤 production에서 `discoverSkills`/`discoverSystemSkills`를 호출하는 composition owner는 `buildSkillRegistry` 하나여야 한다. `skill_create`가 live discovery path에 직접 쓰는 wiring과 `src/skill/migration.ts` direct copy가 남아 있으면 promotion/import packet은 미완료다.

### RFC03-0 — canonical SkillRegistry snapshot cutover (P0, M)

- **Depends:** 없음. 이후 모든 RFC03/B4 작업의 선행조건.
- **Owner/write-set:** `src/skill/registry.ts`, `src/agent/tier1/skill.ts`, `src/apps/cli/repl/skills-surface.ts`, host composition의 skill deps, `tests/unit/skill-registry-precedence.test.ts`.
- **Actions:**
  1. user/system/project discovery와 precedence merge를 `buildSkillRegistry` 한 곳에서 수행하고 deterministic immutable snapshot을 만든다.
  2. `buildSkillBlock`, `Skill` tool, CLI skills surface, 이후 autocomplete/search가 동일 snapshot의 `entries/lookup`을 사용하게 한다.
  3. 현재 `src/agent/tier1/skill.ts`와 `skills-surface.ts`의 독립 discovery/merge를 제거한다. snapshot publish는 session/turn boundary에서만 한다.
- **RED:** 같은 이름의 system/user/project fixture에서 prompt, Skill lookup, CLI list가 서로 다른 winner/order를 내는 contract test.
- **GREEN/DoD:** 한 precedence result, stable ordering, collision receipt, duplicate discovery 없음, gate OFF prompt/spec byte parity.
- **Stop:** 두 번째 registry/cache 또는 surface-local filesystem discovery가 남으면 후속 ticket admission 금지.

### RFC03-1 — ToolSearch skill-catalog mode (P0, S-M)

- **Depends:** RFC03-0.
- **Owner/write-set:** `src/skill/tool-search.ts`, `src/agent/tier1/skill.ts`, `tests/unit/tool-search.test.ts`, 신규 `tests/unit/tool-search-skill-mode.test.ts`.
- **Actions:**
  1. 기존 input에 `catalog: "tools"|"skills"`를 additive하게 추가하고 default를 `tools`로 유지한다.
  2. skill mode는 pinned `SkillRegistry.entries`에서 exact name, prefix, scope, category, stability filter와 deterministic tie-break만 제공한다. body는 exact `Skill` tool만 load한다.
  3. gate ON 실험군에서만 full skill inventory prompt를 제거한다. tool mode의 현재 weighted behavior는 호환성 baseline으로 그대로 둔다.
- **RED:** standalone discovery 또는 snapshot 밖 skill이 결과에 섞이고 exact lookup winner가 registry와 달라지는 test.
- **GREEN/DoD:** 새 tool/registry/scorer 없음, bounded metadata-only output, same snapshot lookup, tools mode schema/output regression 없음.
- **Stop:** fuzzy relevance가 필요하면 measured 별도 ranking RFC로 분리하며 이 ticket에 heuristic score를 추가하지 않는다.

### RFC03-2 — evidence-to-proposal compiler + immutable staging (P0, M)

- **Depends:** RFC03-0.
- **Owner/write-set:** `src/skill/skill-creator.ts`, 신규 `src/skill/proposal/types.ts`, `src/skill/proposal/compiler.ts`, `src/skill/proposal/port.ts`, host storage adapter, `src/skill/__tests__/skill-creator.hellgate.test.ts`.
- **Actions:**
  1. proposal input을 explicit source anchors/content hashes와 user invocation으로 제한한다. 반복 횟수·lexical similarity·memory score 자동 trigger는 없다.
  2. compiler가 runtime discovery와 동일 validator를 사용해 normalized `SKILL.md` bytes와 manifest를 만든다. `{proposalId,draftHash,targetPath,targetPreimageHash,sources,generatorVersion,validationReceipt}`를 content-addressed staging에 저장한다.
  3. host adapter는 existing `@/storage` realpath jail, canonical hash, atomic write를 조합한다. live skill directory에는 쓰지 않는다.
- **RED:** source drift, traversal/symlink escape, invalid runtime schema, mutable staged bytes가 proposal 성공으로 보이는 tests.
- **GREEN/DoD:** same input→same hash, staged bytes immutable, exact diff render 가능, proposal 생성 뒤 live registry unchanged.
- **Stop:** path-exists evidence, 새 hash/jail/atomic writer, model-generated target path authority가 필요하면 중단한다.

### RFC03-3 — existing approval + CAS promotion (P0, M)

- **Depends:** RFC03-2.
- **Owner/write-set:** `src/agent/approval-state-machine/types.ts`, `src/agent/approval-state-machine/store.ts`, existing permission request builder/dispatch seam, 신규 `src/skill/proposal/promote.ts`, approval/promotion integration tests.
- **Actions:**
  1. `ApprovalRequest`에 optional `artifactRef/artifactHash`를 추가하고 promotion tool input의 exact staged hash를 기존 approval request에 복사한다.
  2. 승인 시 staged bytes hash와 target preimage를 재검증한 뒤 CAS promote한다. deny/modify/expired/stale은 no-write terminal receipt다.
  3. promotion 성공 뒤 registry generation은 다음 turn/session boundary에서만 재생성한다. approval store/status semantics는 바꾸지 않는다.
- **RED:** 승인 후 staged bytes 변경, target concurrent edit, modified approval, duplicate promote에서 live bytes가 덮이는 tests.
- **GREEN/DoD:** exact approved hash만 1회 promote, stale preimage refusal, immutable receipt, current turn catalog pin 유지.
- **Stop:** 별도 proposal approval state machine/store 또는 tool-name 문자열 분기가 필요하면 중단한다.

### RFC03-4 — SKILLS/MEMORY external-config converters (P1, M-L)

- **Depends:** RFC03-2/3의 staging/promote contract.
- **Owner/write-set:** `src/migration/external-config/`, `src/migration/importer.ts`, `src/skill/migration.ts`, migration unit/integration tests.
- **Actions:**
  1. existing detect→convert→persist→ledger pipeline에 `skills`와 `memory` item type을 추가한다. converter는 staged artifact와 per-item provenance/diff만 생성한다.
  2. source-path classification을 authoritative mapping으로 고정해 동일 `CLAUDE.md`를 rules와 memory 양쪽에 넣지 않는다.
  3. preflight 전체 성공 후 promote하거나 per-item receipt/retry를 명시적으로 택한다. 기존 `src/skill/migration.ts` direct-copy apply는 같은 pipeline으로 route하고 별도 ledger를 만들지 않는다.
- **RED:** partial failure가 일부 live artifact를 남김, imported skill이 review 전 discovery됨, source가 double-import되는 fixtures.
- **GREEN/DoD:** preview exact diff/provenance, review 전 inert, retry idempotent, existing external-config ledger 하나, class별 trust receipt.
- **Stop:** converter가 live dir에 직접 쓰거나 authoritative MEMORY mapping을 정할 수 없으면 해당 class는 NOT READY다.

### RFC03-5 — token economy/product efficacy gate (P2, S)

- **Depends:** RFC03-0/1 product wiring.
- **Owner/write-set:** existing eval/bench harness와 feature flag config만. runtime ranking 변경 없음.
- **Actions:** 동일 task corpus에서 full inventory baseline과 skill-catalog mode의 prompt schema tokens, total tokens, task success, tool-call count, p95 latency를 같은 revision으로 기록한다.
- **GREEN/DoD:** predeclared non-inferiority bound 안의 task success와 material token 감소가 둘 다 충족될 때만 default-on 제안 가능.
- **Stop:** token 감소만 있고 성공률/latency가 악화되거나 corpus가 synthetic lookup-only면 efficacy claim을 하지 않는다.

### Landing rail

1. `bun test tests/unit/skill-registry-precedence.test.ts tests/unit/skill-registry-readonly.test.ts tests/unit/tool-search.test.ts`.
2. `bun test src/skill/__tests__/skill-creator.hellgate.test.ts tests/unit/approval-state-machine-hellgate.test.ts` + 신규 hash/preimage/CAS promotion fixtures.
3. `bun test tests/unit/external-config-migration-hellgate.test.ts tests/unit/external-config-migration-e2e-hellgate.test.ts tests/unit/skill-migration.test.ts`.
4. `rg -n 'discoverSkills\\(|discoverSystemSkills\\(' src/agent/tier1/skill.ts src/apps/cli/repl/skills-surface.ts`가 canonical snapshot cutover 뒤 0건이어야 한다.
5. `bun run typecheck`와 `bun test tests/unit/god-code-ratchet.test.ts`.

Rail 4는 보조 duplicate-call ratchet이며 runtime precedence/lookup parity test를 대체하지 않는다.

## Archived pre-correction draft (non-authoritative)

아래 내용은 최초 gap 가설과 adversarial audit 이력을 보존하기 위한 것이다. 구현 ticket/DoD/노력치는 위 current-HEAD correction과 README만 사용한다. README의 중복/휴리스틱 삭제 register와 충돌하는 archive 항목은 구현 후보로 복구하지 않는다.

### Original motivation

Three absorptions on quanta's **self-improvement** + **onboarding** north-stars:

- **C1 ProposeSkills (HIGH)** — close the "I just did X manually 3 times, propose a reusable skill" loop. Claude Code 2.1.220 ships `ProposeSkills` (corpus `sdk-tools.d.ts:2678`); quanta has the *authoring* half (`skill_create`) and the *evidence* substrate (memory `raw_memories.md`) but **no agent-callable draft-from-evidence → review-card flow**.
- **B2 Import UX (HIGH)** — quanta already has a broad translator + converter suite; the gap is **one-click coverage + UX**, plus **two missing item types** Codex's `external_agent_memory_import` enumerates (skills, sessions) and a trust-surface hardening pass on imported hooks/subagents.
- **A10 skill_search (MED)** — Codex `skill_search` = load-on-demand skill discovery for token economy. quanta has `ToolSearch` over the *tool* catalog but **no skill-catalog search**.

## 2. Non-goals

- No Anthropic/OpenAI hosted backends (ProposeSkills stays 100% local: draft→disk).
- No auto-activation of any imported artifact or proposed skill — **HITL is mandatory** (§Trust-model).
- No memory-consolidation redesign; ProposeSkills is a *reader* of existing memory files.
- No new heuristic thresholds for "when to propose" — the **model** decides; we only gate + validate (no-heuristics rule).
- Not absorbing Claude `REPL`/`Monitor`/`Workflow`/`RemoteTrigger` (separate RFCs / de-scoped in §7 of audit).

## 3. Current state (file:line — established deltas)

### 3.1 Skills system — MOSTLY BUILT
- **Discovery/load**: `src/skill/discover.ts:1` (`discoverSkills(dir)`, frontmatter parse, size cap, scope inference). System skills bundled under `src/skill/system-skills/*/SKILL.md` (23 skills incl. `onboard`, `product-onboard`).
- **Frontmatter SSOT**: `src/skill/skill-frontmatter.ts:60` (`SkillFrontmatterSchema` — strict, loud-fail, kebab `name`, `description`, `userInvocable`, `allowedTools`, `category`, `stability`, +ADR-0134 scope/installState).
- **Invoke**: `src/skill/skill-tool.ts` (`createSkillTool`, `$ARGUMENTS`/`$N` interpolation, inert-as-prompt).
- **★ Authoring (the ProposeSkills writer half already exists)**: `src/skill/skill-creator.ts:177` `createSkillCreatorTool(writer)` — scaffolds SKILL.md, validates against the **same** discovery schema (`validateScaffold`, line 138), enforces `MAX_SKILL_SIZE_BYTES` **before** write, kebab-re-validates `name` as path segment (line 194, defence-in-depth), routes through a jailed `SkillWriterPort`.
- **★ Jailed writer + gate**: `src/agent/tier1/skill.ts:78` `buildJailedSkillWriter(dir)` (`resolveJailed` FS jail, no-throw); registered ONLY when `runtimeConfig().skillCreator && dir !== undefined` (line 125). Knob `QUANTA_SKILL_CREATOR` (`src/shared/runtime-config.ts:298`, `runtime-config-knobs/knobs-a.ts:129`), gated-tools SSOT entry `src/tool/surface/gated-tools.ts:700`.
- **DELTA for ProposeSkills**: no *evidence-gathering* step, no *multi-proposal (1–3)* shape, no *review-card* (skill_create writes immediately on invoke; there is no HITL between draft and disk).

### 3.2 skill_search — MISSING (tool-search exists but wrong catalog)
- `src/skill/tool-search.ts:1` `createToolSearchTool(catalog)` = **`ToolSearch` over the TOOL registry** (`config.registry.specs()`, wired `tier1/skill.ts:119`). Lexical scorer (tokenize camel/snake/kebab, first-line weight, aliases, `select:` mode) is **directly reusable**.
- **DELTA**: no `skill_search` tool that ranks the **discovered Skill[]** by keyword and returns each skill's `name`/`description`/`SKILL.md` on demand. The scoring engine can be lifted; the input corpus differs (Skill vs ToolSpec).

### 3.3 Import — BROAD converter suite, two item-type gaps + UX
- **Session transcripts**: `src/migration/translators/index.ts` — `claude_code` real translator; `cursor`/`aider` = stubs returning `[]` (line 20).
- **Config artifacts** (`src/migration/external-config/`): `MigrationItemType` = `agents_md | settings | hooks | mcp | subagents | cursor_rules` (`types.ts:24`). Converters in `convert.ts` REUSE read-time parsers (`loadRepoRules`, `loadGlobRules`, `parseFrontmatter`). Detect probes home+project (`detect.ts:45`). Orchestration `run.ts` (Detect→throttle-ledger→convert). Persist `persist.ts` (atomic temp+rename, **no-follow-symlink jail** line 175/192, drops MCP `env` secrets `convert.ts` convertMcp, ledger records `imported`).
- **CLI surface**: `src/apps/cli/config-migration-notice.ts:85` — `quanta session import claude_code` (sessions) + `QUANTA_MIGRATE_CONFIG_IMPORT=1` restart for config. **Two-step, env-restart, not one-click.**
- **DELTA vs Codex `external_agent_memory_import` (§4.4)**: Codex enumerates `AGENTS_MD/CONFIG/SKILLS/HOOKS/MEMORY/SESSIONS`. quanta covers agents_md/config(settings)/hooks/sessions/subagents/mcp/cursor_rules but **MISSING: (a) SKILLS import** (`.claude/skills/*/SKILL.md` → quanta skills dir), **(b) MEMORY import** (`~/.claude/CLAUDE.md`-style memory → quanta memory), and **(c) a one-click command** (no env-restart).

### 3.4 ProposeSkills evidence source — memory files exist
- `src/memory/consolidate/paths.ts:17` `~/.quanta/memory/`; `types.ts:117` `MemoryDirPaths` = `{ root, memoryMd (MEMORY.md), rawMemoriesMd (raw_memories.md — append-only evidence trail), memorySummaryMd }`.
- Reader `src/memory/consolidate/reader.ts:33` `loadMemorySummary` (cap-checked, ENOENT→undefined). `raw_memories.md` is the **procedural evidence corpus** ProposeSkills `evidence[]` paths point into.
- **DELTA**: no reader that surfaces memory-file *paths* to a tool as candidate evidence, and no validator that a claimed `evidence[]` path actually resolves under the memory dir (anti-vacuous-invention hook — §Trust).

### 3.5 HITL kernel — reusable pattern present
- **Model to mirror**: `src/tool/permission-propose/index.ts` `permission_propose_pattern` — duck-typed closed **port**, all-or-nothing batch, no-throw→typed result, default-OFF via wired port. This is the exact shape ProposeSkills should copy (propose→port→typed outcome, model never self-activates).
- **Approval records**: `src/agent/approval-state-machine/types.ts:60` `ApprovalRequest{kind:permission|clarification|escalation, reason, proposedAction, resumeStep, options?, decision:approve|deny|modify}` + store (`store.ts`). NOTE `types.ts:22`: "**NOT yet wired into request_user_input**" — port+store layer only.
- **Hooks trust gate** (load-bearing for Import): `src/agent/command-hooks/gate.ts:41` `trustGate:false` default; `settings-loader.ts:108` — imported/repo-provenance hooks carry `needsReview` and are **INERT unless the trust gate is armed**. So an imported `settings.json#hooks` **does not auto-run** in the default runtime.

## 4. Design

### 4.1 C1 — `propose_skills` tool (evidence → LLM draft → HITL card → gated write)

New slice `src/skill/propose/` + tool. Pipeline (pure except final port hop):

1. **Evidence gate (anti-vacuous)** — a new closed `SkillEvidencePort` resolves each proposal's `evidence[]` path against the memory dir (`resolveMemoryDirPaths`) and repo. A proposal whose `evidence[]` is **empty OR contains a path that does not resolve under the memory/repo root** is **rejected** (`no_evidence` / `evidence_escape`). This structurally forbids "invent a skill from nothing" — the model must cite a real observed memory file. (Mirrors `permission_propose`'s baseline-coverage all-or-nothing.)
2. **Draft validate** — each proposal's `skillMd` runs through the **existing** `validateScaffold`/`SkillFrontmatterSchema` (`skill-creator.ts:138`) + `MAX_SKILL_SIZE_BYTES`. For `kind:"improvement"`, `target` MUST resolve to an existing discovered skill (else `unknown_target`); for `kind:"new"`, `name` must not collide with a **system** skill (system wins — cannot be shadowed).
3. **Review card (NO auto-write)** — the tool does **NOT** call the skill writer. It emits a `SkillProposalCard` through an injected `SkillProposalReviewPort` → the approval surface (CLI card / web) renders 1–3 proposals with `name/kind/target/description/evidence[]/skillMd` diff. Only on operator **approve** does the surface call the *existing* `buildJailedSkillWriter` → `SkillWriterPort.write`. `deny`/`modify` never touch disk. Tool result = `{proposalCount}` (matches `ProposeSkillsOutput`).
4. **Input schema** = exact Claude shape: `proposals: [{name, kind:"new"|"improvement", target?, description, evidence?:string[], skillMd}]` min 1 max 3.

**Reuse**: `skill-creator.ts` validators + jailed writer verbatim; `permission_propose_pattern` port/no-throw idiom; `approval-state-machine` record shape for the card.
**Gate**: `QUANTA_PROPOSE_SKILLS` — port wired only when on AND user skills `dir` present (same guard as skill_create, `tier1/skill.ts:125`). Absent ⇒ tool off, byte-identical.

### 4.2 B2 — Import expansion (coverage matrix + one-click)

| Codex `external_agent_memory_import` item | quanta today | Action |
|---|---|---|
| AGENTS_MD | `convertAgentsMd` (`convert.ts`) | ✅ have |
| CONFIG (settings) | `convertSettings` | ✅ have |
| HOOKS | `convertHooks` (inert unless trust-gate armed) | ✅ have + trust-harden (§Trust) |
| SUBAGENTS | `convertSubagents` | ✅ have |
| MCP | `convertMcp` (drops `env` secrets) | ✅ have |
| SESSIONS | `claudeCodeTranslator` | ✅ have |
| **SKILLS** | — | **NEW `convertSkills`**: scan `.claude/skills/*/SKILL.md` → validate through `SkillFrontmatterSchema` → write via jailed `SkillWriterPort`, marked `stability:experimental` + **`userInvocable` forced, needsReview** (untrusted) |
| **MEMORY** | — | **NEW `convertMemory`**: `~/.claude/CLAUDE.md`(memory form) → quanta `raw_memories.md` append (never `MEMORY.md` directly — must pass through consolidation) |
| cursor_rules | `convertCursorRules` | ✅ have (bonus) |

- Add `skills`, `memory` to `MigrationItemType` (`types.ts:24`) + `ALL_MIGRATION_ITEM_TYPES` (the closed-union drift-guard forces every new type to get a detect probe + converter — compile-fail otherwise).
- Add detect probes: `.claude/skills` (dir probe), `~/.claude/CLAUDE.md` memory (already an agents_md probe — disambiguate by content or keep as agents_md; see Open-Q).
- **One-click command**: new `quanta import claude` (and `quanta import cursor`) that runs Detect→convert→**renders a single review card listing every item**→on approve persists all. Replaces the two-step env-restart. Reuses `run.ts` orchestration + `config-migration-notice.ts` summary. The env knob `QUANTA_MIGRATE_CONFIG_IMPORT` stays as the *auto-offer-on-startup* gate (default-OFF); the explicit `quanta import` command is always available (it's user-initiated, so no auto-trust risk).

### 4.3 A10 — `skill_search` tool

New `src/skill/skill-search.ts` — **lift the `tool-search.ts` scorer** (extract `tokenize`/`splitDescription`/`score` into a shared `src/skill/lexical-rank.ts`, or import from tool-search if the fence allows). Corpus = the discovered `Skill[]` (name + description + body). Modes: `select:<name>` (exact) and keyword (ranked). Returns each hit's `name`, `description`, and (optionally, capped) SKILL.md body so the model loads a skill's full instructions **on demand** rather than paying for all 23 system skills' bodies up front.

- **Staleness**: the tool closes over `() => Skill[]` from the **same** `discoverSkills` result the session built (`buildSkillBlock`, `tier1/skill.ts:100`), so it can never rank a skill that isn't invocable, and never miss one that is (single source, no separate index to drift). NO persistent index (§Audit R3).
- **Gate**: `QUANTA_SKILL_SEARCH`. Default-OFF ⇒ not on menu, byte-identical. (Token-economy is `measure-first` — A/B before default-ON.)

## 5. Trust model (imported content is UNTRUSTED — jul-12)

- **ProposeSkills**: the model authors the draft, but (a) `evidence[]` must resolve to real memory/repo paths (no vacuous invention), (b) **nothing reaches disk without operator approve** (review card), (c) written skills are `stability:experimental`, (d) a proposal can never shadow a **system** skill.
- **Imported SKILLS**: written as `userInvocable` but **NOT auto-loaded into the trusted set** — marked untrusted-provenance so they surface with a review affordance; a system-skill name collision is refused (system wins, `tier1/skill.ts:106`).
- **Imported HOOKS** (crux): imported `settings.json#hooks` land on disk but are **INERT unless `command-hooks` trust gate is armed** (`gate.ts:41` default false; `settings-loader.ts:108`). We MUST NOT flip the trust gate on import. Imported hooks carry `needsReview` and require explicit per-hook trust. **A malicious imported `AGENTS.md`/hook cannot auto-execute** (jul-12 ci-bot rule-less posture holds: batch/ci-bot surfaces load NO repo rules).
- **Imported MEMORY**: appended to `raw_memories.md` only (evidence trail), never written straight to `MEMORY.md` — it must pass consolidation (which is itself gated).
- **Secrets**: MCP `env` dropped at convert (`convertMcp`); credential/symlink reads refused (`readImportFile`, `persist.ts:175` no-follow). ProposeSkills evidence reader is **read-only + path-jailed** to the memory dir (never emits file *content*, only cites paths on the card — user opens them).
- **DoS**: proposals capped 1–3 (schema); import file-count caps exist (`MAX_SUBAGENT_FILES=256`, `MAX_CONFIG_BYTES=4MiB`); add `MAX_IMPORT_SKILLS` cap.

## 6. Default-OFF gates (byte-identical when unset)

| Feature | Knob | Off ⇒ |
|---|---|---|
| ProposeSkills | `QUANTA_PROPOSE_SKILLS` | port not wired → tool absent from menu |
| skill_search | `QUANTA_SKILL_SEARCH` | tool absent |
| Import auto-offer | `QUANTA_MIGRATE_CONFIG_IMPORT` (exists) | no startup detect/prompt |
| `quanta import` command | always available (user-initiated) | n/a (explicit) |
| SKILLS/MEMORY converters | ride the import gate; new item types only run when import runs | — |

All new knobs via `gateOn` (`1/on/true/yes`), registered in `runtime-config` + `gated-tools.ts` SSOT (the drift-guard forces the entry or CI reds).

## 7. TDD + hellgate plan (leaf-crate units + real-loop e2e)

**RED e2e first** (each proves the seam, not a stub):
- `propose_skills.hellgate` — scripted-LLM emits a proposal with a **real** `evidence[]` path (planted `raw_memories.md`); assert: (1) NO file written to skills dir before approve (fresh-readback), (2) card emitted with N proposals, (3) on approve → SKILL.md on disk validates through discovery schema, (4) on deny → skills dir unchanged. **Red-on-injection**: proposal with a non-resolving `evidence[]` path → rejected `evidence_escape`, no card.
- `import-claude-oneclick.hellgate` — plant `.claude/{skills,agents,settings.json,CLAUDE.md}`; run `quanta import claude`; assert single card lists all item types; approve → each persisted at quanta location; **imported hook is INERT** (assert `command-hooks` does not run it with trust gate off — the load-bearing security test); malicious `../escape` skill name refused.
- `skill_search.hellgate` — discovered set of K skills; `skill_search` keyword returns ranked subset; `select:` exact; assert it can only return skills in the invocable set (no phantom/stale entry).

**Leaf-crate units** (`src/skill/propose/*`, `src/migration/external-config/convert.ts` new converters, `src/skill/skill-search.ts`) — pure, fake-port, no LLM. Mutation-baselined per test-quality culture (assert-then-narrow, real effect, paired control).

**3R adversarial** (§9) → self-audit → structural TDD backfill.

## 8. Effort & sequencing

- **skill_search (A10)** — S (~0.5d). Lift scorer, new tool, gate, units + 1 hellgate. Lowest risk, independent. **Do first.**
- **Import expansion (B2)** — M (~1.5d). 2 converters + detect probes + closed-union drift-guard + one-click command + trust hellgate. Depends on nothing.
- **ProposeSkills (C1)** — M-L (~2d). Evidence port + review-card wiring to approval surface is the real cost (approval-state-machine is "not yet wired to request_user_input" — may need the card render path built). **Do last / can parallelize with B2 (file-disjoint).**

Sequence: A10 → (B2 ∥ C1). All default-OFF, land byte-identical.

## 9. Risks + traps

- **Approval-card wiring gap**: `approval-state-machine` is port+store only (`types.ts:22`), not wired to `request_user_input`. ProposeSkills may be the first real consumer → budget for building the CLI/web card render path (or route through existing `request_user_input` as an interim, with the proposals serialized into the question). Do NOT claim "reuses existing card" without verifying the render seam exists.
- **skill_create already writes-on-invoke**: do NOT let ProposeSkills call `createSkillCreatorTool` directly (that bypasses the card). The writer is called *by the surface after approve*, not by the tool.
- **Import "already built" trap** (jul-18 graveyard): most import machinery EXISTS. Verify the 2 new converters are genuinely absent before building (they are — `MigrationItemType` has no `skills`/`memory`).
- **god-code**: keep `propose/` files <1000 lines; new converters are small (existing ones ~40 lines each).
- **Vacuous tests**: fake-port tests must assert real disk effect on approve + real no-op on deny (fresh-readback), not just "port called".
- **Memory-file `evidence[]` as exfil**: reader must be path-jailed + emit paths only, never content, to the card.

## 10. Open questions

- MEMORY import disambiguation: `~/.claude/CLAUDE.md` is currently probed as `agents_md`. Is Claude "memory" a distinct file, or the same CLAUDE.md? (Corpus §4.4 lists MEMORY separately — likely `~/.claude/` memory vs project CLAUDE.md. Confirm before adding a probe that double-imports.)
- Should imported SKILLS default `userInvocable:false` until user promotes (stricter), or `true` + review affordance? Leaning stricter (false) per untrusted posture.
- skill_search body inclusion: full SKILL.md (token cost) vs description-only + a follow-up `skill` invoke? Measure-first.

---

## Audit log R1 → R3 (adversarial — break it)

### R1 — Does ProposeSkills draw REAL evidence or vacuously invent skills? / review-gate bypass?
- **FINDING (real, HIGH)**: Claude's schema makes `evidence[]` **optional** (`sdk-tools.d.ts` `evidence?: string[]`). A model can emit `skillMd` with **no evidence at all** → pure invention, defeating the "distill from observed procedure" premise (self-improvement north-star becomes hallucinated-skill spam). **FIX**: §4.1 step-1 evidence gate makes evidence **mandatory + path-resolving** (empty or non-resolving ⇒ reject before card). This is stricter than Claude and is the anti-vacuous core.
- **FINDING (real, HIGH)**: naive impl would reuse `skill_create` which **writes on invoke** (`skill-creator.ts:237` writes immediately). If ProposeSkills wrapped skill_create it would write BEFORE review → gate bypass. **FIX**: tool never calls the writer; surface calls it after approve (§4.1 step-3, R1 "do NOT reuse skill_create directly" in traps).
- **FINDING (med)**: `kind:"improvement"` could target/overwrite a **system** skill. **FIX**: system-skill targets refused; new-skill name collision with system refused (system wins, `tier1/skill.ts:106`).
- Residual: card render path may not exist yet (→ R-open, moved to Risks §9).

### R2 — Import trust boundary: malicious imported AGENTS.md / hooks auto-trust?
- **PROBE**: does `quanta import claude` cause an imported hook to execute? **Traced**: `persist.ts` writes hooks to `settings.json#hooks`; `command-hooks/gate.ts:41` `trustGate:false` default + `settings-loader.ts:108` imported/repo hooks are `needsReview` and **INERT unless trust gate armed**. **VERDICT: no auto-exec** — provided we do NOT flip the trust gate on import. **HARDEN**: explicit invariant + hellgate assertion that an imported hook does not run with the gate off (§7 load-bearing test). jul-12 ci-bot posture (batch/ci-bot load no repo rules) is intact.
- **FINDING (real, med)**: imported **SKILLS** are a NEW write surface not previously in the import set — a malicious `.claude/skills/evil/SKILL.md` with a huge body or `../escape` name. **FIX**: route through the SAME `SkillFrontmatterSchema` + `MAX_SKILL_SIZE_BYTES` + kebab path re-validation + jailed writer (`skill-creator.ts` validators are the SSOT); mark untrusted-provenance; `MAX_IMPORT_SKILLS` cap. Verified the jail (`resolveJailed`) + no-follow-symlink (`persist.ts:175`) already refuse escapes.
- **FINDING (med)**: imported **MEMORY** written to `MEMORY.md` would inject untrusted text into the trusted memory prompt-inject channel. **FIX**: append to `raw_memories.md` only (must pass consolidation), never `memory_summary.md`/`MEMORY.md` directly.
- **FINDING (low)**: MCP `env` secrets — already dropped (`convertMcp`). OK.

### R3 — skill_search index staleness / god-code / vacuous / default-OFF
- **FINDING (real, med)**: a *persistent* skill index (build-once, query-later) would go **stale** when a session's skill set differs (repo skills, ProposeSkills just wrote one). **FIX**: NO index — `skill_search` closes over `() => Skill[]` from the **live** `discoverSkills` result (same set `createSkillTool` got). Ranking is computed per-call over the current set → cannot drift, cannot surface a non-invocable skill. Trade CPU (23 skills, trivial) for zero-staleness.
- **FINDING (med)**: lifting the `tool-search.ts` scorer risks a **god-module** if copied wholesale. **FIX**: extract shared `lexical-rank.ts` (tokenize/split/score) used by BOTH tool-search and skill-search — dedup, not fork. Verify `@/skill`↔`@/tool` fence permits the shared import or place the primitive in `@/shared`.
- **VACUOUS-TEST self-check**: every hellgate asserts a **real disk / real inertness** effect with fresh-readback, plus a red-on-injection twin (non-resolving evidence; escape name; hook-with-gate-off). A test that only asserts "port was called" is rejected per test-quality culture.
- **DEFAULT-OFF verified**: all three ride wired-port/knob gates (`QUANTA_PROPOSE_SKILLS`, `QUANTA_SKILL_SEARCH`, existing import gate); unset ⇒ tools absent, no detect, byte-identical default surface (mirrors `skill_create` `tier1/skill.ts:125` proven pattern).
- **EFFICACY honesty**: token-economy (skill_search) and "propose good skills" (ProposeSkills) are **unmeasured** → `measure-first`, default-OFF, no default-ON claim (no-optimistic-judgment rule).

**Self-audit note (planted-then-caught)**: R2 first drafted "imported hooks are safe because default-OFF" — but that conflates the *feature* gate with the *hooks trust* gate. Re-traced: the real guarantee is `command-hooks` trust-gate + `needsReview` inertness (`settings-loader.ts:108`), NOT the import knob. Corrected §Trust + R2 to cite the load-bearing gate.
