# ADR-0090: Declarative event-triggered agent automation (`trigger → agentic filter → agent spawn → run record`)

- **Status**: Proposed (design draft — NO implementation; default-OFF seam intended, byte-identical when unwired)
- **Date**: 2026-05-22
- **Related**: ADR-0049 (side-conversation seam — `src/agent/side-conversation/`), ADR-0041/0042 (subagent spawn + nickname pool), ADR-0068 (2-phase memory consolidator CAS file pattern — `src/memory/consolidate/`), RFC §13 (hook bus — `src/agent/hooks.ts`), Codex repo-local-rule ingestion (`src/agent/repo-rules.ts`), the `schedule`/`loop` SDK skills (existing cron/interval seam), [cursor-deep-dives.md §7.4](../analysis/code-agent-loop/cursor-deep-dives.md) (`aiserver.v1.AutomationsService` findings), [[cursor-3.2-absorption]], [[v0-dev-absorption-2026-05-21]] (deferred-as-variant regression trap).

---

## 맥락 (Context)

Cursor의 `aiserver.v1.AutomationsService`(31 unary methods, descriptor `Bby` @33833308; cursor-deep-dives.md §7.4)는 quanta가 **현재 다루지 않는 axis** — 선언적으로 *이벤트가 에이전트를 자율 기동*시키는 워크플로 레이어다. Cursor의 cloud Background-Agents/Bugbot 제품의 백본.

증거(deep-dive §7.4 verbatim 요약):

- **모델**: `Automation ⊃ Workflow{ triggers[], actions[], prompts[{prompt, effort: STANDARD|HARD}], memory_enabled, git_config, agent_options }`. 의미: **trigger(s) → (agentic filter) → agent prompt(s) as background Composer → action(s)**.
- ★ **Trigger oneof 8종**: `cron` / `git`(PR/push/CI/issue_labeled/label) / `slack` / `linear` / `webhook`(+API key mint) / `slack_channel_created` / `pagerduty` / `sentry`.
- ★ **`agentic_filter_prompt: str`** — trigger와 invocation 사이의 LLM 게이트. "이 이벤트가 에이전트를 깨울 가치가 있나?"를 판정 → `ALLOW`/`BLOCK`/`ERROR` + **rationale를 run에 기록**. (the non-obvious gem.)
- **per-automation memory**: `automation_id` scope 파일 bag, CAS(`expected_version` | `expect_missing` → `conflict: bool`), `memory_enabled` 게이트. quanta `src/memory/consolidate/` 3-file atomic writer + sha watermark CAS와 동형.
- **templates** (`WorkflowTemplate{ category, input_schema, mcp_hints }`) + **`BuilderCompletion`**(AI가 스펙 작성) + **git-backed `AutomationDeploySpec`**(automations-as-code: `source{repo, path, ref, commit_sha}`, `managed_by`).
- **로컬 cron이 절반 존재**: `LocalAutomationsCronContribution` (feature gate `local_automations`) — 60s tick → `trigger.type === "cron"` 매칭 → `composerService.createComposer({ localAutomation: true, text: prompt, unifiedMode: "agent" })`.

**quanta의 현재 상태**: 우리는 *진행 중인 턴*을 shape하는 레이어를 이미 갖췄다 —

- `src/agent/repo-rules.ts` — repo-local 규칙을 per-turn `<system-reminder>` authority로 주입.
- `src/agent/hooks.ts` — in-process `HookBus` (`pre_tool_use`/`post_tool_use`/`session_*`/`turn_start`); `pre_tool_use`는 `{deny}`로 도구 호출 차단 가능.
- `src/agent/side-conversation/` (ADR-0049) + subagent spawn (ADR-0041) — 에이전트 호출 경로.
- `src/memory/` + `src/memory/consolidate/` — CAS 파일 bag 패턴.
- `schedule`/`loop` SDK 스킬 — cron/interval로 프롬프트·슬래시 명령을 반복 실행하는 기존 seam.

