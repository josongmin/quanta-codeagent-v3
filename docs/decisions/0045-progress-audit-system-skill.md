# ADR-0045: progress-audit system skill (bundled, code-evidence audit discipline)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**:
  - ADR-0011 (skill 토큰 scope enforcement) — host loop가 `skillAllowlists` 게이트를 운영하는 SSOT.
  - ADR-0022 (skill 트리거) — description 기반 trigger matching이 본 skill의 entry point.
  - ADR-0029 (reviewer three-tier) — reviewer tier가 "누가 confirm을 결정하는가"라면 본 ADR은 "어떤 audit discipline을 따라야 하는가"로 직교.
  - ADR-0040 (skill vs extension + 6-필드 frontmatter) — `category: skill` / `stability: stable` SSOT.
  - ADR-0047 (HITL 4-tier gate) — progress-audit invocation은 read-only(`Skill` tool은 `none` 티어). 본 skill body는 mutator를 허용하지 않으므로 audit run 자체가 HITL critical action을 발생시키지 않음.
  - memory: [[codex-system-skills-pattern]] / [[codex-desktop-build-2867-round-4]] §F.

## 맥락

사용자가 quanta-v3에서 "이 기능 진행률 알려줘" / "code-only" / "코드 레벨로만"
/ "P0/P1/P2" 같은 검증 요청을 보낼 때, 에이전트가 **코드 증거** 대신 **문서**
(plan, README, RFC)를 1순위 evidence로 다루는 경향이 반복 관측됨. 결과:

- 코드는 stub인데 plan 문서가 "done"이면 "완료"로 보고.
- `rg` 한 줄 hit를 implemented proof로 끌어다 씀.
- 검증 단계 (실제 test run, type check) 없이 "완료" 라벨 부여.

이 패턴은 audit honesty에 치명적이지만, prompt level의 1회성 지시로는
session마다 다시 reset됨. Codex Desktop이 이미 같은 문제를 `code-only-
progress-audit/SKILL.md`로 해결 — 6개 P0 규칙 + 7-step 절차 + 3-value
outcome enum (`success`/`partial`/`uncertain`, `complete` 금지). Codex
패턴을 그대로 흡수하되 quanta-v3 toolchain (bun test / biome / `rg`) 표현
으로 맞춤.

## 결정

### Part 1 — 시스템 스킬 파일 + 디스커버리 시드

`src/skill/system-skills/progress-audit/SKILL.md` 신규 — quanta-v3 binary와
함께 ship되는 SSOT skill 파일. user-supplied `QUANTA_SKILLS_DIR` 와는
**별도** layout (framework code-tree 안).

`src/skill/system-skills/index.ts`에 `discoverSystemSkills()` +
`systemSkillsDir()` export. 내부적으로 기존 `discoverSkills(dir)`를
재사용 — 별도 parser/loader 만들지 않음 (slice isolation 유지).

### Part 2 — host wiring: `buildSkillFeatures` merge

`src/agent/features.ts`의 `buildSkillFeatures`가 user skills + system
skills를 merge:

```ts
const userSkills = await discoverSkills(dir)
const systemSkills = await discoverSystemSkills()
const byName = new Map<string, Skill>()
for (const s of userSkills) byName.set(s.name, s)
for (const s of systemSkills) byName.set(s.name, s) // ← system wins on collision
```

**보안 invariant**: 같은 이름의 user skill이 있어도 system skill이 이김.
사용자가 `progress-audit`라는 이름으로 약한 정책의 skill을 ship해서
audit discipline을 silently degrade하는 attack vector 차단.

### Part 3 — frontmatter dual-shape

SKILL.md는 다음을 **둘 다** 담음:

1. **lenient field** (`tools: ["Read", "Grep", "Bash"]`) — 기존
   `src/skill/frontmatter.ts` + `discover.ts` 경로가 읽어서
   `skillToolAllowlist` → `features.skillAllowlists` → 디스패치 게이트로
   흘러감. 즉, 런타임 enforcement가 이쪽으로 동작.
