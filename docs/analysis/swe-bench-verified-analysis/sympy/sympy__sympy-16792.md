---
instance_id: sympy__sympy-16792
repo: sympy/sympy
base_commit: 09786a173e7a0a488f46dd6000177c23e5d24eed
version: "1.5"
difficulty: "15 min - 1 hour"
created_at: "2019-05-09T03:40:54Z"
fail_to_pass: 1
pass_to_pass: 54
gold_files: [sympy/utilities/codegen.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
cython 백엔드로 `autowrap`할 때, 배열 인자(`MatrixSymbol`/`IndexedBase`)가 최종 표현식에 나타나지 않으면 생성되는 C 함수 시그니처가 틀린다. 예컨대 `x = MatrixSymbol('x', 2, 1)`, `expr = 1.0`이면 `x`가 `double *x`가 되어야 하는데 `double x`(스칼라)로 생성되어 호출 시 `TypeError: only size-1 arrays can be converted to Python scalars`로 실패한다. 표현식이 모든 인자에 의존하면 문제가 없다는 점이 결정적 단서다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `codegen`을 직접 지목하고 제보자가 "problem in `codegen`"이라 적었다. `sympy/utilities/codegen.py`의 `CodeGen.routine`로 빠르게 수렴하나, 그 안에서 정확히 어느 분기인지(`argument_sequence` 재배열 경로의 `KeyError` 핸들러)는 약간의 데이터플로우 추적이 필요하다. L0까진 아니다.
- **S2 (Constraint-Reasoning)**: 고칠 지점은 좁지만, "배열형 인자는 dimensions 메타데이터를 가져야 `double *`로 생성된다"는 불변식을 추론해 누락된 분기에 동일 메타데이터를 합성해야 한다. 후보 난사가 아니라 "왜 의존하는 경우는 되고 안 하는 경우는 안 되나"를 따져 푸는 의미적 수리다.
- **K-Domain (Domain-bound)**: sympy codegen 내부 모델(`InputArgument`의 `dimensions` kwarg가 포인터/배열 인자를 결정한다는 사실, `array_symbols` 수집 로직)을 알아야 한다. 일반 파이썬 추론만으론 부족.
- **primary = T-ConstraintReason**: 위치는 비교적 명확하나 핵심 난점이 "올바른 조건·메타데이터를 추론 합성"하는 데 있다. APR 관점에서 SemFix/Angelix식 의미적 수리에 해당하며, 누락된 정상경로를 기존 정상경로(표현식에 등장하는 배열 처리)에서 추론해 재현한다.

## 난이도 티어
- **티어 = T3 (중간)**. 구조적 피처: 단일 파일·단일 함수(`routine`), 골드 패치 실질 변경 ~10줄, `has-repro`(완전한 재현 스니펫 + 잘못된 C 출력까지 제시)로 localize는 쉬운 편. 그러나 두 곳(메인 루프 + `argument_sequence` 핸들러)에 같은 로직이 들어가야 하고, 올바른 조건(`isinstance(symbol, (IndexedBase, MatrixSymbol))`)을 추론해야 한다는 점에서 T2보다는 위.
- 공식 라벨 "15분-1시간"과 정합. P2P가 55개로 넓어 `regression-trap`이 있으나(인자 순서·loops·matrix slice 등 모든 기존 codegen 동작 보존 요구), 픽스가 순수 additive라 트랩 강도는 중간.

## 골드패치 분석
- **파일·함수**: `sympy/utilities/codegen.py`의 `CodeGen.routine`.
- **근본원인**: `argument_sequence`가 주어지면 코드가 인자 리스트를 사용자 지정 순서로 재구성한다. 이때 표현식에 등장하지 않는 인자는 `name_arg_dict`에 없어 `KeyError` 분기로 빠지고, 거기서 `InputArgument(symbol)`을 **dimensions 메타데이터 없이** 생성했다. dimensions가 없으면 codegen은 그 인자를 스칼라(`double x`)로 출력한다. 반면 메인 루프(`for symbol in sorted(symbols, ...)`)는 `array_symbols`를 보고 배열형에 dimensions를 부여하지만, `1.0` 같은 표현식엔 `x`가 `symbols`에 없어 이 경로를 타지 못한다.
- **수정요지**: (1) `def dimensions(s): return [(S.Zero, dim - 1) for dim in s.shape]` 헬퍼를 추출해 기존 인라인 루프를 대체. (2) `KeyError` 핸들러에서 `isinstance(symbol, (IndexedBase, MatrixSymbol))`이면 `dimensions(symbol)`을 메타데이터로 부여하고, 아니면 빈 메타데이터로 `InputArgument(symbol, **metadata)` 생성. 이로써 미등장 배열 인자도 `double *`로 올바르게 나온다.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_ccode_unused_array_arg` 1개. `x = MatrixSymbol('x', 2, 1)`을 `argument_sequence=(x,)`로 넘기되 `name_expr=("test", 1.0)`로 표현식에 등장시키지 않고, 생성된 C 소스가 `double test(double *x)` 시그니처를 갖는지 정확히 문자열 비교한다.
- **픽스 증명**: 픽스 전엔 `x`가 `KeyError` 경로에서 dimensions 없이 생성되어 `double x`로 출력 → 테스트의 `double *x` 기대와 불일치로 FAIL. 픽스 후 `MatrixSymbol` 분기가 dimensions를 부여 → 포인터로 출력 → PASS.
- **overfit·regression 관점**: 테스트가 1개라 얇지만(`overfit-risk` 소지), 픽스는 `IndexedBase`까지 함께 처리해 `MatrixSymbol` 특수화에 머물지 않는다. dimensions 헬퍼는 기존 메인 루프와 동일식이라 동작 동치. 55개 P2P(인자순서/loops/output_arg/matrix slice)가 모두 통과하므로 정상 경로 회귀 없음.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 "잘못된 C 시그니처(`double x` vs `double *x`)" + "표현식이 인자에 의존하면 정상"이라는 대조 단서를 준다 → 배열 인자의 dimensions 부여 로직을 찾는다. `routine`에서 dimensions를 다루는 두 지점(메인 `for symbol` 루프와 `argument_sequence` 재배열의 `KeyError` 핸들러)을 비교하면, 핸들러만 메타데이터를 누락함이 드러난다.
2. **픽스(왜 올바른 일반화)**: 누락된 분기에 메인 루프와 같은 dimensions 부여를 재현한다. 조건을 `MatrixSymbol`만이 아니라 `(IndexedBase, MatrixSymbol)`로 잡는 것이 핵심 — codegen이 두 타입 모두를 배열로 취급하기 때문. 메인 루프가 `array_symbols`에 둘 다 수집하는 사실과 일치하므로 테스트 1개를 넘어선 올바른 일반화다.
3. **regression 안전**: `else: metadata = {}`로 비배열 인자는 기존과 byte-identical하게 유지. dimensions 헬퍼는 인라인 식을 그대로 추출한 것이라 메인 루프 출력도 불변. 따라서 인자순서·loops·output_arg·matrix slice 등 55개 P2P를 깨지 않는다.
4. **함정 회피**: 오라클 없는 에이전트는 (a) `KeyError` 핸들러가 아니라 메인 루프나 `MatrixSymbol` printer를 고치려다 빗나가거나, (b) `MatrixSymbol`만 isinstance 체크해 `IndexedBase` 케이스를 빠뜨리거나, (c) dimensions 산출식을 메인 루프와 미묘하게 다르게 적어 정상 경로를 깨기 쉽다. 회피법: "정상 경로와 동일한 메타데이터를 미등장 인자 경로에 그대로 복제"라는 대칭 원칙을 고수하고, codegen이 배열로 보는 타입 집합(`IndexedBase`+`MatrixSymbol`)을 정확히 맞춘다.