**그러나 빠진 것**: rules/hooks/memory는 전부 *사람(또는 상위 에이전트)이 이미 시작한 턴* 안에서 동작한다. **이벤트를 보고 턴을 자율적으로 START**하는 선언적 레이어가 없다 — `schedule`/`loop`는 cron/interval로 *명령*을 돌릴 뿐, "이 이벤트가 에이전트를 깨울 가치가 있나"를 LLM이 판정하는 게이트도, automation별 격리 메모리·run 기록·validate/test/apply 라이프사이클도 없다. = **fresh axis**.

이 ADR은 그 axis의 **최소 core**를 제안한다. 외부 SaaS 커넥터(Sentry/Slack/Linear/PagerDuty/webhook)는 전부 skip — quanta의 로컬-우선·슬라이스 격리 원칙과 충돌하는 plumbing이다.

---

## 결정 (Decision)

`src/automation/` 새 모듈에 **default-OFF, 선언적 automation 레이어**를 도입한다. 핵심 엔벨로프는 Cursor에서 그대로: **`trigger → (agentic filter) → agent spawn → run record`**. 단 **2 trigger kind만**(cron + manual/test) 출하하고, `trigger` union은 확장 가능하게 두되 SaaS kind는 하나도 구현하지 않는다.

unwire 시(automation 레지스트리 미주입 + feature gate off) 에이전트 루프는 byte-identical — automation 모듈은 루프가 절대 구성·호출하지 않는다(hooks.ts·repo-rules.ts와 동일한 opt-in 규약).

### 제안 TS 타입 (in ADR — NO impl)

```ts
// src/automation/types.ts (제안)

/** Trigger union — EXTENSIBLE by design; 이번 라운드는 cron + manual만 출하.
 *  SaaS kind(slack/linear/webhook/pagerduty/sentry/git)는 union에 추가하지
 *  않는다(미구현이 아니라 의도적 부재 — negative invariant). */
export type AutomationTrigger =
  | { kind: "cron"; expr: string } // 5-field cron; 로컬 데몬 tick이 매칭
  | { kind: "manual" } // validate/test/수동 fire 전용 — 데몬이 절대 발화 안 함

/** Reasoning effort — Cursor STANDARD|HARD에 대응. quanta 기존 effort 어휘 재사용. */
export type AutomationEffort = "standard" | "hard"

/** 선언적 automation 스펙 — 최소 core. */
export interface AutomationSpec {
  /** 사람이 읽는 안정 식별자. per-automation memory scope key + run 기록 키. */
  readonly name: string
  /** default-OFF: false면 데몬이 trigger를 무시(스펙은 보존). */
  readonly enabled: boolean
  readonly trigger: AutomationTrigger
  /** trigger 발화 시 spawn될 에이전트에게 줄 프롬프트(작업 지시). */
  readonly prompt: string
  /** 모델 override(미지정 시 호스트 기본). */
  readonly model?: string
  readonly effort: AutomationEffort
  /** ★ THE GEM — trigger와 invocation 사이의 LLM 게이트. 미지정 시 게이트
   *  생략(trigger 발화 = 즉시 spawn). 지정 시: 이 프롬프트로 LLM에 "이 이벤트가
   *  에이전트를 깨울 가치가 있나?"를 물어 ALLOW/BLOCK/ERROR + rationale을 받고,
   *  ALLOW일 때만 spawn한다. rationale은 AutomationRun에 항상 기록. */
  readonly agenticFilter?: string
  /** per-automation memory bag(automation_id=name scope) 활성. 기존
   *  src/memory CAS 재사용. false면 memory 미부착(byte-identical no-op). */
  readonly memoryEnabled: boolean
}

/** agentic filter의 typed 판정 — deferred 함정 회피 위해 discriminated이 아니라
 *  단일 enum + rationale 필드(별도 이벤트 변종 추가 금지, 아래 invariant 참고). */
export type AutomationFilterVerdict = "allow" | "block" | "error"

export interface AutomationFilterResult {
  readonly verdict: AutomationFilterVerdict
  /** LLM이 내놓은 판정 근거 — 항상 run에 기록(BLOCK/ERROR도 audit 가능). */
  readonly rationale: string
}

/** 한 번의 trigger 발화에 대한 종결 기록(JSONL append, src/observability envelope 재사용). */
export interface AutomationRun {
  readonly automationName: string
  readonly triggeredBy: AutomationTrigger["kind"] // "cron" | "manual"
  readonly startedAt: number
  readonly finishedAt: number
  /** filter가 BLOCK이면 spawn 안 함 → status "filtered_out". */
  readonly status: "completed" | "filtered_out" | "error"
  /** agenticFilter가 있을 때만 채워짐. */
  readonly filter?: AutomationFilterResult
  /** status==="error"일 때 사람이 읽는 사유(filter ERROR 또는 spawn 실패). */
  readonly error?: string
}
```

