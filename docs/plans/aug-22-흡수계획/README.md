# Aug-22 흡수 계획 — authority-first implementation roadmap

원천: Codex Desktop 6321→6662, Claude Code 2.1.220→2.1.238, Codex CLI
0.146→0.149 리프레시. 기준 snapshot은 `origin/main`/HEAD
`9d5369d310bba9cfcdf2508ca62e6274f184cdd4` 이며, 현재 dirty overlay와 분리해
producer→owner→consumer/front-door를 다시 감사했다.

아키텍처, 대상 폴더 트리, authority contract, slice fence, 착수 wave의
공통 구현 SSOT는 [00 Architecture Blueprint](00-architecture-blueprint.md)이다. 각 RFC의
**Architecture integration — R6**가 해당 기능의 현재 owner, target write-set, dataflow,
atomic cutover와 RED rail을 소유하며, 이전 R1–R5와 충돌하면 R6가 우선한다.
실행 순서, clean-worktree 규칙, shared-owner lock과 완료 receipt는
[01 Execution Board](01-execution-board.md)가 소유한다.

## 결론

전체 READY가 아니다. 기존 substrate가 많은 것과 구현 계획이 준비된 것은
다르다. 7개 RFC 모두에서 거짓 durability, frozen snapshot, UI-only lock,
producer 없는 label, vacuous test를 제거했다. 즉시 BUILD 가능한 것은 작은
owner-local slice이고, 나머지는 명시적 authority/prerequisite 후에만 BUILD로
전환한다.

## RFC 별 최종 disposition

| RFC | 이미 있음 / DROP | 지금 BUILD | 선행 / PARK |
|---|---|---|---|
| [01 Agent attention](rfc-01-agent-attention-nav.md) | subagent registry, request tool, `/agents` | session `UserQuestionBroker` + agent join resolver + CLI answer/resume receipt | generic follow-up park≠attention; web/unread는 session authority 후 |
| [02 Review diff source](rfc-02-review-diff-source.md) | fixed current diff, byte cap | branch merge-base, commit first-parent, explicit range, generated attr filter | last-turn=ShadowOdb before/after ref pair 후; all-repos/paging producer PARK |
| [03 Goal propose/edit](rfc-03-goal-propose-edit.md) | `objective_set`, objective store | `@/objective` atomic move, two-phase HITL authority, checked schema, CAS edit/undo | shared workspace barrier + runtime process port 후 evaluator; LLM judge PARK |
| [04 Worktree progress](rfc-04-worktree-progress.md) | worktree transition/activity | live progress delivery, non-agent staged step nodes, checkout progress | arbitrary setup exec PARK; ADR-0455 env selection reuse |
| [05 Permission posture](rfc-05-permission-posture-surface.md) | reviewer routes, `ThreadPermission`, hard-deny | resolved live posture owner, durable host rebind, CAS/lossless presets, future-thread question binding | synthetic lock reasons DROP; full-access ceremony PARK |
| [06 Skill actions](rfc-06-skills-actions.md) | registry/compiler/admin decision primitives | copy/reveal; live runtime authority 후 enable/disable | frozen-map filter 금지; uninstall/suggest PARK |
| [07 Observability](rfc-07-observability-signals-parity.md) | passive VCS core, request-input, trace-local | `commit.branch` + exact argv grammar `pr.action`; inline facts G2–G4 | report binding은 dirty owner 해제 후; semantic count labels, reap, LOW UI PARK |

## 구현 DAG

아래는 cross-RFC 요약이다. 실제 착수 단위는 각 RFC의 `Executable work packets`와
[Execution Board](01-execution-board.md)의 branch/write-set/RED/receipt/stop rule을 따른다.

1. **Architecture rails**
   - 신규 `objective` slice boundary config/test + 기존 activity/runtime/protocol fence 재사용.
   - `runner/assemble/session-authorities` contracts; behavior switch 없음.
   - current split-owner/frozen-snapshot/post-hoc-render front-door RED rails.