2. **strict 6-field** (`userInvocable: true` / `allowedTools: [...]` /
   `category: skill` / `stability: stable`) — ADR-0040의 SSOT shape.
   당장 호출하지는 않지만 classify routing이 활성화될 때를 위한 metadata.

**dual-shape 비용**: `parseSkillMarkdown` (strict)으로 이 파일을 직접
재파싱하면 `.strict()` Zod가 `tools:` extra key를 reject (단위 테스트가
이 사실을 명시적으로 pin). 즉, 현재 progress-audit SKILL.md는
**strict parser를 round-trip하지 않는다**. follow-up에서 두 parser를
단일화하거나, lenient에 `allowedTools` alias를 추가하면 해소.

### Part 4 — Skill body 콘텐츠 (6 P0 + 7 steps + outcome enum)

**6 P0 critical rules** (위반 시 audit 무효 + 재시작):

1. No finding without code evidence
2. No grep-only proof (must trace to behavior or test)
3. No "looks fine" without explicit review scope
4. Partial proof ≠ closed
5. Default review-only (no edits unless asked)
6. Stub / fallback / degraded rails must stay visible

**7-step 절차**: 1) restate contract → 2) build evidence (code/tests
first) → 3) trace ONE production path (file:line per claim) → 4) split
into lanes (contract/runtime/consumer/tests) → 5) freeze findings as
`implemented`/`partial`/`blocked` → 6) verify with narrowest trustworthy
command → 7) report (%/implemented/partial/blockers/P0/P1/P2).

**Outcome enum**: `success` | `partial` | `uncertain` — `complete`는
명시적으로 금지 단어.

## 근거

- Codex의 같은 패턴이 그쪽 audit reliability를 측정 가능하게 끌어올린
  사실은 메모리 `codex-system-skills-pattern`에 정리됨. 같은 문제 면적,
  같은 해법 — 흡수가 안 할 이유 없음.
- system skill을 **bundled**로 ship하는 결정: 사용자가
  `QUANTA_SKILLS_DIR`를 설정하지 않은 default 상태에서도 audit discipline
  은 살아 있어야 함. user-config 의존 시 silent degrade.
- system-wins-on-collision: 보안 default. 약한 audit를 사용자가 shadow할
  수 없게.

## 대안

- **inline system prompt에 6-rule 추가**: 기각 — system prompt cache prefix
  byte-stability (ADR-0004)에 충돌, 매 session inflated.
- **extension category로 시스템 hook 만들기**: 기각 — 이건 LLM이
  trigger해서 따라야 하는 *지침* 이지 hook이 아님. ADR-0040 분류상 skill.
- **user-supplied가 system을 override 허용**: 기각 — Part 2 보안 invariant
  설명. 약한 audit discipline을 silent shadow 가능.
- **lenient `tools:`만 / strict 6-field만**: 기각 — 현 codebase에서
  enforcement는 lenient를 읽고 classify routing은 strict를 SSOT로 봄.
  둘 다 담고 한계 (§한계 (a))를 명시하는 게 정직.

## 결과·트레이드오프

- **얻은 것**: "진행률" / "code-only" 같은 trigger가 들어오면, 모델이
  자동으로 SKILL.md body의 6 규칙을 따르도록 시스템적으로 강제됨. host
  enforcement gate (ADR-0011)이 progress-audit invocation 후 Read/Grep/
  Bash 외 도구를 dispatch level에서 거절 — Edit / Write 같은 mutator로
  audit이 silently turn into "fix"하지 않음.
- **비용**: `buildSessionFeatures`의 `config.skills` 분기가 이제 user dir
  와 무관하게 system-skills를 IO read함 (worktree-fork 등의 hot path는
  아님 — session start 1회). 기존 `features.test.ts` 5개 테스트가
  "skillAllowlists is undefined" / "skill catalogue is empty" 가정에
  의존하던 부분 갱신 필요 (이번 패치에 포함).

## 한계 (LIMITATIONS)

- **(a) frontmatter dual-shape**: 위 Part 3 참조. progress-audit SKILL.md
  는 strict parser를 round-trip하지 않음. lenient discoverer (`Skill.tools`
  로 push)만 SSOT. 단일화는 별도 ADR.
