# T03 — `guardian_subagent` 자동승인 reviewer + approval ladder

**현황:** ❌ CONFIRMED-GAP · **ROI:** ★★ · **게이트:** `QUANTA_AUTO_REVIEW`(default-OFF)

## 무엇 (코퍼스 증거)
Codex collaboration-mode 매트릭스(`src-GT0gjTeg.js` `Nm`):
```
read-only:           sandbox=read-only,        approval=on-request, reviewer=user
auto:                sandbox=workspace-write,   approval=on-request, reviewer=user
granular:            sandbox=workspace-write,   approval=Am,         reviewer=user
guardian-approvals:  sandbox=workspace-write,   approval=on-request, reviewer=guardian_subagent
full-access:         sandbox=danger-full-access,approval=never,      reviewer=user
```
- `approvalsReviewer` = `"user"` 또는 agent. agent면 **LLM 서브에이전트가 승인 판단**.
- 스트림: `item/autoApprovalReview/started` → `completed` (reviewer 판단이 first-class item).
- 명명 사다리: `read-only → auto → granular → guardian-approvals → full-access → custom`.

## 왜 가져오나
무인-but-안전 실행 티어. 대부분 에이전트가 안 가진 패턴. quanta HITL 4-verb([[jun-10-hitl-inline-approval-restructure]]) 위에 **reviewer 축**을 더해 사람 부재 시 LLM이 게이팅.

## quanta 현황 (코드 앵커)
- 승인: `src/protocol/session/commands.ts:42`(`ApprovalRespondCommand` decision=approve|deny, once/session/session_prefix scope).
- 모드/posture: collaboration-mode 매트릭스에 해당하는 명명 사다리는 없음(모드는 있으나 reviewer 축 부재).
- side-agent: `src/side-agent/`(OS-process side-agent, [[jun-09-wiring-closeout-and-side-agent-os-process]]) — reviewer 서브에이전트 실행 seam 재사용 가능.

## 제안 접근
1. 승인 경로에 `reviewer: "user" | "agent"` 축 추가. `agent`면 승인 요청을 side-agent reviewer에 라우팅, 판정을 `ApprovalRespondCommand`로 환원.
2. reviewer 판단을 item-level 이벤트(T01)로 노출 — `auto_review` started/completed.
3. approval ladder를 명명 preset으로 SSOT화(read-only/auto/granular/guardian/full/custom), 각 preset이 `{sandbox, approvalPolicy, reviewer}` 묶음.
4. **HARD_DENY/security gate가 reviewer 앞**([[jun-11-preflight-and-prefix-grants]] 패턴) — guardian가 위험 명령을 자동승인 못 하게.

## 함정
- reviewer=agent가 HARD_DENY를 우회하면 권한상승. security gate는 reviewer 판정 **이전**에 fail-closed.
- reviewer 서브에이전트 무한루프/비용폭주 — budget + timeout 경계.
- default 절대 guardian/full 아님(default-OFF + read-only 시드).

## 통합 계획 (LLM도구 / CLI+Web / knob / config)
- **LLM 도구:** N/A — reviewer는 도구 호출을 *판정*하는 side-agent(`src/side-agent/` 실행 seam 재사용)지, 에이전트가 호출하는 도구가 아님. tool-surface manifest 무관.
- **CLI+Web:** 승인 경로 양-surface. reviewer 판정을 item-level 이벤트(T01 `item/autoApprovalReview/*`)로 노출 → **CLI** 승인 프롬프트 + **Web** approval 카드 모두 "auto-reviewed by guardian" 표시. 기존 HITL 4-verb 카드([[jun-09-adr0512-p3-4verb-card-display-only]]) 위에 reviewer 축.
- **knob:** `QUANTA_AUTO_REVIEW`(bool, default false) → knob-inventory `{group:"permission", home:"runtime-config", readSite:승인 경로}`. orphan ratchet 등록 필수.
- **config:** approval ladder를 **명명 preset SSOT enum**(read-only/auto/granular/guardian-approvals/full-access/custom)으로 — mode-preset(`src/apps/agent/mode-presets/`) 또는 posture config에. 각 preset = `{sandbox, approvalPolicy, reviewer}` 묶음. reviewer=agent 선택을 settings/posture에 노출(default는 절대 guardian/full 아님).

