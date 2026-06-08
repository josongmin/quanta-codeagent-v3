# ADR-0512: skill 도구 스코핑 — 가용성(visibility) ⟂ 권한(permission) 2축 분리 + escalation UX

- **상태**: Accepted — P0~P2 LANDED + P3 코어 LANDED (3R 적대 어딧 통과). 잔여 surface 후속은 아래 §구현 현황.
- **날짜**: 2026-06-09
- **슬라이스**: `@/agent/loop/skill-gate`(가용성 술어 확장) · `@/agent/loop/stream-consume`(send-time spec 필터) · `@/agent/stream-callbacks`(deny→ask 라우팅) · `@/stream`(NEW 이벤트 페어) · surface 렌더러(CLI/web/IDE). NEW 슬라이스 없음 — 전부 기존 seam 확장.
- **게이트**: P0(nav-base carve-out)=**버그 픽스, 무게이트**. P1~P3(가용성 필터 + escalation)=`QUANTA_SKILL_SCOPE_V2`(`gateOnStrict`, default-OFF, byte-identical degrade).
- **관련**:
  - 대체/확장: ADR-0011(skill 도구 allowlist 강제 — 본 ADR이 "dispatch-time deny"를 "send-time filter + escalation"으로 승급)
  - 재사용(신축 금지): `src/agent/types.ts:163`(`onConfirm`/`ConfirmDecision`, ADR-0076 deny_and_steer) · `src/agent/control-request/`(ADR-0496) · `src/tool/ask-user/`(ADR-0494 elicitation 7-kind) · `src/tool/surface/manifest.ts`(`ToolRisk`) · `src/tool/registry.ts:39`(`isReadOnly`) · `src/agent/hitl-tier-registry.ts`(4-tier, `hand-off-required` 보안경계) · `src/stream/types.ts`(`plan_user_input_requested`/`_resolved` 인터랙티브 선례)
  - 메모리: `tool-surface-ssot`, `agent-state-observability-northstar`

## Context

스킬이 활성일 때 도구 접근 통제가 **세 동작 중 최악**을 한다. 가능한 동작은 ① 안 보이게(필터) ② 보이되 물어봄(ask) ③ 보이는데 막음(error)인데, 현재 ADR-0011 구현은 ③이다:

