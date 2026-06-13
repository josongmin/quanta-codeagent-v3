# 구현 프롬프트 — T05: per-hunk diff accept/reject

## 미션
`diff-ops.ts`의 pure 계산 위에 hunk 분해를 올리고, `ApprovalRespondCommand`에 `selectedHunks?`를 추가해 사용자가 한 턴의 patch를 hunk 단위로 골라 수락/거부하게 한다. selectedHunks 부재 시 whole-call = byte-identical. default-OFF.

## 정본 스펙
`docs/jun-13-backlog-codex-ide-reabsorption/05-per-hunk-diff-accept-reject.md` 정독. 통합 `00-index.md §8`. 선행 [[jun-09-patch-slice-sota-hardening]].

## 🛑 헬게이트 프로토콜 (메모리 `hellgate-implementation-protocol`)
1. **헬게이트 RED 셋업**: 유즈케이스 e2e 먼저, 전부 RED. fresh-readback으로 디스크 실효과 관찰.
2. **핵심 로직 TDD + 구조적 구현**: hunk 분해를 diff-ops(pure)에. 부분 적용은 atomic write + mode 보존.
3. **적대적 어딧 ≥3R**: 오프셋 드리프트, 겹치는 hunk, mode 비보존 회귀, 3경로(storage/apply_patch/scripted_replace) 미러.
4. **셀프 어딧**.
5. **구조적 TDD 보완**.

## 핵심 유즈케이스 → 헬게이트 e2e (RED부터)
- **UC1** 선택 수락: 모델이 3-hunk 제안 → 사용자가 1개만 수락 → **해당 hunk만 디스크 반영, 나머지 미반영** (fresh-readback 단언).
- **UC2** 선택 거부: 일부 hunk 거부 시 거부분은 적용 안 되고 나머지만.
- **UC3** whole-call 동일성: selectedHunks 부재 시 기존 approve/deny와 **byte-identical**.
- **UC4** staleness: 파일이 제안 후 변경되면 부분 적용 전 staleness 재검증(RESTING 트리 기준, mid-run 판정 금지).
- **UC5** mode 보존: 부분 적용 후 파일 permission mode 보존(red-on-injection: mode 깨지면 red).

## 코드 앵커 (실측)
- 렌더: `src/apps/cli/diff-preview.ts`(`QUANTA_DIFF_PREVIEW` default-ON).
- pure 계산: `src/runner/diff-ops.ts:4`(web canvas emitter 공유).
- 승인: `src/protocol/session/commands.ts:42`(`ApprovalRespondCommand`).

## 통합 (manifest/knob/config/surface)
- **LLM 도구**: N/A. **knob**: `QUANTA_HUNK_APPROVAL`(bool, false; opt-in) → knob-inventory `{group:"diff",home:"runtime-config"}`.
- **CLI**: diff-preview에 hunk 번호+선택. **Web**: diff-ops 공유 canvas emitter에 hunk push. **config**: N/A.

## 규율
- atomic write mode 보존 필수. 부분적용 정합성(겹침/오프셋) 가드. 3경로 미러. claim-100 ⇒ ≥3R. worktree 시 HEAD==main+ff.