## DoD
- reviewer 축 + ladder preset SSOT; default-OFF byte-identical(reviewer=user가 기존 경로).
- e2e: guardian reviewer가 안전 명령 자동승인 / 위험 명령은 HARD_DENY가 reviewer 앞에서 차단(red-on-injection).
- ≥3R 적대어딧(권한상승 매트릭스: pillar×reviewer×gate 전수, [[jun-04-3round-hardening-audit]] 패턴).

## 구현 상태 (2026-06-13) — DELTA-ONLY 합의
**⚠️ 1차 판정 정정: reviewer 축 코어는 이미 LIVE였음(false-gap).** [[jun-13-t03-reviewer-axis-false-gap]].
이미 존재: `ReviewerTier` 3-tier(user/auto_review/guardian_subagent)·`dispatchFresh`·subagent guardian(`reviewer-subagent.ts`, fail-closed, `REVIEWER_MAX_TURNS=4`, tool-filter=[read,grep,glob]→재귀불가)·`reviewerPort` gate 배선·HARD_DENY가 reviewer 앞(`evaluate`/`evaluateStack` 모두 hardDeny 최우선).

**이번에 구현한 진짜 델타:**
1. `QUANTA_AUTO_REVIEW`(bool, **strict `=== "1"`**) + `QUANTA_APPROVAL_LADDER`(enum) — `runtime-config.ts`+`runtime-config-knobs.ts`(home=runtime-config; 디스조인트/parity/orphan 라쳇 통과). default-OFF byte-identical.
2. **approval ladder 6-name SSOT** — `src/permission/approval-ladder.ts`(`APPROVAL_LADDER` Record + `parseApprovalLadderName`). 각 rung=full `ThreadPermission`{sandbox,approvalPolicy,reviewer}. guardian-approvals만 reviewer=agent(red-on-injection 테스트로 봉인).
3. 배선: `compose`가 ladder rung의 `approvalsReviewer==="agent"`(또는 strict AUTO_REVIEW)→`autoReviewEnabled`→`selectDefaultReviewer`가 guardian 선택. **ThreadPermission 시딩 안 함**(아래 어딧 참조).
- 테스트: `approval-ladder-hellgate`(SSOT/UC3)·`guardian-auto-approval-reviewer-hellgate`(UC1 자동승인-no-prompt/UC2 HARD_DENY-앞-red-on-injection/UC4 byte-identical/UC5 fail-closed)·`reviewer-policy.test`(opt-in routing). 25 신규 + 1444 permission-area green, 0 회귀. src/test typecheck 0(내 파일).

**🔴 어딧 R3가 잡은 실버그:** ladder를 `setThreadPermission`로 시딩하면 `evaluateStack`(라이브 CLI gate)이 thread record에서 allow/deny를 **직접** 결정→**reviewer를 영영 안 거침**. workspace-write(writableRoots 無)는 `threadAllowsMutation=false`→**모든 쓰기 deny**(guardian 도달 0). → 시딩 폐기, `selectDefaultReviewer`의 `autoReviewEnabled` 라우팅으로 전환(threadPermission undefined 유지→gate가 `ask`→guardian).

## 후속 (delta-3, 미구현) — (기능)+(왜)+(ROI)
- **`item/autoApprovalReview/{started,completed}` 스트림 이벤트 + CLI/Web "auto-reviewed by guardian" annotation** — (기능) reviewer 판정을 T01 item-level 이벤트로 노출, CLI 승인영역/Web 카드에 누가 자동승인했는지 표시. (왜) 현재 guardian 자동승인은 `emitReviewerDecision`(metrics recorder)만 타고 사용자-가시 스트림엔 안 뜸→무인 자동승인이 조용히 일어남(관측성 북극성 위배). (ROI) ★★ — 코어 자동승인은 이미 동작하므로 순수 가시성 추가지만, stream/types·projection·CLI render 동시편집(T01/T05) 충돌영역이라 합류 후 별도 착수가 안전. `emitReviewerDecision`에 stream sink 한 갈래 추가가 최소 구현.