- **(b) `bun build --compile` 번들과 SKILL.md 동봉**: 현재 `bun run`
  source-tree 실행에서는 `import.meta.url` 기반 resolve가 정상 동작. 향후
  compile 시 SKILL.md를 binary에 함께 포함하는 packaging은 별도 작업
  (현 단계 source-tree 실행만 검증).
- **(c) 슬래시-명령 라우터 seam (router-agnostic wiring)**: ADR-0040
  §한계 (a)와 같은 위치 — v3에는 centralized slash-command router가 아직
  없음 (`src/apps/cli/slash-commands.ts` 미존재). 본 ADR follow-up으로
  **Option 2 (router-agnostic seam)** 채택:
  `src/skill/system-skills/progress-audit/index.ts`에 `PROGRESS_AUDIT_SKILL
  _NAME` 상수와 `triggerProgressAudit()` 헬퍼를 export. 외부 router (CLI
  slash, IDE plugin, planner UI, voice shortcut)는 이 함수를 호출해서
  반환되는 `{ name: "progress-audit" }`를 기존 `Skill` 툴 dispatch에
  먹이면 됨 — 라우터와 skill이 lockstep으로 drift하지 않도록 skill 측이
  SSOT 보유. Option 1 (skill-tool 내부 hook)을 채택하지 않은 이유: skill-
  tool은 slice-isolated이고 slash 라우팅은 그쪽 책임이 아님. router 자체
  구현은 별도 ADR로 처리 (CLI vs Web vs IDE surface 결정 필요).
  - LLM의 trigger description matching은 여전히 1차 경로 — description에
    한국어 trigger 표현 ("진행률" / "코드 레벨로만" / "P0/P1/P2" /
    "문서는 보지 말고") 적극 포함하여 keyword match 누락을 줄임.
- **(d) `allowedTools` 적용 enforcement는 lenient 경로**: strict
  `parseSkillMarkdown`이 이 파일을 reject하므로 strict 기반 `assertAllowed
  Tool` enforcement는 unreachable. host loop가 사용하는 ADR-0011
  enforcement seam은 lenient `tools:`이므로 실제 보안 게이트는 동작 (단위
  + 통합 테스트가 둘 다 증명).

## 불변식 영향

- **슬라이스 격리 유지**: `src/skill/system-skills/`는 `@/skill` 내부.
  외부 import 없음 (`discoverSkills` 재사용만).
- **신규 npm dep 0**: SKILL.md 파일 + 작은 helper 1개.
- **cache prefix byte-stability (ADR-0004) 보존**: system prompt와 무관
  (skill body는 dynamic reminder에 들어가지 system 프리픽스에 들어가지
  않음 — `tests/unit/skill-trigger-rules.test.ts` "activeSkills do NOT
  shift the cached system prefix" 가 이미 pin).
- **RFC §1.2 default-OFF**: `config.skills`가 unset이면 system skill도
  발견되지 않음 (gate가 `if (config.skills)` 안에 살아 있음). skill을
  켜는 사용자만 progress-audit 노출.
- **HITL 4-tier (ADR-0047) 호환**: progress-audit invocation 자체는
  `Skill` 툴이고 `BUILTIN_TOOL_ANNOTATIONS`에 entry가 없으므로 default
  `pre-approval-ok`로 분류되지만, skill의 lenient `tools:` 게이트가
  Read/Grep/Bash만 통과시키므로 mutator (Edit/Write/apply_patch) dispatch
  자체가 봉쇄됨. 즉, progress-audit 안에 머무는 한 hand-off-required /
  always-confirm 액션은 발생 불가능 — audit "report-only" 의도가 두 레이어
  (skill allowlist + HITL tier table)에서 독립적으로 보장됨.

## 소스 attribution

본 skill의 6 P0 규칙 + 7-step 절차 + outcome enum 구조는 Codex Desktop의
번들 skill `~/.codex/memories/skills/code-only-progress-audit/SKILL.md`
에서 차용 (system-bundled 자료, user-private 아님). quanta-v3 toolchain
(`bun test`, `biome`, `rg`) 표현으로 어휘 교체. 메모리:
`codex-system-skills-pattern`.