2. **Independent leaf slices**
   - RFC-02 branch/commit/range resolver + generated filter.
   - RFC-07 G1 passive-VCS field grammar.
   - RFC-04 activity progress/subscription model.
   - RFC-01 user-question broker + pure attention resolver.
3. **State authority cutovers — serialized**
   - RFC-03 `@/objective` atomic promotion + revisioned mutation/persistence.
   - RFC-05 behavior-live posture/store/rebind.
   - RFC-06 dynamic tool surface + runtime authority + all consumers.
4. **Product consumers**
   - RFC-01 pending-question CLI navigate/answer/resume.
   - RFC-03 propose/editor/CAS undo.
   - RFC-05 preset command/state echo/question predicate.
   - RFC-06 current-session enable/disable across prompt/search/dispatch/readout.
   - RFC-04 checkout progress/staged steps.
5. **Prerequisite-gated work**
   - RFC-02 exact last-turn after immutable turn boundary refs.
   - RFC-03 execution evaluator after lease/source-digest lifecycle.
   - RFC-07 report classification after inline facts persistence and dirty-owner release.
6. **PARK**
   - all-repos/paging, arbitrary setup hooks, full-access one-click, skill uninstall/history
     suggestion, semantic overspawn/question labels, child-shell reap, LOW UI bundle.

## 병렬 규칙

- `src/apps/cli` command registry/protocol surfaces: RFC-01, 03, 05, 06을 동시 수정하지
  않고 owner 단위로 직렬화한다.
- session composition/runtime host: RFC-05→RFC-06 순으로 각 authority 바인딩을
  독립 랜딩한다.
- `src/agent/tier1/skill.ts`: RFC-06 전용 owner가 frozen consumer 전체를 한 번에
  전환한다. 반쪽 refresh는 금지한다.
- `src/runner/batch/report.ts`: 현 dirty owner와 합의 전 RFC-07 5.2를 시작하지
  않는다. 아키텍처 결정 전 편집도 하지 않는다.
- worktree/report/evaluator 인접 배치는 현 dirty overlay를 증거로 삼지 않고 fresh
  worktree/current SHA에서 실행한다.

## 공통 release gates

1. **Owner identity:** UI, resolver, write handler, runtime consumer가 같은 revisioned
   authority를 본다.
2. **Front-door receipt:** leaf return값이 아니라 CLI/web/tool/report의 실제
   consumer에서 상태 전이를 관찰한다.
3. **Restart/race:** durability claim은 새 runtime 구성으로 증명하고, CAS 경쟁은
   1 success + 1 stale rejection으로 증명한다.
4. **Negative controls:** clean follow-up park, unsupported host, disabled direct invocation,
   missing taxonomy facts, ambiguous gh flags 등이 fail-closed/degrade-to-unavailable임을
   증명한다.
5. **Default-OFF:** shared runtime config에 등록하고 production composition에서 baseline
   parity를 비교한다. optional port 존재만으로 gate를 대체하지 않는다.
6. **Non-vacuity:** 보호 호출/구조를 삭제하면 정확한 front-door test가 RED가
   되어야 한다.

## 즉시 착수 가능 범위

- RFC-02 core resolver + generated filter.
- RFC-07 G1 exact passive-VCS field extension.
- RFC-06 copy/reveal is thin but lands after the live action-time resolver contract, not against
  the current frozen snapshot.
- RFC-04 D1 live-delivery/subscription contract의 owner-local RED rail.

나머지를 "얇은 UI/wiring"으로 부르지 않는다. 각 RFC의 BUILD FIRST/DECIDE/PARK
게이트가 닫히기 전에는 구현 준비 상태가 아니다.

## 비흡수 / DROP

Passive VCS core, `request_user_input` tool, local trace storage, replay consumer 없는
`asyncDispatched`, 단일 corpus `task_category`, 기존 objective set 능력, 기존
worktree activity, 기존 reviewer routes, producer 없는 lock/disablement label.
