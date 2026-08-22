# _review-01 — RFC-01 Agent-Attention Navigation (critical, READ-ONLY)

Reviewer pass: north-star = "즉시 지금 개입해야 할 agent를 식별하고 거기로 이동." Verdict at §H.

## A. 현재 snapshot

- HEAD = `9d5369d310bba9cfcdf2508ca62e6274f184cdd4`, `origin/main` = 동일, branch `main` (ff, 앞선 커밋 없음).
- Working tree DIRTY = 전부 bench/leaderboard 계열 사용자 작업 (`src/apps/bench/**`, `src/runner/batch/**`, `tools/leaderboard-dashboard/**`, `adapters/terminal-bench/**`). 이 리뷰와 무관 — 손대지 않음.
- `docs/plans/aug-22-흡수계획/` = untracked (RFC 본체 + 이 리뷰).
- 리뷰는 이 `_review-01.md` 파일 1개만 기록. 그 외 수정/commit/stash 없음.

## B. 주장별 판정표

| 주장 | 판정 | producer | owner (state) | consumer / front door | 근거 file:line |
|---|---|---|---|---|---|
| 서브에이전트 registry + lineage substrate 존재 | ALREADY | `TaskRegistry.register/complete/fail/stop` | `TaskRecord`(id/parentTaskId/depth/mailboxLabel) | `/agents`, web panel | `subagent/registry.ts:31,49,53,58` |
| observer-sink 패턴(setEmitter/emit, absent⇒OFF byte-identical) | ALREADY | `registry.emit` (private, guarded) | `emitter?` | lineage emitter | `registry.ts:157,163`; `agent/subagent-runner-lineage.ts:15` |
| `TaskStatus` 4-valued 닫힌 union, 5번째 값=cascade | ALREADY(제약 사실) | — | — | GLYPH/colourFor/STATUS/pendingIds | `registry.ts:4`; `agents-fleet-panel.ts:88,97`; `activity/producers/fleet.ts:27` |
| 파킹된 child가 registry엔 여전히 `running`으로 보임 | ALREADY(진짜 gap) | `SubagentTurnGate.wait` | gate 로컬(pure) | 없음 | `subagent/turn-gate.ts:143`; park 호출부 `agent/loop/turn-outcome.ts:157`, `turn-loop.ts:218` |
| main-session `awaiting_approval` 커널/스냅샷에 존재 | ALREADY | kernel session | `KernelSessionState.status`, `pendingApproval` | wire snapshot | `kernel/session/state.ts:35,42`; `protocol/session/snapshot.ts:82` |
| main-session awaiting가 fleet/CLI attention으로 join됨 | DROP-from-v1 (미존재+substrate 없음) | — | root는 `TaskRecord` 아님 | — | CLI엔 미노출 (`rg awaiting_approval src/apps/cli` = serve-stdio wire뿐) |
| attention/unread 상태 어디에도 없음 | ALREADY(없음 확인) | — | — | — | `rg -i attention/unread src` = 도메인 매치 0 |
| 기존 next/focus/mark-unread 명령 없음(중복 아님) | ALREADY(없음) | — | — | — | `rg focus-next/nextThread/attention` = 0 |
| 신규 leaf `attention/model.ts` (pure derived) | BUILD | 순수 함수 | 없음(입력 파생) | resolver | 신규 |
| resolver: awaiting-before-unread + lineage gate | BUILD | 순수 함수 | 없음 | CLI/web | 신규 |
| 새 신호 = subagent park/unpark, observer-sink에 additive arm | BUILD(단, seam/게이트 정정 필요 — §C1,C2) | child loop park 호출부 | 없음(이벤트) | 3중 mirror | `turn-outcome.ts:157`+`registry.emit` |
| additive arm이 "one substrate touch, ~1d" | MEASURE/과소평가 | — | — | 3-mirror cascade | `stream/types.ts:203,466,475`; `protocol/subagent/projection.ts:30`; drift guard `tests/unit/subagent-lineage-tree-hellgate.test.ts` |
| CLI `/attention` + `focus-next-attention` (select+drill) | BUILD (최소 slice 핵심) | resolver | (awaiting만 쓰면 무상태) | `/agents inspect` | `slash-contract.ts:231`; `keybindings/types.ts:55`(effort-cycle 선례) |
| CLI가 unread용 lastActivityAt/focus cursor 축적 | PARK (신규 owner, 미명세 — §C3) | subagent event stream | 신규 per-viewer accumulator | CLI | RFC가 위치/폴딩 미지정 |
| Web 진짜 focus-jump 배지+명령+키바인딩 | PARK (프론트엔드 코드 이 트리 밖, 1d 비현실) | subagent frame | client cursor(localStorage) | web transcript view | `web-daemon/subagent-source.ts:42,118` (broadcast만; jump 대상 렌더러 미확인) |
| Starting→Working 프레젠테이션 split (parity) | DROP (producer 없음) | — | running row엔 `turns` 없음(result는 settle 후만) | — | `agents-fleet-panel.ts:36,120`; running row `result` undefined |
| default-OFF: seed list 제외 + plain gateOn + no-default-chord | BUILD(타당) | — | — | — | `cli-feature-gates.ts:37`; `keybindings/types.ts:50-55` |
| KEY_ACTION no-default-chord ⇒ DEFAULT_KEYBINDINGS byte-identical | ALREADY(선례 검증) | — | — | KEYBIND_TRUTH | `keybindings/types.ts:50` (effort-cycle/open-editor) |
| lineage-gate로 sibling-leak 차단(R2) | BUILD(타당, jul-15 교훈 정합) | resolver ownRootId filter | — | — | `subagent-source.ts:42` 전 연결 broadcast |

