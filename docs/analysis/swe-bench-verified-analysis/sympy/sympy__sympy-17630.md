---
instance_id: sympy__sympy-17630
repo: sympy/sympy
base_commit: 58e78209c8577b9890e957b624466e5beed7eb08
version: "1.5"
difficulty: 1-4 hours
created_at: 2019-09-18T22:56:31Z
fail_to_pass: 2
pass_to_pass: 19
gold_files: [sympy/matrices/expressions/matexpr.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L2
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

## 로컬 quanta receipt (2026-06-20)

- **PASS receipt**: durable sidecar `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-007cd5902aad2e32c.json`.
- **run**: `agentless-v1`, `gpt-5.5`, official swebench harness, 26 turns, 616B patch.
- **patch**: `sympy/matrices/expressions/matexpr.py`에서 `if cls == Add: return mat_class(*matrices).doit(deep=False)` 추가. Gold의 `if mat_class == MatAdd:`와 syntactic form은 다르지만 official grader PASS.
- **해석**: 이전 `_blockmul` 패치는 실패모드 RCA로 유지한다. 현재 상태는 active unresolved/model ceiling이 아니라 **single-shot localization variance + symptom-root split** 케이스다.

## 문제 요약
`ZeroMatrix` 블록을 포함한 `BlockMatrix`를 한 번 블록곱하면 멀쩡하지만, 두 번 곱하면 `AttributeError: 'Zero' object has no attribute 'cols'`가 터진다. 이슈 제출자가 직접 진단한 근본 원인은 `b._blockmul(b)` 결과의 영(zero) 블록이 행렬 `ZeroMatrix`가 아니라 **스칼라 `sympy.core.numbers.Zero`** 로 바뀌어 들어간다는 점이다. 즉 행렬 덧셈 과정에서 `ZeroMatrix + ZeroMatrix`가 행렬형을 잃고 스칼라 `Zero`로 붕괴해, 다음 라운드의 `colblocksizes`가 `.cols`를 찾지 못한다.

## 유형 (정형화)
- **L (Localization) = L2.** 이슈는 `BlockMatrix`/`block_collapse`/`_blockmul`을 가리키지만 진짜 결함은 거기가 아니다. 스택트레이스가 가리키는 `blockmatrix.py:colblocksizes`는 **증상 지점**일 뿐이고, 실제 수정처는 `MatAdd` 생성 시 후처리를 담당하는 `matexpr.py`의 `get_postprocessor`/`_postprocessor`다. "왜 `Zero`가 들어갔나"를 cross-module 데이터플로우(BlockMatrix 곱 → MatAdd 결합 → 생성자 postprocessor)로 역추적해야 도달한다 → diffuse.
- **S (Repair Strategy) = S2 (Constraint-Reasoning).** 후보를 마구 시도하는 G&V가 아니라, "행렬만 있고 스칼라가 없는 `Add`는 `mat_class(cls._from_args(nonmatrices), *matrices)`로 감싸면 안 된다(`cls._from_args([]) == S.Zero` 스칼라가 섞여 들어감)"는 **불변식을 추론**해 정확한 분기 한 줄을 합성한다.
- **K (Knowledge) = K-Domain.** SymPy의 `_constructor_postprocessor_mapping`, `MatAdd` vs `Add`, `ZeroMatrix` vs 스칼라 `Zero` 구분 등 코어 내부 모델을 알아야 한다.
- **primary = T-ConstraintReason.** 위치 자체가 비자명(L2)하지만 진짜 난점은 "올바른 조건식 한 줄"을 불변식 추론으로 만드는 데 있다 → ConstraintReason이 dominant.

## 난이도 티어
**T4 (약간 어려움).** 구조 피처:
- 파일 수 1개, 추가 줄 2줄 — scope는 극소.
- 그러나 **localize 직접성이 낮다(L2):** 에러 메시지(`'Zero' object has no attribute 'cols'`)와 스택트레이스가 전부 `blockmatrix.py`를 가리키는데, 올바른 수정처는 `matexpr.py`의 postprocessor라서 증상↔원인이 다른 파일이다(`cross-file-dep`).
- `has-repro`: 3줄 재현 + 제출자의 부분 진단("`Zero` 아닌 `ZeroMatrix`여야") 존재 → easiness 신호.
- 도메인 지식 필요(K-Domain), `regression-trap`: MatAdd/Add 생성 후처리는 모든 행렬식 조립 경로의 공통 길목이라 19개 P2P가 이 한 줄에 노출된다.
- 공식 라벨 `1-4 hours`와 대체로 일치. 픽스는 2줄이지만 "올바른 파일·올바른 조건"을 찾는 데 시간이 든다는 점을 반영한 라벨로 본다.

## 골드패치 분석
- **파일/함수:** `sympy/matrices/expressions/matexpr.py` 내 `get_postprocessor(cls)`가 반환하는 클로저 `_postprocessor(expr)`.
- **근본원인:** `Add`(=`cls`)에 행렬 항만 있고 스칼라(`nonmatrices`)가 비어 있을 때, 마지막 줄 `return mat_class(cls._from_args(nonmatrices), *matrices).doit(deep=False)`가 실행된다. `cls._from_args([])`는 `Add._from_args([]) == S.Zero`(스칼라 0)를 반환하므로 결과가 `MatAdd(S.Zero, ZeroMatrix, ...)`처럼 **스칼라 `Zero`를 행렬 합 안에 섞는다.** `MatAdd.doit`이 이를 단순화하면서 영블록이 행렬 `ZeroMatrix`가 아닌 스칼라 `Zero`로 흘러나가, 다음 블록곱에서 `.cols` 접근이 실패한다.
- **수정요지:** 마지막 fallthrough 직전에
  ```python
  if mat_class == MatAdd:
      return mat_class(*matrices).doit(deep=False)
  ```
  를 추가. 덧셈 경로에서는 스칼라 0을 아예 끼우지 않고 순수 `MatAdd(*matrices)`만 doit 하여 영블록이 `ZeroMatrix`로 유지된다. (이 시점에는 이미 `if nonmatrices:` 분기를 통과해 `nonmatrices`가 비어 있음이 보장되므로 스칼라 손실 없음.)

## 검증 (test_patch)
- **FAIL_TO_PASS (2):**
  - `test_issue_17624` (test_blockmatrix.py): `block_collapse(b*b) == BlockMatrix([[a**2, z],[z, z]])` **그리고** 핵심인 `b*b*b`가 예외 없이 `BlockMatrix([[a**3, z],[z, z]])`로 접힘 — 2회 곱 회귀를 직접 잠근다.
  - `test_zero_matrix_add` (test_matadd.py): `Add(ZeroMatrix(2,2), ZeroMatrix(2,2)) == ZeroMatrix(2,2)` — 결과가 스칼라 `Zero`가 아닌 행렬 `ZeroMatrix`임을 단위 수준에서 못박는다(근본원인 직격).
- **픽스 증명:** 픽스 후 `Add(ZeroMatrix, ZeroMatrix)`가 `MatAdd(*matrices).doit`을 타 `ZeroMatrix`를 산출 → `b._blockmul(b)`의 영블록이 행렬형 유지 → 두 번째 `_blockmul`의 `colblocksizes`가 `.cols`를 정상 접근.
- **overfit 관점:** 단위테스트(`test_zero_matrix_add`)가 증상이 아닌 **메커니즘**(반환 타입)을 검증하므로 `b*b*b`만 통과시키는 special-case 픽스는 막힌다. 추가된 `@XFAIL test_matrix_add_with_scalar`는 `Add(0, ZeroMatrix)`가 `TypeError`여야 한다는 미래 스펙을 의도적으로 보류 표기 — 이번 픽스가 스칼라+행렬 혼합 가산을 "고치지 않음"을 정직하게 남긴다.
- **regression 관점:** 19개 P2P(`test_matadd_of_matrices`, `test_doit_args`, `test_generic_identity`, `test_BlockMatrix*` 등)가 MatAdd/BlockMatrix 조립 공통경로를 광범위 커버. `nonmatrices`가 있는 경우는 새 분기를 타지 않으므로 기존 동작 보존.

## 모범답안 (오라클 기반)
1. **localize 경로:** 스택트레이스의 `'Zero' object has no attribute 'cols'`와 제출자 진단("영블록이 `ZeroMatrix` 아닌 `Zero`")을 신뢰해 **타입 붕괴 지점**을 추적한다. `blockmatrix.py`(증상)에 멈추지 말고 "`ZeroMatrix + ZeroMatrix`가 어디서 스칼라가 되나"를 따라가면 `matexpr.py`의 `Add` 생성자 postprocessor(`_postprocessor`)에 도달한다.
2. **픽스와 일반화 근거:** `nonmatrices`가 빈 덧셈 경로에서 `cls._from_args([]) == S.Zero`가 행렬 합에 섞이는 게 원인. 따라서 `mat_class == MatAdd`일 때 스칼라를 끼우지 않고 `MatAdd(*matrices)`만 반환. 이는 `b*b*b`라는 특정 입력이 아니라 "**스칼라 없는 행렬 덧셈은 행렬형을 보존한다**"는 불변식을 복원하므로 올바른 일반화다(overfit 아님).
3. **regression 안전:** `if nonmatrices:` 분기는 그대로 두어 스칼라+행렬 혼합(`Add(scalar, matrix)`)의 기존 능력을 보존해야 한다 — 주석이 명시한 "다른 알고리즘이 행렬식을 비가환 심볼로 치환" 시나리오를 깨면 안 됨. 새 분기는 `nonmatrices`가 빈 경우에만 진입하므로 19개 P2P 무사.
4. **함정 회피:** (a) 증상 지점인 `colblocksizes`/`_blockmul`에 `isinstance(..., Zero)` 가드를 추가하는 **증상 패치**는 타입 붕괴를 그대로 둔 채 다른 경로에서 재발한다 — 근본원인을 놓치는 전형적 L2 함정. (b) `Mul` 경로까지 건드려 일반화하면 스칼라 흡수 로직을 깨 회귀. 덧셈에 한정(`mat_class == MatAdd`)하는 것이 정답. (c) `Add(0, ZeroMatrix)`의 `TypeError`까지 욕심내면 별개 스펙이라 과도 — 오라클은 이를 `@XFAIL`로 분리해 둔다.
