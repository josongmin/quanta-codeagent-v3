# 구현 프롬프트 — T03: guardian 자동승인 reviewer + approval ladder

## 미션
승인 경로에 `reviewer: "user" | "agent"` 축을 추가해, agent면 side-agent reviewer가 도구 호출을 자동 판정(무인-but-안전). approval ladder(read-only/auto/granular/guardian-approvals/full-access/custom)를 명명 preset SSOT로. HARD_DENY는 reviewer 앞. default-OFF, default는 절대 guardian/full 아님.

## 정본 스펙
`docs/jun-13-backlog-codex-ide-reabsorption/03-guardian-auto-approval-reviewer.md` 정독. 통합 `00-index.md §8`. HITL 선행 [[jun-10-hitl-inline-approval-restructure]].

## 🛑 헬게이트 프로토콜 (메모리 `hellgate-implementation-protocol`)
1. **헬게이트 RED 셋업**: 유즈케이스 e2e 먼저, 전부 RED. forked-child reviewer는 env-driven replay LLM seam으로 hermetic([[jun-09-wiring-closeout-and-side-agent-os-process]]).
2. **핵심 로직 TDD + 구조적 구현**: reviewer 축 + ladder preset enum SSOT. side-agent 실행 seam 재사용.
3. **적대적 어딧 ≥3R**: 권한상승 매트릭스 pillar×reviewer×gate 전수([[jun-04-3round-hardening-audit]]). reviewer 무한루프/비용폭주.
4. **셀프 어딧**.
5. **구조적 TDD 보완**.

## 핵심 유즈케이스 → 헬게이트 e2e (RED부터)
- **UC1** guardian 자동승인: reviewer=agent 모드서 안전 명령(read/검색)을 reviewer가 자동 approve → 턴이 사람 개입 없이 진행. e2e: 승인 프롬프트 없이 도구 실행됨 단언.
- **UC2** 위험명령 차단: reviewer=agent여도 HARD_DENY 대상(예: 파괴적 셸)은 **reviewer 판정 이전에 fail-closed** (red-on-injection: guardian이 위험명령 자동승인하면 red).
- **UC3** ladder preset: 각 preset이 `{sandbox, approvalPolicy, reviewer}` 정확히 매핑. read-only=거부쓰기, full-access=never-approval.
- **UC4** default-OFF: 게이트 OFF면 reviewer=user 기존 경로 byte-identical.
- **UC5** 비용 경계: reviewer 서브에이전트가 budget/timeout 초과 시 fail-closed(자동승인 안 함).

## 코드 앵커 (실측)
- 승인: `src/protocol/session/commands.ts:42`(`ApprovalRespondCommand` approve|deny, once/session/session_prefix).
- side-agent: `src/side-agent/`(OS-process, forked-child hermetic 패턴).
- mode-preset: `src/apps/agent/mode-presets/`.

## 통합 (manifest/knob/config/surface)
- **LLM 도구**: N/A(reviewer=side-agent). **knob**: `QUANTA_AUTO_REVIEW`(bool,false) → knob-inventory `{group:"permission",home:"runtime-config"}`.
- **CLI+Web**: reviewer 판정을 item-level(T01 `item/autoApprovalReview/*`) 노출 → CLI 프롬프트/Web 카드에 "auto-reviewed" 표시. **config**: ladder preset SSOT enum을 mode-preset/posture에, reviewer=agent 선택 노출(default 아님).

## 규율
- HARD_DENY가 reviewer 앞(fail-closed). default-OFF byte-identical. claim-100 ⇒ ≥3R. worktree 시 HEAD==main+ff.
