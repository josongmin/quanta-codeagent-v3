# T05 — per-hunk diff accept/reject

**현황:** ✅ LANDED (2026-06-15, CLI + web/SDK 양 surface) · **ROI:** ★★ · **게이트:** `QUANTA_HUNK_APPROVAL`(default-OFF)

## 구현 요약 (LANDED)
- **CLI 경로**(선행 랜딩): `diff-ops#splitHunks/applySelectedHunks`(pure) + `runner/hunk-apply#applyHunkSelection`(atomic·mode보존·staleness) + `apps/cli/repl/hunk-select`(parse/render) + inline-confirm `[h]` verb.
- **web/SDK 경로 closure**(이번): `computeActionDiff`+input helpers를 `@/apps/cli/diff-preview`→**`@/runner/action-diff`로 호이스트**(host가 슬라이스펜스로 apps/cli 못 import → @/runner 공용집; diff-preview는 re-export로 back-compat). `ApprovalRespondCommand.selectedHunks`가 `scheduler(approval.respond)→kernel/session/ports#resolveApproval→host wrapper→runtime controller`로 흐름.
- **controller(`context-binding.ts`)**: ① **mint 시점** request-time `(path,before,after)` 캡처(gate ON+≥2hunk; resolve서 재계산 안 함=drift 감지 보존) → record.actionDiff. ② **resolve(approve)**: `resolvePartialHunkApprove`가 subset이면 `applyHunkSelection`로 부분적용 + **`deny_and_steer` lease**(ADR-0076 보편 verb라 normal-mutation도 claimLease가 그대로 반환 → whole-call 도구 재실행 차단). all⇒whole-call grant, none/stale⇒무write+steer.
- **순서/안전**: HARD_DENY 재검(T02) 이후 → 위험액션 부분적용 0. escalation은 skip(skill-scope 축). `selectedHunks!==undefined &&` short-circuit으로 normal approve는 동기 lease(기존 sync 호출자 byte-identical). default-OFF byte-identical.
- **테스트**: `tests/unit/host/runtime-approval-hunk-partial-apply-hellgate.test.ts` 7케이스(subset fresh-readback + deny_and_steer 억제 + gate-off control + all/none + stale + non-previewable + single-hunk). 헬게이트 RED→GREEN. typecheck 0, 회귀 177/0. (complexity warn: resolveApproval 27→30, warn-level 비차단; 추가추출은 swept 보안fn 리스크라 보류.)

## 무엇 (코퍼스 증거)

## 무엇 (코퍼스 증거)
Codex/Claude Code IDE 둘 다 에디터 커맨드 `acceptProposedDiff`/`rejectProposedDiff`로 **제안 diff를 hunk 단위로 선택 수락/거부**. Codex는 `apply-review-section-changes`, `review-diff`, `review-patch`로 review 섹션 단위 적용도.

## 왜 가져오나
quanta는 diff를 **렌더**하고 **whole-tool-call** 단위로만 approve/deny한다. 모델이 한 턴에 여러 hunk를 제안하면 "전부 수락 or 전부 거부"뿐 — 사용자가 일부만 받고 싶을 때 거부 후 재프롬프트해야 함(왕복 낭비). hunk 입자도가 SOTA 기본기.

## quanta 현황 (코드 앵커)
- 렌더: `src/apps/cli/diff-preview.ts`(write/edit/apply_patch/scripted_replace, default-ON `QUANTA_DIFF_PREVIEW`).
- diff 계산 hoist: `src/runner/diff-ops.ts:4`(pure, web canvas emitter도 공유).
- 승인: `src/protocol/session/commands.ts:42`(`ApprovalRespondCommand` decision=approve|deny, whole-call). **per-hunk 명령 없음.**
- LSP rename apply(`src/agent/lsp-bridge.ts` `applyEdit`)는 내부 2-phase commit이지 사용자 hunk 선택 아님.

## 제안 접근
1. `diff-ops.ts` 위에 hunk 분해(이미 unified diff 계산하므로 hunk 경계 보유). 각 hunk에 id.
2. `ApprovalRespondCommand`에 `selectedHunks?: HunkId[]` 추가(없으면 기존 whole-call 동작 = byte-identical).
3. 적용 시 선택 hunk만 apply — **atomic write + mode 보존 필수**([[jun-09-patch-slice-sota-hardening]]). 부분 적용 후 나머지는 재제안 or 폐기.
4. CLI: diff-preview에 hunk 번호 + 선택 UI. web: canvas emitter에 hunk 선택 push.
5. storage·apply_patch 미러 점검(edit-class 픽스는 3경로 동기, jun-09 교훈).

## 함정
- 부분 hunk 적용은 파일 정합성 위험 — 겹치는 hunk/오프셋 드리프트. apply 전 staleness 재검증(RESTING 트리 기준, [[jun-09-patch-slice-sota-hardening]] 🔴 mid-run 판정 금지).
- atomic write에서 mode 비보존 = 회귀(jun-09). 
- whole-call 경로 byte-identical 유지(selectedHunks 부재 시).

## 통합 계획 (LLM도구 / CLI+Web / knob / config)
- **LLM 도구:** N/A — 승인 입자도 변경, 도구 아님. (모델은 여전히 한 번에 patch 제안; 분해는 승인 레이어.)
- **CLI+Web:** 동일 `src/runner/diff-ops.ts`(pure hunk 분해) 공유. **CLI** = `src/apps/cli/diff-preview.ts`에 hunk 번호 + 선택 입력. **Web** = diff-ops 공유하는 canvas emitter에 hunk push + 선택 UI. 승인은 `src/protocol/session/commands.ts`의 `ApprovalRespondCommand`(42)에 `selectedHunks?: HunkId[]` 추가(부재 시 whole-call = byte-identical).
- **knob:** `QUANTA_HUNK_APPROVAL`(bool, default false; opt-in) → knob-inventory `{group:"diff", home:"runtime-config", readSite:"runner/diff-ops.ts" or 승인 경로}`. (참고: `QUANTA_DIFF_PREVIEW`는 default-ON 선례지만 부분적용은 정합성 리스크라 opt-in 시작.)
- **config:** N/A — 게이트로 충분.

## DoD
- per-hunk 선택 + 부분 적용; default-OFF byte-identical.
- e2e: 3-hunk 제안서 1개만 수락 → 해당 hunk만 디스크 반영, 나머지 미반영(fresh-readback 단언).
- 3경로(storage/apply_patch/scripted_replace) 미러 + staleness 가드.
- ≥3R 적대어딧(오프셋 드리프트, mode 보존, partial-apply 정합성).
