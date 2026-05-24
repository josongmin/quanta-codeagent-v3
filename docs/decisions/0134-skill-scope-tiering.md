# ADR-0134 — Skill 7-scope tiering (builtIn / system / admin / team / repo / user / personal) + admin-enforced install

- **Status**: Proposed (2026-05-24, W4 of [[0130-extracted-source-absorption-roadmap]])
- **Related**: [[codex-system-skills-pattern]] (system skills baseline: `.system/` + SKILL.md frontmatter), [[codex-plugin-manifest-pattern]] (plugin manifest), [[may-21-cluster-integration-15-features]] (skill 흡수 1라운드)
- **References**:
  - Codex `comment-preload.js`: `skills.scope.{builtIn, system, admin, team, repo, user, personal}` enum (7 scope)
  - Codex install state: `adminInstalled` / `installed` / `recommended`
  - Codex `userdata/codex/skills/{rr, rr2, ss, briefing, chronicle}/SKILL.md` (real user-installed skills)
  - Codex `userdata/codex/skills/.system/{skill-creator, plugin-creator, skill-installer, openai-docs, imagegen}/SKILL.md` (system skills)
  - Codex `userdata/codex/vendor_imports/skills-curated-cache.json` (60+ curated skills registry)

## Problem

우리 현 skill system (post [[may-21-cluster-integration-15-features]]):

- **2 tier**: built-in skill (코드 안 박힘) + user skill (`~/.claude/skills/` 또는 repo `.quanta/skills/`)
- **No scope hierarchy**: admin/team/repo 구분 없음. enterprise enforce 불가
- **Discoverability 부재**: 어떤 skill이 어떤 scope에서 왔는지 메타 없음
- **Install state 없음**: 추천 vs 강제 vs 자율 install 구분 없음

Codex의 7-scope 모델 (R4 발견):

| Scope | Source | Install policy | Override |
|---|---|---|---|
| `builtIn` | Codex 코드 안 | 자동 | 불가 |
| `system` | `.system/` directory (Codex 제공 vendor skills) | 자동 | 사용자 disable 가능 |
| `admin` | Enterprise admin push (정책) | **강제 install** | 사용자 불가, audit 강제 |
| `team` | Team-shared (org repo) | 추천 | team admin이 변경 |
| `repo` | Repository `.codex-plugin/skills/` | 자동 (repo 내) | repo committer 변경 |
| `user` | `~/.codex/skills/` global | 수동 install | 사용자 |
| `personal` | 특정 device only (sync 안 함) | 수동 | 사용자 |

Codex install state: `adminInstalled` / `installed` / `recommended` — UI에 어떤 scope이고 강제인지 표시.

## Decision

7-scope skill registry + install state machine 도입. **Backward compat**: 현 `~/.claude/skills/` 및 `<repo>/.quanta/skills/`는 자동 `user` / `repo` scope에 매핑.

### 1. Scope enum + lookup precedence

```typescript
type SkillScope =
  | "builtIn"     // 코드 안
  | "system"      // <install>/system-skills/
  | "admin"       // <org-config>/admin-skills/ (org policy)
  | "team"        // <repo>/.team-skills/ (team-shared)
  | "repo"        // <repo>/.quanta/skills/ (repo-level)
  | "user"        // ~/.quanta/skills/ (user global)
  | "personal";   // ~/.quanta/personal-skills/ (device-local, sync 안 함)

// Lookup precedence: admin > repo > team > user > personal > system > builtIn
// 같은 name 충돌 시 precedence 적용 + 충돌 warning emit
```

**Precedence rationale**:
- `admin` 최우선 (org policy 강제)
- `repo` > `team` (현 작업 repo가 team 일반화보다 specific)
- `user` > `personal` (user는 sync, personal은 device-local — user가 cross-device truth)
- `system` > `builtIn` (system은 update 가능, builtIn은 frozen)

### 2. Install state field

SKILL.md frontmatter에 신규 field:

```yaml
---
name: my-skill
description: ...
scope: admin | team | repo | user | personal  # NEW, optional; absent = inferred from path
install_state: required | recommended | optional  # NEW, optional; admin scope이면 무조건 required
admin_installed_by: org-name                      # NEW, optional; admin scope 일 때 표시
allowed-tools: [Read, Grep, Bash, Edit]
user-invocable: true
---
```

### 3. Admin scope enforcement

- Admin 정책은 `<org-config>/admin-skills/` 디렉토리 + `org-policy.json` manifest
- Loader가 부팅 시 admin scope 모두 force-install (사용자 disable 불가)
- Audit log: `<repo>/.quanta/audit/skill-install.log` 에 admin install / removal 모두 timestamped record
- 사용자 manual disable 시도 → reject + 정책 위반 warning

