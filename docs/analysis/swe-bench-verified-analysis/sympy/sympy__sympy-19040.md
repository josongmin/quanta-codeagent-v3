---
instance_id: sympy__sympy-19040
repo: sympy/sympy
base_commit: b9179e80d2daa1bb6cba1ffe35ca9e6612e115c9
version: "1.6"
difficulty: "15 min - 1 hour"
created_at: "2020-03-31T19:53:54Z"
fail_to_pass: 1
pass_to_pass: 148
gold_files: [sympy/polys/factortools.py]
primary_type: T-DirectMap
tier: T3
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`factor(z, extension=[I])`가 다변수 다항식 인수 하나를 통째로 떨군다. 예: `z = expand((x-1)*(y-1))`을 `extension=[I]`로 인수분해하면 `(x-1)*(y-1)` 대신 `x - 1`만 반환되어 `y-1` 인수가 사라진다. 이슈와 hints에 "L1150의 typo"라고 정확히 적시되어 있고, 동일 stackoverflow 재현코드가 첨부돼 있다. 관련 XFAIL 테스트(`test_issue_5786`)가 이미 존재한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: hints_text가 파일·라인(`factortools.py#L1150`)과 "typo"라고 직접 지목. `dmp_ext_factor` 한 함수로 grep 한 방에 수렴. 탐색 비용 사실상 0.
- **S1 (Direct-Map) + 보조 S2**: 최종 픽스는 1글자(`f`→`F`) 변경으로 기계적이지만, **왜 `F`(원본)여야 하는가**는 squarefree-part와 squarefree-norm의 대수적 관계를 따져야 정당화된다 — 그래서 보조로 constraint-reasoning이 붙는다. 다만 hints가 typo로 못박아 추론 부담을 거의 제거.
- **K-Domain**: `dmp_sqf_part`/`dmp_sqf_norm`/`dmp_trial_division`의 대수적 수체(algebraic number field) 인수분해 파이프라인 의미를 알아야 인과를 이해. 일반 파이썬 추론으로는 "왜 인수가 떨어지는지" 설명 불가.
- **primary = T-DirectMap**: 위치가 명확(L0)하고 핵심 수정이 기계적 인자 교정(S1). T-LocTrivial이 아닌 이유는 픽스 정당화에 도메인 의미가 끼어들기 때문.

APR 관점: 후보 패치공간이 사실상 단일(어느 변수를 norm에 넘기느냐)이라 generate-&-validate가 아니라 direct-map. 이슈가 결함 위치·성격을 명세하므로 template 매칭에 가깝다.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일 1개 / 헌크 1개 / 실효 변경 1글자 → scope는 T1~T2급.
- localize 직접성 최상(L0, has-repro) → 난이도를 끌어내림.
- 그러나 **regression-trap이 강함**: PASS_TO_PASS 148개(`test_factor`, `test_sqf_norm`, `test_factor_large`, `test_torational_factor_list` 등 인수분해·sqf 경로 전체)를 안 깨야 한다. `f`→`F`는 `dmp_sqf_norm`에 넘기는 입력을 바꾸므로 잘못 일반화하면 squarefree 입력의 기존 동작을 회귀시킬 수 있다.
- 도메인 지식(K-Domain)이 정당화에 필요 → T2 위로 민다.

공식 라벨(15분~1시간)과 일치. typo 수정 자체는 분 단위지만 "왜 옳은가"를 sqf 파이프라인으로 확인하는 데 시간이 든다.

## 골드패치 분석
- **파일/함수**: `sympy/polys/factortools.py`의 `dmp_ext_factor` (대수적 수체 위 다변수 인수분해).
- **근본원인**: `f, F = dmp_sqf_part(f, u, K), f` 로 `f`는 squarefree-part, `F`는 원본 다항식이 된다. 직후 `s, g, r = dmp_sqf_norm(f, u, K)` 에서 **squarefree-part `f`** 를 norm 계산에 넘긴 게 typo. squarefree-norm은 원본 `F`로부터 인수들을 복원해야 하는데, 미리 squarefree로 깎아낸 `f`를 쓰면 norm `r`의 인수 리스트가 원본 인수 집합과 어긋나 일부 인수(`y-1`)가 `dmp_trial_division(F, factors, ...)` 단계에서 매칭/복원되지 못하고 누락된다.
- **수정요지**: `dmp_sqf_norm(f, ...)` → `dmp_sqf_norm(F, ...)`. norm을 원본 `F` 기준으로 계산해 trial division이 원본의 모든 인수를 회수하도록 정합성을 맞춘다. `f`는 이후에도 `len(factors)==1`일 때 fallback으로 여전히 쓰이므로 변수 자체는 유지된다.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_issue_5786`** (1개). test_patch는 이 테스트에서 `@XFAIL` 데코레이터를 제거하고 `XFAIL` import도 정리한다. 단언: `expand(factor(expand((x - I*y)*(z - I*t)), extension=[I])) == -I*t*x - t*y + x*z - I*y*z`. 즉 `extension=[I]`에서 인수가 보존돼 expand 왕복이 항등이 되어야 통과.
- **픽스 증명**: 버그 상태에선 인수 누락으로 좌변이 우변과 불일치(그래서 원래 XFAIL). `F` 전달로 모든 인수가 복원되면 등식 성립 → XFAIL 해제가 곧 픽스 증명.
- **overfit 관점**: FAIL_TO_PASS가 1개라 얇아 보이지만, 픽스가 단일-글자 인자 교정이라 special-case로 우회할 여지가 없다(테스트별 분기 불가). overfit-risk는 낮게 본다.
- **regression 관점**: 148개 P2P 중 `test_sqf_norm`, `test_factor`, `test_factor_large`, `test_torational_factor_list`가 동일 코드경로를 밟는다. `F`가 squarefree인 통상 케이스에선 `F==f`라 동작이 보존돼 회귀 없음 — 이게 변경이 안전한 핵심 이유.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 재현코드(`factor(z, extension=[I])` → `y-1` 소실)와 hints의 "typo at factortools.py#L1150"가 곧장 `dmp_ext_factor`를 지목. `extension` 키워드 → 대수적 수체 인수분해 → `dmp_ext_factor` 호출체인으로 수렴. grep 한 방.
2. **픽스**: `f, F = dmp_sqf_part(f), f` 직후 `f`(squarefree-part)와 `F`(원본)의 역할을 읽고, `dmp_sqf_norm`이 원본 인수 복원의 기준이어야 함을 파악 → `f`→`F`. 올바른 일반화인 이유: trial division이 `F` 기준으로 돌므로 norm도 `F` 기준이어야 인수집합이 일관된다. 특정 입력에 맞춘 게 아니라 파이프라인 정합성 회복.
3. **regression 안전**: `F`가 이미 squarefree면 `f==F`라 기존 squarefree 경로 동작 불변 → `test_sqf_norm`/`test_factor`/`test_factor_large` 등 P2P 보존. multiplicity 있는 케이스에서만 동작이 교정된다.
4. **함정 회피**: 오라클 없는 에이전트가 빠질 함정은 (a) `dmp_sqf_part`를 의심해 sqf 로직 자체를 건드리거나, (b) `dmp_trial_division`/`dmp_inner_gcd` 쪽에 가드를 추가해 증상만 막는 것. 정답은 데이터플로우상 **norm 입력이 원본이어야 한다**는 단일 지점뿐. hints의 "typo" 신호를 신뢰해 인자 출처(`f` vs `F`)부터 본 사람이 최단경로로 도달한다.