### 발화 경로 (firing path)

```
[로컬 cron 데몬 tick (기본 60s, schedule/loop 스킬 seam 재사용)]
   │  각 enabled cron automation에 대해 trigger.expr 매칭
   ▼
[manual/test fire]  ─── validate/test/apply 라이프사이클 또는 CLI 수동 호출
   │
   ▼
① agenticFilter 게이트 (있을 때만)
   │  agenticFilter 프롬프트 + 이벤트 컨텍스트 → 기존 side-conversation
   │  (ADR-0049, read-only, low/medium effort) 1-shot → ALLOW/BLOCK/ERROR + rationale
   │  BLOCK → AutomationRun{status:"filtered_out", filter} 기록 후 종료(spawn 안 함)
   │  ERROR → AutomationRun{status:"error"} 기록 후 종료
   ▼  ALLOW (또는 filter 없음)
② agent spawn — 기존 호출 경로 재사용
   │  side-conversation/subagent(ADR-0041) 또는 runAgent 포크로
   │  AutomationSpec.prompt + model + effort를 그대로 전달
   │  per-automation memory bag(memoryEnabled 시) attach
   ▼
③ AutomationRun{status, error?, filter?} 기록 (JSONL append)
```

`createComposer` 직접 대응물은 quanta의 side-conversation/subagent spawn — Cursor의 `{localAutomation:true, text:prompt, unifiedMode:"agent"}`와 동형이다. **새 에이전트 진입점은 만들지 않는다**; automation은 기존 spawn seam의 호출자(caller)일 뿐이다.

### 라이프사이클: validate → test → apply

Cursor의 validate/test/apply를 로컬-우선으로 축소:

- **validate** — 순수 함수. `AutomationSpec`의 구조(cron expr 파싱 가능 여부, name 유일성, effort 도메인, agenticFilter 비어있지 않음 등)만 검사. 네트워크·spawn 없음.
- **test** — `trigger.kind`와 무관하게 **manual fire 1회**를 강제 실행해 filter→spawn→run을 dry하게 검증. cron automation도 test는 manual 경로로 즉시 1회 발화.
- **apply** — validate 통과한 스펙을 레지스트리에 등록(enabled면 데몬 매칭 대상이 됨).

### per-automation memory

`memoryEnabled === true`일 때 `src/memory/consolidate/`의 CAS 파일 bag 패턴을 `automation_id = spec.name`로 scope하여 재사용한다. Cursor의 `expected_version`/`expect_missing → conflict:bool`는 quanta consolidate writer의 sha watermark + 3-file atomic rename CAS와 동형 — **새 CAS를 발명하지 않는다**. memory 미사용 automation은 어떤 memory 파일도 안 만든다(byte-identical no-op).

---

## ★ agentic filter — 비명백한 gem (최소 core에도 포함)