## C. 중복 또는 잘못된 가정

**C1. "turn-gate park/unpark에서 emit" — seam 위치가 부정확 (구현은 가능).**
`SubagentTurnGate`는 명시적으로 PURE로 설계됨(`turn-gate.ts:63` "no node:, no clock…"; registry 참조 없음). gate 자신은 registry를 모른다. 진짜 emit seam은 **child loop의 park 호출부**(`agent/loop/turn-outcome.ts:157`, `turn-loop.ts:218`)다. 다행히 child config가 `subagent`(부모 공유 registry, `subagent-runner-child-config.ts:235`)와 `spawnedAsTaskId`(:220)와 `subagentTurnGate`(:224)를 모두 실어주므로, park 직전 `awaitingInput:true`, `wait()` resolve 후 `false`를 부모 registry로 emit하는 것은 **도달 가능**하다. RFC의 "gate에서 emit" 문구만 정정하면 됨 — 구현 경로는 성립.

**C2. default-OFF byte-identity 논증에 구멍: emitter 존재 ≠ attention OFF.**
RFC는 "Emitter absent(gate OFF) ⇒ no emission ⇒ byte-identical"이라 함. 그러나 observer-sink emitter의 존재 여부는 `QUANTA_WEB_SUBAGENTS`/`onSubagentEvent` 배선으로 결정되지 `QUANTA_ATTENTION_NAV`가 아니다(`subagent-runner-lineage.ts:18`). 즉 **subagents 패널 ON + attention OFF** 조합에서 emitter는 present이므로, park-site emit이 attention knob을 별도로 체크하지 않으면 `subagent_attention`이 새어 test #4를 깬다. → park-site emit 자체를 `QUANTA_ATTENTION_NAV`로 게이트해야 함. RFC의 byte-identity 서사는 이 교차 케이스를 놓침.

**C3. CLI attention 상태의 owner가 미명세 — "agents getter처럼 배선"으로 안 닫힘.**
`/agents`의 `agents` getter는 **registry 스냅샷**을 읽는다(`slash-contract.ts:231`). 그런데 `TaskRecord`엔 `awaitingInput`/`lastActivityAt`가 없다(park는 이벤트일 뿐 상태 아님). 따라서 CLI resolver가 "누가 파킹됐나"를 스냅샷만으로 알 수 없다. RFC는 이벤트 라우팅(observer-sink)을 택했으나, CLI 슬래시 표면은 스트림 소비자가 아니다 → **신규 stream accumulator(park 이벤트 폴딩 + focus cursor + markedUnread)**가 필요한데 RFC는 그 owner의 위치/생명주기를 지정하지 않았다. 이게 "no new store" 주장과 충돌하는 핵심 미명세.
- 대안(더 짧음): `awaitingInput:boolean`을 **TaskRecord additive 필드**로 두면(상태 변경 아니라 status는 4-valued 유지) `/agents` 스냅샷이 그대로 실어와 resolver가 순수 함수가 됨 → CLI accumulator 불필요. focusedAt/markedUnread만 per-viewer로 남김. RFC가 이 fork를 명시하지 않고 이벤트 쪽만 골라 CLI 소비 비용을 숨김.

