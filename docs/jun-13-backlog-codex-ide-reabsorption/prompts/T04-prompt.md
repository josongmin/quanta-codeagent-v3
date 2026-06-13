# 구현 프롬프트 — T04: hooks 신뢰게이트(`needsReview`) + source

## 미션
`HookGroupSetting`/`HooksSettings`에 `source`(managed/project/user/imported)+`needsReview`를 추가해, imported/project hook이 활성 전 사용자 review를 거치게 한다(무검토 셸 실행=RCE 차단). 이벤트셋도 Codex 10종에 맞춰 갭 보강. per-hook model은 셸 hook엔 무의미 → 현 스코프 N/A. default-OFF.

## 정본 스펙
`docs/jun-13-backlog-codex-ide-reabsorption/04-hooks-trust-gate-and-model.md` 정독. 통합 `00-index.md §8`.

## 🛑 헬게이트 프로토콜 (메모리 `hellgate-implementation-protocol`)
1. **헬게이트 RED 셋업**: 유즈케이스 e2e 먼저, 전부 RED. 실 hook 발화 경계 관통.
2. **핵심 로직 TDD + 구조적 구현**: source는 config layer서 파생(재발명 금지), needsReview 게이트를 hook 발화 chokepoint에.
3. **적대적 어딧 ≥3R**: 미검토 hook이 발화하는 경로, source 오분류, HARD_DENY 셸룰([[jun-06-permanent-guards]])과 경계.
4. **셀프 어딧**.
5. **구조적 TDD 보완**.

## 핵심 유즈케이스 → 헬게이트 e2e (RED부터)
- **UC1** imported hook 차단: `src/migration/external-config/`로 들여온 project hook은 `needsReview=true` → 승인 전 **비발화** (red-on-injection: 미검토 imported hook이 발화하면 red).
- **UC2** user hook 정상: user-authored hook(source=user)은 needsReview=false → 기존대로 발화.
- **UC3** 승인 후 발화: needsReview hook을 사용자가 승인하면 이후 발화.
- **UC4** 이벤트셋 갭: Codex 10종(preToolUse/permissionRequest/postToolUse/preCompact/postCompact/sessionStart/userPromptSubmit/subagentStart/subagentStop/stop) 중 quanta 미보유분 배선 + 풀배선(zero-unwired).
- **UC5** default-OFF: 게이트 OFF면 기존 hook 동작 byte-identical.

## 코드 앵커 (실측)
- config: `src/config/types.ts`(`HookGroupSetting:60`, `HooksSettings:66`, `allowManagedHooksOnly:69` — 이미 layer/trust 주석 존재 = 자연 확장점).
- binding: `src/agent/command-hooks/types.ts`(`CommandHookBinding={event,matcher,command}` — source/needsReview/model 없음).
- import 경로: `src/migration/external-config/`.

## 통합 (manifest/knob/config/surface)
- **LLM 도구**: N/A. **knob**: `QUANTA_HOOK_TRUST_GATE`(bool, false 시드→안정후 default-ON 검토) → knob-inventory `{group:"security",home:"runtime-config"}`.
- **config**: **핵심** — `src/config/types.ts`에 source+needsReview(source는 layer 파생). imported는 자동 needsReview. **per-hook model = 현 스코프 N/A**(셸 hook 무의미; LLM-hook 별종 도입 시 별 티켓).
- **CLI**: `/hooks` slash(list/review/approve). **Web**: hooks 상태+승인 카드(agent-state push).

## 규율
- source 분기: user=needsReview false, imported/project=true(UX 퇴행 방지). default-OFF byte-identical. claim-100 ⇒ ≥3R. worktree 시 HEAD==main+ff.