`agenticFilter?: string`은 최소 core에서도 **반드시 포함한다**. 이것이 automation을 "멍청한 cron 트리거 + 프롬프트 실행"과 갈라놓는 지점이다:

- **노이즈 게이팅**: cron이 매분 깨도, "지금 실제로 행동할 변화가 있나?"를 LLM이 판정해 ALLOW일 때만 비싼 에이전트 턴을 spawn한다. 무의미한 spawn 비용/컨텍스트 오염 차단.
- **rationale 기록**: ALLOW/BLOCK/ERROR 모두 `AutomationRun.filter.rationale`에 기록 → 왜 깼는지(또는 안 깼는지)가 audit 가능. quanta의 "claim은 근거를 동반한다" 규율과 정렬.
- **기존 seam 재사용**: filter 판정은 별도 인프라가 아니라 **side-conversation(ADR-0049) 1-shot read-only LLM call**로 구현 가능 — low/medium effort, 도구 없음 또는 read-only 도구만. spawn될 본 에이전트와 분리된 가벼운 게이트.

filter 결과는 **별도 이벤트 타입이 아니라** `AutomationRun`의 OPTIONAL 필드(`filter?`)로만 표면화한다(아래 invariant — deferred-as-variant 함정 회피).

---

## 무엇이 portable / 무엇을 skip

### ✅ 흡수 (portable)

| 요소 | 근거 |
|---|---|
| **trigger → filter → invoke → run-record 엔벨로프** | fresh axis의 본체. 기존 spawn seam의 호출자로 구현. |
| **`agenticFilter` LLM 게이트 + rationale** | the gem. side-conversation 1-shot로 저비용 구현. |
| **per-automation memory** | 기존 `src/memory/consolidate` CAS 재사용 — 새 인프라 0. |
| **cron + manual 2 trigger kind** | cron = `schedule`/`loop` 스킬 seam에 이미 존재; manual = test/수동 fire. |
| **validate/test/apply 라이프사이클** | 로컬 순수 함수 + dry-run. SaaS 없이 가치. |

### ❌ skip (negative invariant — 의도적 부재)

| 요소 | 사유 |
|---|---|
| **모든 외부 connector** (Sentry / Slack / Linear / PagerDuty / webhook + slack_channel_created) | SaaS plumbing. OAuth/API-key mint/webhook 엔드포인트 = 로컬-우선·슬라이스 격리 원칙과 정면 충돌. `trigger` union을 확장 가능하게 두되 이번 라운드엔 union에 추가조차 하지 않는다. |
| **git trigger** (PR/push/CI/issue_labeled/label) | SaaS(GitHub/GitLab) webhook plumbing 필요. 로컬 git hook으로의 대응은 별도 검토 — 이번 core 밖. |
| **`WorkflowTemplate` + `BuilderCompletion`** | AI 스펙 작성기 = UX 편의, core 가치 아님. Tier 2 later. |
| **git-backed `AutomationDeploySpec`** (automations-as-code) | team 배포 기능. Tier 2 later — `source{repo,path,ref,commit_sha}` / `managed_by`는 협업 배포 도입 시 reference. |
| **`actions[]`** (post-agent 액션) | Cursor의 action 단계는 SaaS 통합(PR comment 등)이 주. quanta는 spawn된 에이전트가 도구로 직접 행동 → 별도 action 레이어 불필요. |

---

## rules/hooks와의 관계 (한 layer 위)

automation은 rules/hooks/memory보다 **한 layer 위**다. 축이 다르다:

| 레이어 | 시점 | 무엇을 하나 |
|---|---|---|
| `repo-rules.ts` | 진행 중 턴 | per-turn authority를 system-reminder로 주입 (shape) |
| `hooks.ts` (`HookBus`) | 진행 중 턴, 도구 호출 전후 | `pre_tool_use` deny 등으로 in-loop 동작 게이팅 (shape) |
| `src/memory` | 진행 중 턴 | recall/persist (shape) |
| **`src/automation` (이 ADR)** | **이벤트 발생** | **턴을 자율적으로 START** (initiate) |