### 4. Discovery + cache (Codex `skills-curated-cache.json` 패턴)

- `<repo>/.quanta/skills-cache.json` — 모든 scope skill의 metadata (name/description/scope/install_state/admin_installed_by)
- 부팅 시 lookup precedence 적용 후 cache build, 24h TTL
- `tools/skill-list` CLI: `--scope=admin|team|...` 필터

### 5. Migration

- 현재 `~/.claude/skills/` → `~/.quanta/skills/` (user scope, 자동 migrate)
- 현재 `<repo>/.quanta/skills/` → 그대로 (repo scope)
- 신규 admin/team/personal은 opt-in (디렉토리 만들어야 활성)

## Alternatives considered

1. **2-scope만 유지** (현재 builtIn + user): rejected — enterprise 진출 path 막힘. team/repo 분리 가치 큼.
2. **Precedence를 user 선택**: rejected — convention over configuration. Codex의 admin > repo > team > user > personal > system > builtIn precedence는 directness 원칙 따름.
3. **Org policy를 git repo 안 commit** (admin scope을 `.quanta/admin-skills/` in-repo): rejected — admin policy는 org-wide, single repo에 묶이면 안 됨. `<org-config>` directory는 별도 (보통 home dir 또는 ~/.config/org-name/).
4. **모든 scope에서 SKILL.md 같은 schema**: kept (이 ADR). Codex도 동일 SKILL.md schema 사용 (scope은 path inference로).

## Invariants preserved

1. **Backward compat 100%**: 현 `~/.claude/skills/`, `<repo>/.quanta/skills/` 그대로 동작. scope 자동 inference.
2. **SKILL.md frontmatter 기존 fields** (name/description/allowed-tools/user-invocable) 변경 없음.
3. **memory [[codex-system-skills-pattern]]** 보존: `.system/` directory + bundled resources 표준 디렉토리 패턴.
4. **closed-port** ([[branch-search-adr0083]]): SkillRegistry는 file system port inject. unit test 가능.
5. **smoke battery**: 기존 skill smoke test (memory [[smoke-fixture-system]]) 모두 pass — scope inference가 정상 작동 시 자동.
6. **audit trail**: admin install/removal 모두 timestamped log. 사용자 trust + enterprise compliance.

## Tradeoffs

- **7 scope = 복잡도 ↑**: 사용자가 어디에 skill 둘지 헷갈릴 수 있음. mitigation: `tools/skill-install <name> --scope=<scope>` CLI가 적절한 path에 install + scope 자동 set.
- **admin enforce = 사용자 자율 침해**: 일부 사용자는 admin skill disable 원함 (의도된 trade-off — enterprise policy의 본질). mitigation: admin scope 사용은 org 명시 opt-in (org-policy.json 없으면 admin scope 비활성).
- **precedence override 헷갈림**: 같은 name 충돌 시 어느 scope이 이겼는지 사용자 모를 수 있음. mitigation: 충돌 warning emit + `skills list` CLI에 effective scope 표시.
- **org-config directory 위치 불명확**: macOS/Linux/Windows 다름. mitigation: `$QUANTA_ORG_CONFIG_DIR` env var first, fallback `~/.config/quanta/org/`. windows는 `%APPDATA%\quanta\org\`.
- **vendor curated skills cache** (Codex의 60+ skill list)는 흡수 안 함 — vendor catalog 의존성. 우리 vendor cache는 V2 (skill marketplace 진출 후).

## Out of scope (deferred)

- **Vendor curated skill marketplace** (Codex `vendor_imports/skills-curated-cache.json` 60+ skill catalog) — V2 (W7 connectors REST API와 같이).
- **Skill auto-update** (admin scope skill 변경 시 자동 redeploy) — V2.
- **Skill signature verification** (admin scope의 supply chain trust) — V3.
- **Per-skill telemetry export** (which skill 사용된 빈도) — V2.

## Validation (post-implementation)

- [ ] 기존 `~/.claude/skills/` 모두 migrate 후 정상 동작
- [ ] 7 scope 각각 sample skill 1+개 설치 후 lookup precedence test
- [ ] admin scope force-install + 사용자 disable reject test
- [ ] skill-list CLI에 effective scope + install_state 표시
- [ ] 충돌 warning emit test (같은 name 다른 scope)
- [ ] admin install audit log 모두 timestamped + immutable
- [ ] smoke battery skill 테스트 byte-identical 회귀 0