1. 도구 specs가 세션 시작에 `cfg.registry.specs()`로 한 번 굳어([session-bootstrap.ts:175](../../src/agent/loop/session-bootstrap.ts#L175)) 매 턴 **필터 없이** 전부 LLM으로 간다([stream-consume.ts:163](../../src/agent/loop/stream-consume.ts#L163)).
2. 그중 스킬 scope 밖을 모델이 부르면 dispatch 직전 `skillScopeDeny`가 `is_error:true` tool_result를 뱉는다([stream-callbacks.ts:183](../../src/agent/stream-callbacks.ts#L183)).
3. 결과: 모델한텐 `file_tree_summary`가 멀쩡히 보이고, **시스템 프롬프트는 그걸 탐색 1순위로 쓰라 강제**("ladder: file_tree_summary → glob → ls → read", [prompt-body.ts:194](../../src/agent/prompt-body.ts#L194))인데, 정작 부르면 빨간 에러. 사용자 UI엔 `✕ file_tree_summary skill-scoped`가 크래시처럼 뜬다.

근본 결함은 **가용성(모델이 도구를 볼 수 있나)과 권한(보이는 도구를 쓸 때 허락이 필요한가)이라는 직교 축이 하나로 뭉개진 것**이다. 경쟁사는 둘을 분리한다:

- **Claude Code**: `allowedTools`/`disallowedTools`(가용성 — CLI 인자로 모델 도구목록 자체를 필터, 막힌 건 **모델이 못 봄**) ⟂ `allow`/`ask`/`deny` 규칙(권한 — 호출 시 `can_use_tool` control request로 사용자에 prompt). 상태 `allow`/`ask`/`blocked`.
- **Codex**: `sandbox_mode`(read-only/workspace-write/danger-full-access — 뭘 할 수 있나) ⟂ `approval_policy`(untrusted/on-failure/on-request/never — 언제 묻나). `on-request`는 모델이 **justification 달고 escalation 요청** → 사용자 승인. 샌드박스에 막혀도 조용히 안 풀고 명시 permission-request를 띄움(감사 가능).

두 제품 모두 ① 스코프 밖은 **안 보이게**, ② 필요한 건 **물어보게** 한다. quanta만 ③(보이는데 막음)을 하고 있다.

## Decision

skill 도구 스코핑을 **두 직교 축 + 그 사이의 escalation 브릿지**로 재구성한다.

```
                       ┌──────────────────── tool 호출 ─────────────────────┐
                       │                                                    │
  ┌────────────────────▼─────────────────────┐                             │
  │ 축A: 가용성 (visibility) — send-time      │   ← 모델이 "볼" 수 있는 집합 │
  │   visibleSpecs =                          │                             │
  │     navBase  ∪  activeSkill.allowedTools   │                             │
  │   (스킬 없으면 = 전체 specs, byte-ident.)  │                             │
  └────────────────────┬─────────────────────┘                             │
        보임 │                          │ 안 보임(스코프 밖, mutating 등)     │
             ▼                          ▼                                   │
  ┌──────────────────────┐   ┌─────────────────────────────┐               │
  │ 축B: 권한 (HITL/perm) │   │ L3 escalation 브릿지         │               │
  │  none → 즉시 allow     │   │  모델이 그래도 부르면 →       │               │
  │  always-confirm → ask │   │  onConfirm ask("스코프 밖")  │◀──────────────┘
  │  hand-off-required →  │   │  + justification             │
  │     하드 deny(보안경계)│   │  승인→scope 확장, 거부→steer  │
  └──────────────────────┘   │  hand-off-required: escalate 불가│
                             └─────────────────────────────┘
```

### L1 — 가용성 필터 (축A, "안 열린 건 접근 자체를 차단")

스킬 활성 시 LLM으로 보내는 specs를 `navBase ∪ activeSkill.allowedTools`로 **필터링**한다. 스코프 밖 mutating/exec/network 도구는 모델이 **아예 못 본다** → fumble도 에러도 구조적으로 불가능.

- 구현 지점: specs가 세션 시작에 굳으므로([session-bootstrap.ts:175](../../src/agent/loop/session-bootstrap.ts#L175)), 필터는 **send 직전**([stream-consume.ts:163](../../src/agent/loop/stream-consume.ts#L163))에서 `filterSpecsByScope(session.specs, skillGate, registry)`로 매 턴 재계산(스킬은 턴 중간 `Skill` 호출로 켜지므로 send-time이 정답). 스킬 비활성 ⇒ `session.specs` 그대로 통과(byte-identical).
- `skillGate`에 `visibleScope(): Set<string> | undefined` 추가 — `undefined`(스킬 없음)면 필터 no-op.

### L2 — navigation base는 scope 무관 항상 가용 (지금 버그의 구조적 정답, P0)

현재 하드코딩 `SKILL_META_TOOLS = {Skill, ToolSearch}`([skill-gate.ts:9](../../src/agent/loop/skill-gate.ts#L9))를 **navBase**로 일반화한다:

```
navBase = EXPLORATION_LADDER ∪ META
        = { file_tree_summary, glob, ls, read, grep }  ∪  { Skill, ToolSearch }
```

- `EXPLORATION_LADDER`는 **프롬프트와 단일 진실원(SSOT)으로 공유**한다. 현재 [prompt-body.ts:194](../../src/agent/prompt-body.ts#L194)가 사다리를 문자열로 박고 있는데, 이걸 `@/agent/exploration-ladder.ts`의 상수 배열에서 파생시켜 프롬프트와 게이트가 **드리프트 불가**(ratchet으로 봉인). 프롬프트가 1순위로 미는 도구를 게이트가 막는 자기모순을 구조적으로 차단.
- 효과: `file_tree_summary skill-scoped` 에러가 사라지고, 스킬 작성자가 사다리 도구를 allowlist에 매번 안 넣어도 된다.
- L2는 게이트를 **더 관대하게** 만들지만 대상이 read-only 탐색 도구뿐 — 보안경계(`hand-off-required`)와 무관. **버그 픽스로 무게이트** 적용(단 `QUANTA_SKILL_SCOPE_STRICT=1`로 옛 엄격 동작 복원 가능한 escape hatch 제공).

### L3 — escalation 브릿지 (축B 연결, "필요한 건 물어보고 써라")

L1로 거의 다 안 보이게 막지만, 모델이 스코프 밖 도구를 **진짜** 필요로 하는 소수 케이스의 탈출구다. `skillScopeDeny`의 flat 에러를 **`onConfirm` ask로 교체**:

- 모델이 스코프 밖 도구를 부르면(L1 필터 우회 = 환각/캐시/명시요청), dispatch 대신 `onConfirm(action)` 호출. action에 `{tool, input, isReadOnly, shellCommand}` + NEW `scopeContext{activeSkill, reason, justification}`를 실어 보낸다(Codex `on-request` 모델).
- 사용자 응답(`ConfirmDecision`, [types.ts:163](../../src/agent/types.ts#L163) 재사용):
  - `allow` → 1회 허용 + `skillGate.observe`로 active scope에 추가(세션 내 재질문 X)
  - `deny` → tool_result 거부(에러 아님, 정상 거부)
  - `deny_and_steer`(ADR-0076) → 거부 + "다른 도구 써" 다음 턴 주입
- **`hand-off-required` 보안경계는 escalation 불가** — L1에서도 안 보이고, L3에서도 onConfirm 안 거치고 즉시 하드 deny([hitl-tier-registry.ts](../../src/agent/hitl-tier-registry.ts) `maxTier` 일방 ratchet 그대로). 즉 escalation은 `none`/`always-confirm` tier에만 열린다.
- dispatch-time `allow()`는 제거하지 않고 **defense-in-depth 안전망**으로 남긴다(L1 필터가 메인 UX, allow()는 모델 환각 대비).

## UI/UX (이 ADR의 1급 산출물)

핵심 원칙: **"스코프 밖"을 빨간 에러로 그리지 마라.** 필터되면 애초에 안 뜨고(L1), 진짜 호출되면 에러가 아니라 **인터랙티브 승인 카드**(L3)다. 현재 `✕ error`는 크래시처럼 읽혀 사용자를 불안하게 한다.

### 이벤트 계약 (surface-agnostic)

`@/stream`의 `AgentStreamEvent` union에 인터랙티브 페어를 추가한다(기존 `plan_user_input_requested`/`_resolved` 선례와 동형, [stream/types.ts:258](../../src/stream/types.ts#L258)):

```ts
| { type: "permission_escalation_requested"; id: string; tool: string;
    risk: ToolRisk; activeSkill: string; reason: string;
    justification?: string; options: EscalationOption[] }
| { type: "permission_escalation_resolved"; id: string;
    decision: "allow_once" | "allow_session" | "deny" | "deny_and_steer" }
```

surface 렌더러(CLI/web/IDE)는 이 이벤트를 **에러 슬롯이 아닌 승인 카드 슬롯**에 그린다. 두 surface가 같은 이벤트를 소비(SSOT) — `tool-surface-ssot` 원칙.

### 승인 카드 내용 (북극성: agent state 가시성 — `agent-state-observability-northstar`)

```
┌─ 승인 필요 ──────────────────────────────────────────┐
│ 스킬 'localize-fault' 범위 밖 도구 요청               │
│                                                      │
│   도구   edit            위험  ✎ mutating            │
│   이유   localize-fault는 read-only 탐색 스킬입니다   │
│   근거   "버그 원인을 src/foo.ts:42에서 수정하려 함"  │  ← 모델 justification
│                                                      │
│   [ 한 번 허용 ]  [ 이 세션 허용 ]  [ 거부 ]  [ 거부+지시 ] │
└──────────────────────────────────────────────────────┘
```

- 카드는 **왜 막혔는지 / 무슨 도구 / 위험도(read-only vs mutating, manifest `ToolRisk`) / 모델의 한 줄 근거**를 모두 표시 → 사용자가 무엇을 승인하는지 정확히 안다.
- "막힘(hard, 보안경계)"과 "승인 필요(ask)"를 **시각적으로 구분**: 보안경계는 회색 잠금 아이콘 + escalate 버튼 없음, ask는 노란 승인 카드.
- 옵션 4개는 `ConfirmDecision` verb와 1:1(allow_once/allow_session/deny/deny_and_steer). `allow_session`은 scope 확장으로 같은 도구 재질문 제거 → prompt-fatigue 방지.

### 가용성 가시성

`/state`나 상태 패널에 **현재 활성 스킬과 그 visible 도구 집합**을 노출(L1 필터의 결과를 사용자가 볼 수 있게). "왜 이 도구가 없지?"의 답을 UI가 직접 준다.

## 아키텍처 불변식 (ratchet으로 봉인)

1. **prompt ↔ navBase 단일 SSOT**: `EXPLORATION_LADDER` 상수가 프롬프트 문자열과 게이트 양쪽의 유일 출처. ratchet이 프롬프트의 사다리 도구가 전부 navBase에 있음을 강제(드리프트 시 CI red).
2. **가용성 필터 ⊇ dispatch allow()**: send-time `visibleScope`와 dispatch-time `allow()`가 **동일 술어**에서 파생(둘이 어긋나면 "보이는데 막힘"이 재발). 한 함수로 봉인.
3. **보안경계는 양 레이어 공통**: `hand-off-required`는 L1에서 invisible + L3에서 non-escalatable. escalation이 보안 tier를 풀 수 없음을 hellgate로 증명(red-on-injection).
4. **default-OFF byte-identical**: 스킬 비활성 OR `QUANTA_SKILL_SCOPE_V2` OFF ⇒ 기존 경로(전체 specs, ADR-0011 deny) 그대로. P0(L2)만 무게이트 버그픽스.

## 단계

- **P0 (now, 무게이트 버그픽스)**: navBase carve-out(L2). `EXPLORATION_LADDER` SSOT 추출 + `SKILL_META_TOOLS`→navBase 일반화 + prompt↔navBase drift ratchet. ~2파일. `file_tree_summary skill-scoped` 즉시 해소. TDD: 스킬 활성 상태에서 `file_tree_summary`/`glob`/`ls`/`read`/`grep` allow() 통과 red-first.
- **P1 (`QUANTA_SKILL_SCOPE_V2`)**: 가용성 필터(L1). `skillGate.visibleScope()` + `filterSpecsByScope`를 stream-consume send-site에 배선. 헬게이트: 스킬 활성 시 visible specs = navBase∪allowlist, 비활성 시 == 전체.
- **P2 (escalation 코어)**: `skillScopeDeny`→onConfirm 라우팅(L3) + `scopeContext`/justification + `observe` scope 확장. 보안경계 non-escalatable hellgate.
- **P3 (UI/UX)**: `permission_escalation_requested`/`_resolved` 이벤트 + CLI/web/IDE 렌더러 카드 + `/state` visible-tools 노출. surface SSOT ratchet.

각 단계 독립 PR. P0은 단독으로 사용자 체감 버그를 끝낸다.

## Default posture / 안전성

- P0: read-only 탐색 도구만 더 허용 — 보안경계 무관, byte-identical 외 영향 없음. `QUANTA_SKILL_SCOPE_STRICT`로 복원 가능.
- P1~P3: `QUANTA_SKILL_SCOPE_V2` strict default-OFF. OFF ⇒ ADR-0011 동작 그대로.
- 보안: escalation은 `hand-off-required`를 절대 못 푼다(L1 invisible + L3 즉시 deny). HARD_DENY 셸 규칙([permission/types.ts](../../src/permission/types.ts) `shellCommand` 게이트)도 escalation 무관하게 dispatch 시 그대로 적용 — escalation은 "스킬 scope"만 풀지 "보안 정책"은 못 푼다(두 게이트 직교).
- 신뢰축(opt): third-party 플러그인 스킬은 escalation 카드에 "미신뢰 스킬" 경고 배지. first-party system-skill은 일반 카드. (P3 이후, `src/skill/plugin-loader` provenance 활용.)

## 대안 (기각)

- **Codex식 "스킬은 도구통제 없음, 전역 sandbox+approval만"**: quanta의 skill allowlist(ADR-0011)는 이미 출시됨 + 스킬별 포커싱 가치가 있어 제거는 회귀. 대신 그 위에 가용성/권한 분리를 얹는다.
- **dispatch-time deny 유지하고 메시지만 부드럽게**: 근본(보이는데 막힘) 미해결 — 모델은 여전히 fumble하고 토큰 낭비. DROP.
- **모든 read-only 도구를 navBase로**: 너무 광범위(read-only 네트워크/민감 도구 포함 위험). navBase는 프롬프트가 강제하는 탐색 사다리 + meta로 한정, 나머지 read-only는 L1 필터/L3 escalation 대상.
- **specs를 세션 시작에 스킬별로 미리 필터**: 스킬은 턴 중간 활성화되므로 불가 — send-time 재계산이 유일 정답.

## 구현 현황 (2026-06-09 — 3R 적대 어딧 후)

LANDED + 3라운드 적대 어딧(보안/정확성/테스트품질 병렬)으로 경화. 실버그 3 + 동어반복 ratchet 1 + 커버리지 갭 다수 수정.

- **P0 (무게이트, LANDED)**: `@/agent/exploration-ladder`(EXPLORATION_LADDER/READ_ONLY_EXPLORATION SSOT) + skill-gate `isAlwaysInScope`(nav-base, **정규화** META+ladder). `file_tree_summary skill-scoped` 버그 해소. drift ratchet은 **독립 리터럴 앵커**(`PROMPT_LADDER_LITERAL`)+프롬프트 regex 파싱으로 비동어반복(어딧 R1).
- **empty-allowedTools = nav-base seal**(사용자 결정): `observe`가 declared `[]`(present)면 빈 scope arm→nav-base만 통과(briefing은 탐색 가능 + sealed는 ordinary 차단), absent면 무scope. jun-8 briefing-fix vs 옛 sealed-e2e 모순 해소.
- **P1 (`QUANTA_SKILL_SCOPE_V2`, LANDED)**: `filterSpecsByScope`(=`gate.allow` 재사용 → 불변식#2 by-construction) @ stream-consume send-site, V2 게이트. 비활성/스킬없음 ⇒ SAME ref(byte-identical).
- **P2 (LANDED)**: `decideScopeEscalation` tier×mode 라우팅(hand-off→hard_deny / bypass·acceptEdits→dispatch / always-confirm→자기게이트 위임 / none·pre-approval-ok→ask). 승인→`widenScope`(별도 `widened` Set, **same-skill re-observe 생존 / skill 변경 시 리셋** — 어딧 R1). 미등록 도구→deny 가드(어딧 R1). 보안경계는 onConfirm 미호출(non-escalatable). approved는 dispatchTool로 라우팅→HARD_DENY downstream 강제(보안 자동보장).
- **P3 코어 (LANDED)**: 이벤트 `skill_scope_decision`(요약, blocked 포함 전 outcome) + `permission_escalation_requested`/`_resolved`(인터랙티브 페어, ask 경로만; 보안경계 미발화 hellgate). emit hooks(`onEscalationRequested`/`Resolved`) on decideScopeEscalation. stdout 승인 카드(YELLOW, 빨간에러 아님) + resolved 라인. jsonl-recorder: summary skip, pair durable. `scopeContext` on ToolAction. exhaustive sink + cross-slice `ToolRiskMirror` ratchet.
- **테스트**: skill-gate / escalation / emit-hooks / drift / stdout-card 단위 + e2e(V2-OFF byte-identical / nav-base seal / ask·widen·페어 / L1 필터 onTurnStreamInput / declined / steered / blocked·요약 일관성). 3R 어딧이 불변식 #1-#4 전부 ratchet 확인.

### 잔여 후속 (surface 통합 — P3+)
- **`/state` visible-tools 노출**: `buildSkillScopeView`(`@/agent/loop/skill-scope-view`, 빌더+5단위테스트 LANDED) **미export·미배선**. (왜) "왜 이 도구가 없지"의 답을 UX가 직접 줘야 함(북극성=agent state 가시성). (ROI) 빌더 완성됨 → export+`/state` 1곳 배선만 남음, 저비용 고가시성.
- **web/IDE 카드 렌더**: 페어 이벤트 stdout만 렌더(테스트됨). web/IDE는 default 처리(에러 아님, tsc green). (왜) 멀티-surface SSOT 약속. (ROI) 이벤트 계약 완성됨 → 각 surface 렌더러 case 추가, surface별 중간.
- **모델 justification 시드**: 카드 `justification` 슬롯·렌더 존재하나 모델이 채울 seam 없어 항상 빈값. (왜) Codex on-request식 근거 표시. (ROI) tool-call에 rationale 첨부 메커니즘 필요, 중간-높음.
- **`allow_once` 실동작**: 카드는 4버튼 제시하나 `ConfirmDecision`이 once/session 비트 없어 approve=allow_session(widen)로 귀결(코드에 KNOWN LIMITATION 명시). (왜) "한 번만" 승인 UX. (ROI) `ConfirmDecision` 확장(공유타입) 필요, 중간.