**C4. main-session awaiting를 attention row로 넣는 건 미해결(Q1)이자 substrate 없음.**
root는 `TaskRecord`가 아니고 CLI fleet에 awaiting_approval이 노출된 적 없다. synthetic root row/별도 lane이 필요 → v1 최소 slice에서 **제외**하고 나중에 별도로. RFC가 Q1로 open해둔 건 정직하나, "awaiting-input ← 두 소스 다 이미 계산됨"이라는 §Design 1 문구는 main-session 소스가 fleet 입력으로 join되지 않았다는 사실을 흐린다.

**C5. Web "focus-jump" navigation receipt는 이 트리에서 닫히지 않음.**
`subagent-source.ts`는 broadcast만 한다. 실제 transcript로 focus를 옮기는 웹 프론트엔드 렌더러는 이 저장소 src에 없고(Tauri/embedded 프론트), leaf-unit 천공카드 규율로는 "진짜 focus 이동" receipt를 검증 불가. RFC의 web 1d는 비현실적 → PARK.

**중복 tracker/store/bus는 없음(양호).** registry·observer-sink·fleet panel·activity spine을 재사용하고 새 event bus를 만들지 않는다. 유일한 신규 상태는 C3의 per-viewer cursor뿐 — 그것도 awaiting-only로 좁히면 0.

## D. 최소 북극성 slice (실제 jump까지 닫힘)

북극성 = "지금 나에게 blocked된 agent로 데려가라". Unread는 Codex parity의 2차 관심사이지 북극성 아님. 최소 vertical slice:

1. **awaiting-input을 objective substrate로 만든다**: park/unpark 시 `TaskRecord.awaitingInput`(additive boolean, status 불변) 갱신 — park 호출부에서, `QUANTA_ATTENTION_NAV` 게이트. OFF면 필드 미설정 ⇒ byte-identical.
2. **pure resolver**: `nextNeedingAttention(rows, ownRootId)` — lineage filter → `awaitingInput===true` 파티션 → oldest-first. unread/focus cursor **불필요**(무상태).
3. **CLI front door**: `/attention`(awaiting 목록) + `focus-next-attention` KEY_ACTION(no-default-chord) → 최상위 pick을 `/agents inspect <id>`로 drill + (followup child면) 다음 `send_input` 타깃 설정. 이게 CLI에서 검증 가능한 진짜 navigation receipt.
4. **RED e2e**: scripted-LLM로 child 하나 `send_input` park + 하나 settle → 사전엔 파킹 child 열거/이동 불가 확인 → green으로 `/attention`이 파킹 child를 짚고 `focus-next-attention`이 그것을 drill.

이 slice는 per-viewer store 0, main-session join 0, web 프론트 0, unread 0으로 북극성을 닫는다. 나머지(unread, focus cursor, web focus-jump, main-session row, Starting/Working)는 파생/parity로 뒤에.

## E. 필수 write-set과 공유-owner 충돌

- `src/attention/model.ts`, `src/attention/resolver.ts` (신규 leaf) — 충돌 없음.
- `src/subagent/registry.ts` — `TaskRecord`에 `awaitingInput?` additive 필드 + setter (D안). **공유 hot-path**: register/complete/fail/stop 근처. 라쳇/드리프트 주의.
- `src/agent/loop/turn-outcome.ts` + `turn-loop.ts` park 호출부 — child loop hot-path. 게이트 필수(C2).
- (이벤트 route를 고집할 경우만) `src/stream/types.ts:203,466` + `src/protocol/subagent/projection.ts:30,95` + drift guard 테스트들 — **3중 mirror 동시 수정**. D안(record 필드)이면 이 cascade 회피 가능.
- `src/apps/cli/slash-contract.ts`(신규 슬롯), `keybindings/types.ts`(KEY_ACTION 추가), `keybind-truth.ts`/`defaults.ts`(no-default-chord이므로 byte-identical 유지 확인).
- **사용자 dirty와 충돌 없음**: 위 파일 어느 것도 현재 dirty set(bench/leaderboard)과 겹치지 않음.

## F. RED-on-injection / anti-vacuum / default-OFF / navigation receipt