rules/hooks/memory는 *이미 시작된 턴을 빚는다*. automation은 *이벤트를 보고 새 턴을 시작한다*. 한 automation이 spawn한 에이전트 턴은 그 자체로 다시 rules/hooks/memory의 적용을 받는다 — automation은 그것들을 대체하지 않고 그 위에 얹힌다.

---

## Default-OFF seam (feature gate)

Cursor의 `local_automations` feature gate에 대응. quanta에서:

- `AgentConfig`에 `automation?: { registry: AutomationRegistry; enabled?: boolean }` 형태의 OPTIONAL 필드 추가(미주입 = byte-identical). `repoRules?` / `hooks?` / `trustScope?` / `permissionStack?`와 동일한 opt-in 규약.
- cron 데몬은 별도 seam(`schedule`/`loop` 스킬 또는 전용 `src/automation/daemon.ts`)으로, automation 모듈이 주입되고 enabled일 때만 tick한다.
- `enabled === false`인 개별 스펙은 데몬이 무시(스펙은 레지스트리에 보존).

전부 absent이면 automation 모듈은 구성·호출되지 않는다.

---

## 대안 (Alternatives)

- **hooks.ts에 `cron_tick`/`event` 이벤트 추가** — 기각. HookBus는 *진행 중 턴 안의* 확장점이고 deny가 핵심 반환값이다. automation은 턴 밖에서 턴을 START하므로 의미 축이 다르다(위 표). HookBus에 욱여넣으면 "shape vs initiate" 경계가 흐려진다.
- **`schedule`/`loop` 스킬만으로 충분** — 기각. 스킬은 cron/interval로 *프롬프트·명령*을 돌릴 뿐, agentic filter 게이트·per-automation memory·run 기록·validate/test/apply가 없다. automation은 이들 스킬을 cron *tick source*로 재사용하되 그 위에 filter+memory+run 레이어를 얹는다.
- **filter를 별도 `AutomationFilterEvent` 변종으로** — 기각. [[v0-dev-absorption-2026-05-21]]의 deferred-as-ToolEvent-variant 회귀 함정과 동일: 새 이벤트 변종은 기존 narrowing switch를 깬다. filter는 `AutomationRun.filter?` OPTIONAL 필드로만.
- **SaaS connector를 stub만 깔아두기** — 기각. `R-NO-SHIM`(커밋 4a80bde) 위반 — 빠진 의존을 우회하는 stub 파일 금지. `trigger` union은 확장 가능하게 두되 미구현 kind는 추가조차 안 한다.

---

## 결과·트레이드오프 (Consequences)

- **얻는 것**: quanta가 "이벤트 → 에이전트 자율 기동" axis를 갖는다. agentic filter로 노이즈 spawn을 게이팅하고 rationale을 audit한다. 전부 기존 spawn/memory/cron seam 재사용 — 새 인프라 최소.
- **비용**: cron 데몬은 장기 실행 프로세스가 필요(60s tick) — CLI 단발 호출 모델과 다른 lifecycle. `src/automation/daemon.ts` seam이 이를 격리하고, 데몬 없이도 manual/test 경로는 작동.
- **보안**: automation이 spawn하는 턴도 admissibility 8-stage(ADR-0018/0031/0046/0050)의 적용을 받는다 — automation은 권한 게이트를 우회하지 않는다. agenticFilter LLM 게이트는 system-reminder data로 취급(injection 방어, `escapeReminderBoundary` 규약).

---

## 한계 (LIMITATIONS)

