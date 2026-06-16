---
instance_id: sympy__sympy-13031
repo: sympy/sympy
base_commit: 2dfa7457f20ee187fbb09b5b6a1631da4458388c
version: "1.1"
difficulty: "15 min - 1 hour"
created_at: 2017-07-23T15:48:13Z
fail_to_pass: 1
pass_to_pass: 9
gold_files: [sympy/matrices/sparse.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
sympy 1.1에서 `SparseMatrix.hstack`/`vstack`의 빈(0-차원) 행렬 누적 동작이 회귀했다. `[SparseMatrix.zeros(0, n) for n in range(4)]`를 `hstack`하면 shape가 `(0, 6)`이어야 하는데 `(0, 3)`을 반환한다. 같은 패치로 Dense `Matrix`는 이미 고쳐졌으나(`#10770`) `SparseMatrix`에는 미적용 상태였다. 핵심은 0-row(또는 0-col) 빈 행렬이 누적 사슬에서 무시되어 col 합산이 누락되는 것.

## 유형 (정형화)
- **L = L1 (Traceable)**: 이슈가 `hstack`/`vstack`을 직접 호출하지만, 실제 누적 로직은 `sparse.py`의 `row_join`/`col_join`으로 위임된다. hints에서 "`col_join`이 hstack이 호출하는 것"이라고 명시되어 단일 파일·소수 함수로 빠르게 수렴 가능. grep 한 방은 아니지만 좁다.
- **S = S2 (Constraint-Reasoning)**: 고칠 지점(`if not self: return type(self)(other)`)은 명확하나, 올바른 조건을 추론으로 합성해야 한다. "self가 falsy"라는 통째 단락이 0×n 빈 행렬에서 col 수를 버리는 게 근본원인이므로, "self.rows==0 이면서 cols가 other와 다를 때만" 0-shape를 보존한 재귀 누적으로 교체해야 한다. 후보를 마구 던지는 G&V가 아니라 shape 불변식을 따져 식을 짜는 작업.
- **K = K-Domain (Domain-bound)**: SparseMatrix shape 모델, `_new` 생성자, dense fix(`#10770`)와의 동작 일치라는 sympy 행렬 내부 계약 지식이 병목.
- **primary = T-ConstraintReason**: 위치는 좁게 잡히나, 픽스의 본질이 "빈 행렬은 항상 누적 가능"이라는 불변식을 정확한 조건식으로 환원하는 의미적 추론이라 S2 dominant.
- **APR 관점**: 정형 결함 템플릿(None가드 추가) 매칭이 아니라, 잘못된 early-return 가드를 shape-보존 분기로 *재설계*해야 하므로 SemFix/Angelix 계열의 조건 합성에 해당.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 단일 파일(`sparse.py`) 2헌크, 각 헌크 ~3줄로 scope는 작다(컷 기준상 1파일·소규모 → 쉬운 쪽). `has-repro`(이슈에 정확한 재현 스니펫·기대 shape 명시)는 강한 easiness 신호. 그러나 (1) 픽스가 기계적 가드가 아니라 shape 불변식 추론을 요구하고, (2) dense fix의 의미를 sparse로 *번역*해야 하며, (3) `_eval_col_join` 구현 여부 같은 API 혼란(hints의 "convoluted")이 함정이라 T2를 넘는다. 공식 라벨 "15분~1시간"과 일치 — has-repro 덕에 T4(도메인 깊음/넓은 P2P trap)까지 가지 않는다.

## 골드패치 분석
- **파일·함수**: `sympy/matrices/sparse.py`의 `col_join`(L985 부근), `row_join`(L1191 부근).
- **근본원인**: 두 함수 모두 진입부에 `if not self: return type(self)(other)`가 있었다. 빈 행렬은 `not self`가 True이므로 `other`만 통째로 반환 → 0×0, 0×1, 0×2, 0×3을 hstack하면 누적이 무시되고 마지막/단일 `other`의 col만 살아 `(0,3)`이 나온다. 즉 falsy 단락이 0-차원 누적 사슬에서 col(또는 row) 합산을 파괴.
- **수정요지**: `not self` 단락을 제거하고, `col_join`은 `self.rows == 0 and self.cols != other.cols`일 때 `self._new(0, other.cols, []).col_join(other)`로, `row_join`은 `self.cols == 0 and self.rows != other.rows`일 때 `self._new(other.rows, 0, []).row_join(other)`로 교체. 즉 빈 차원을 other에 맞춰 reshape한 뒤 정상 누적 경로로 재귀시켜 shape 합산을 보존("A null matrix can always be stacked").

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_sparse_matrix` 한 개. `test_sparse.py`에 `[SparseMatrix.zeros(0, n) for n in range(4)]`의 `hstack`이 `Matrix(0, 6, [])`와, `zeros(n, 0)`의 `vstack`이 `Matrix(6, 0, [])`와 같아야 한다는 단언 추가.
- **픽스 증명**: 새 분기가 0×n 빈 행렬을 0×other.cols로 reshape 후 재귀 col_join하므로 6( =0+1+2+3) 누적이 살아난다. 픽스 없으면 falsy 단락이 첫 빈 행렬에서 `other`만 반환해 6이 깨진다 — 단언이 정확히 그 col 합산을 잡는다.
- **overfit/regression 관점**: FAIL_TO_PASS가 단일 테스트라 얇아 보이나, 단언이 hstack/vstack 양방향·전 범위 누적을 검사해 special-case 통과가 어렵다(overfit 위험 낮음). PASS_TO_PASS 9개(`test_transpose`/`test_add`/`test_errors`/`test_sparse_zeros_sparse_eye`/`test_copyin` 등)가 비-빈 행렬 join·shape·assignment를 보호하므로 `regression-trap` — 새 분기를 `rows==0`/`cols==0` && shape 불일치로 좁게 가드한 게 핵심(비-빈 경로는 손대지 않음).

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "hstack/vstack shape 회귀" + hints의 "hstack이 부르는 건 `col_join`, SparseMatrix는 `_eval_col_join`이 아니라 `col_join`을 구현" 신호 → `sympy/matrices/sparse.py`의 `row_join`/`col_join` 진입부로 직행. dense fix(`#10770`)를 diff로 대조하면 동일 클래스 결함임이 드러난다.
2. **픽스**: falsy `if not self` 단락이 0-차원에서 col/row 합산을 버리는 게 원인. 빈 차원을 other에 맞춰 `_new(0, other.cols, [])`/`_new(other.rows, 0, [])`로 reshape 후 정상 누적에 재귀시켜 shape를 보존. 이는 "빈 행렬은 항상 누적 가능"이라는 일반 불변식의 직접 표현이라 특정 입력에 끼워맞춘 overfit이 아니다.
3. **regression 안전**: 분기 조건을 `rows==0 && cols!=other.cols`(및 대칭)로 좁혀 비-빈 행렬과 이미 shape가 맞는 경우는 기존 `A, B = self, other` 경로로 그대로 흐르게 한다 — `test_add`/`test_copyin`/`test_sparse_zeros_sparse_eye` 등 인접 join·assignment를 안 깬다.
4. **함정 회피**: (a) hints의 "`_eval_col_join`을 구현하고 `col_join`을 지우라"는 리팩터 제안에 휩쓸려 over-engineering하면 안 됨 — 릴리스용 최소 픽스는 dense와 동형. (b) `if not self`를 단순 제거만 하면 진짜 빈 행렬 케이스가 깨질 수 있어, reshape-후-재귀로 0-shape를 명시 보존해야 한다. (c) `type(self)(other)` 대신 `_new`를 써야 SparseMatrix 타입·shape가 정확히 유지된다.