- **anti-vacuum(필수)**: resolver 테스트는 MIXED fixture(awaiting 1 + *더 최근* unread 1 + idle 1). awaiting가 newer unread를 제치고 먼저 뽑히는지. **red-on-injection**: resolver 우선순위 뒤집으면 red. 단일/awaiting-only fixture는 vacuous(RFC T5 정합) — RFC가 이 함정을 이미 못박은 건 좋음.
- **lineage-gate 테스트**: sibling-rootId awaiting agent가 ownRootId 조회에서 절대 안 뽑힘(R2).
- **default-OFF byte-identity**: gate unset ⇒ (a) `renderAgentFleet` 출력·`subagent` frame·activity spine 바이트 동일, **그리고 emitter present+attention off 교차 케이스**(C2)에서도 `subagent_attention`/`awaitingInput`이 안 샘 — 이 케이스를 스냅샷 테스트에 반드시 포함. RFC test #4는 "gate unset"만 검사하므로 강화 필요.
- **진짜 navigation receipt**: leaf-unit만으로는 "이동"을 증명 못 함(금지 조항). CLI는 real-`runAgent`×scripted-LLM e2e로 "`focus-next-attention` 후 inspect 대상이 파킹 child id"까지 관측해야 receipt 성립. Web focus-jump receipt는 이 트리에서 불가 → PARK.

## G. 수정된 실행 순서와 예상 공수

1. leaf `attention/model.ts`+`resolver.ts`+units(anti-vacuum+lineage). ~0.5d. (안전, 선착륙)
2. **awaiting substrate**(D안: `TaskRecord.awaitingInput` additive + park-site 갱신 + attention 게이트 + byte-identity 스냅샷 포함 교차케이스). ~1–1.5d. (record-필드 route면 3-mirror cascade 회피; 이벤트 route 고집 시 +0.5–1d)
3. CLI `/attention` + `focus-next-attention`(select+drill) behind `QUANTA_ATTENTION_NAV`. ~1d.
4. Hellgate RED e2e(파킹 child 짚기/이동) + 적대 self-audit ≥3R. ~0.5–1d.
5. **PARK**: web focus-jump(프론트 스코프 필요), unread+per-viewer cursor, main-session synthetic root row(Q1). 별도 RFC.
6. **DROP**: Starting/Working split(running row에 turns producer 없음). previousThread/focusSideChat(RFC도 skip 성향).

최소 북극성 slice = 약 **3–4일**(RFC의 M과 일치)이나, 그 M은 **CLI-only awaiting slice** 기준일 때만 현실적. RFC가 M 안에 web focus-jump + unread + parity split까지 넣은 breakdown은 **~5–7일**로 과소평가.

## H. 최종 verdict — **REVISE**

방향(observer-sink 재사용, 새 store 금지, additive arm으로 status 4-valued 보존, lineage-gate, no-default-chord, measure-first default-OFF)은 north-star에 DIRECT하고 대부분 코드로 검증됨. 그러나 **가장 짧은 경로가 아님**, 그리고 3개의 실질 결함이 있어 그대로 착수 불가:

1. **byte-identity 논증 구멍(C2)** — emitter present + attention off 교차케이스에서 park-site emit을 별도 게이트하지 않으면 test #4가 vacuous하게 통과하거나 실제로 샌다. 반드시 정정.
2. **CLI attention owner 미명세(C3)** — 이벤트 route를 택하면 CLI에 신규 stream accumulator가 필요한데 위치/생명주기 없음. `TaskRecord.awaitingInput` additive-필드 route로 바꾸면 CLI가 스냅샷만으로 순수 resolver를 돌려 slice가 훨씬 짧아짐. 이 fork를 명시적으로 결정할 것.
3. **slice 과적재** — 북극성은 awaiting-input jump. unread/focus-cursor/web-focus-jump/main-session-row/Starting-Working를 v1에서 빼면 per-viewer store 0·프론트 0으로 CLI에서 진짜 navigation receipt까지 닫힌다. RFC의 M 공수도 그때만 현실적.

REVISE 요구: (a) §D 최소 slice로 스코프 축소, (b) awaiting를 record-필드 substrate로 (또는 CLI accumulator owner를 명시), (c) byte-identity 테스트에 emitter-present/attention-off 케이스 추가, (d) web·unread·main-session·Starting/Working를 PARK/DROP로 강등. 이 4개 반영하면 READY.