- (a) **NO implementation** — 이 문서는 설계 초안이다. 타입·발화 경로·라이프사이클은 제안일 뿐 코드/테스트 없음.
- (b) cron 데몬 lifecycle(누가 띄우나, 재시작 시 missed-tick 처리)은 impl 단계에서 결정 — 이번 ADR은 tick source가 `schedule`/`loop` seam이라는 방향만 고정.
- (c) per-automation memory의 정확한 디스크 레이아웃(automation별 디렉토리 vs scope key)은 impl에서 `src/memory/consolidate` 재사용 형태에 맞춰 결정.
- (d) agenticFilter의 이벤트 컨텍스트 직렬화 포맷(cron tick엔 페이로드가 거의 없음; SaaS trigger 부재로 풍부한 이벤트 데이터가 없음)은 manual fire 입력 shape으로 한정.

---

## 불변식 영향 (Invariants)

- **byte-identical default-OFF**: `AgentConfig.automation` 미주입 + feature gate off → 루프가 automation 모듈을 구성·호출하지 않음. `repoRules?`/`hooks?`와 동일.
- **ADDITIVE only**: 기존 hooks/rules/memory/side-conversation 표면 무변경. automation은 그 위의 새 호출자.
- **슬라이스 격리**: `src/automation`이 `AutomationSpec`/`AutomationRun` 소유; spawn은 `@/agent` side-conversation/subagent를, memory는 `@/memory` CAS를 import(역방향 의존 금지).
- **deferred-as-variant 회피**: filter 판정은 `AutomationRun.filter?` OPTIONAL 필드 — 새 이벤트 변종 추가 금지.
- **negative invariant (SaaS 부재)**: `AutomationTrigger` union은 `cron`/`manual` 2종만. SaaS kind(slack/linear/webhook/pagerduty/sentry/git)는 미구현이 아니라 **의도적 부재** — union에 추가하면 안 됨(추가 시 R-NO-SHIM stub 유혹).

---

## 구현 계획 (Implementation plan — 미래 impl 참고)

새 모듈 `src/automation/` (제안 파일 목록):

1. **`src/automation/types.ts`** — `AutomationTrigger`/`AutomationSpec`/`AutomationEffort`/`AutomationFilterVerdict`/`AutomationFilterResult`/`AutomationRun` (위 제안 타입). 순수 타입 + QuantaError 서브클래스(validate 위반용).
2. **`src/automation/validate.ts`** — 순수 `validateAutomationSpec(spec): ValidationResult`. cron expr 파싱, name 유일성, effort 도메인, agenticFilter 비어있지 않음 검사.
3. **`src/automation/filter.ts`** — `runAgenticFilter(spec, eventCtx, llm): AutomationFilterResult`. side-conversation(ADR-0049) 1-shot read-only call → ALLOW/BLOCK/ERROR + rationale 파싱. 미지정 시 항상 ALLOW.
4. **`src/automation/run.ts`** — `runAutomation(spec, trigger, deps): AutomationRun`. filter → (ALLOW면) spawn(side-conversation/subagent/runAgent) → memory attach(memoryEnabled) → run 기록 조립. test/manual fire의 진입점.
5. **`src/automation/registry.ts`** — `AutomationRegistry` (apply로 등록, enabled 스펙 조회). in-memory + 선택적 영속.
6. **`src/automation/daemon.ts`** — cron tick seam(기본 60s). enabled cron automation의 expr 매칭 → `runAutomation`. `schedule`/`loop` 스킬을 tick source로 재사용하는 어댑터. 미주입 시 데몬 미가동.
7. **`src/automation/index.ts`** — barrel.

배선:

8. `src/agent/types.ts` `AgentConfig`에 `automation?: { registry: AutomationRegistry; enabled?: boolean }` OPTIONAL 추가(opt-in, omit 시 byte-identical). `OPTIONAL_CONFIG_KEYS` 류 목록에 `"automation"` 추가.
9. AutomationRun JSONL append는 `src/observability` envelope 패턴 재사용.

단계 순서: (1) types + validate (순수, 테스트 쉬움) → (2) filter (side-conv 재사용) → (3) run + registry → (4) daemon seam + AgentConfig 배선. 각 단계 default-OFF 유지, 기존 테스트 무수정 통과 확인.
