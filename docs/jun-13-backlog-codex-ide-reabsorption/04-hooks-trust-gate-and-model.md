# T04 — hooks 신뢰게이트(`needsReview`) + per-hook model

**현황:** ❌ CONFIRMED-GAP (2축) · **ROI:** ★★ · **게이트:** 기존 hooks 확장

## 무엇 (코퍼스 증거)
Codex IDE hooks(`hooks-settings-model-BAhFH565.js`):
- 이벤트 10종: `preToolUse, permissionRequest, postToolUse, preCompact, postCompact, sessionStart, userPromptSubmit, subagentStart, subagentStop, stop`.
- 각 hook `source ∈ {user, admin, project, sessionFlags, unknown}`.
- **`needsReview` 신뢰게이트** — imported/project hook은 활성 전 review 필수(`{eventName, active, installed, needsReview}`).
- `.rules`(Starlark) rule 파일 문법 기여.
- (codex-ide host는 per-hook LLM이 아님 — "model"은 view-model. 단 Codex의 hook 이벤트셋·신뢰게이트가 우리보다 넓음.)

## 왜 가져오나
2가지 갭:
1. **보안:** quanta는 imported/project hook 신뢰게이트가 없음 — 외부서 들여온 hook이 무검토 실행되면 RCE 표면. Codex `needsReview`가 정확히 이걸 막음.
2. **기능:** per-hook model override 부재(아래 §현황).

## quanta 현황 (코드 앵커)
- `src/agent/command-hooks/types.ts`: `CommandHookBinding = {event, matcher?, command}` — **model 필드 없음**, **source/needsReview 없음**(ADR-0454).
- hook은 셸 명령 one-shot(`{type:"command", command}`, Claude Code 계약), exit code/stdout 매핑.
- 이벤트셋: quanta 현 이벤트 vs Codex 10종 갭 확인 필요(grep `event:` in command-hooks).
- import 경로: `src/migration/external-config/`가 hooks import(✅) — 여기에 신뢰게이트 부착 지점.

## 제안 접근
1. `CommandHookBinding`에 `source`(user/admin/project/imported) + `needsReview` 추가. imported/project source는 default `needsReview=true` → 활성 전 명시 승인.
2. import 경로(`src/migration/external-config/`)서 들여온 hook은 자동 `needsReview` 표식.
3. (선택) per-hook `model` override — hook이 LLM-judge류일 때. command hook은 셸이라 무의미하므로, LLM-hook 종류 도입 시에만. **현 셸 hook엔 미적용**(스코프 명확히).
4. 이벤트셋을 Codex 10종에 맞춰 갭 메우기(subagentStart/Stop, preCompact/postCompact 등 quanta에 없으면).

## 함정
- 셸 command hook에 model 필드 박는 건 무의미 — LLM-hook 별종 도입 전엔 §3.3 보류. 스코프 오염 주의.
- needsReview default가 user-authored hook까지 막으면 UX 퇴행 — source별 분기(user=false, imported/project=true).
- [[jun-06-permanent-guards]] HARD_DENY 셸 룰과 hook command 경계 점검.

## 통합 계획 (LLM도구 / CLI+Web / knob / config)
- **LLM 도구:** N/A — hook은 도구가 아니라 도구 호출 경계의 셸 명령.
- **CLI+Web:** needsReview 승인 UI 양-surface. **CLI** = `/hooks` slash(`src/apps/cli/slash/registry-session.ts`)로 list/review/approve(`{eventName, active, installed, needsReview}` 표시). **Web** = hooks 상태 + needsReview 승인 카드(agent-state push).
- **knob:** `QUANTA_HOOK_TRUST_GATE`(bool, default false 시드 → 안정 후 default-ON 검토) → knob-inventory `{group:"security", home:"runtime-config", readSite:hook 발화 경계}`.
- **config:** **핵심.** `src/config/types.ts`의 `HookGroupSetting`(60)/`HooksSettings`(66)에 `source`+`needsReview` 추가. 단 **source는 config layer서 파생**(managed/project/user/imported) — 이미 layer 모델 존재(`allowManagedHooksOnly`:69)하고 주석이 "Capability-granting ⇒ trust-gated"라 자연 확장점. imported(`src/migration/external-config/`)는 `needsReview=true` 자동 표식. **per-hook `model`은 셸 hook엔 무의미 → 현 스코프 N/A**(LLM-hook 별종 도입 시에만 별 티켓).

## DoD
- source + needsReview; imported hook은 review 전 미발화(red-on-injection: 미검토 hook이 발화하면 red).
- 이벤트셋 갭 메움 + 풀배선(zero-unwired 라쳇).
- e2e: import한 project hook이 needsReview 게이트에 걸려 승인 전 비실행.
- ≥3R 적대어딧.
