---
instance_id: sympy__sympy-21930
repo: sympy/sympy
base_commit: de446c6d85f633271dfec1452f6f28ea783e293f
version: "1.9"
difficulty: "15 min - 1 hour"
created_at: 2021-08-22T20:29:08Z
fail_to_pass: 6
pass_to_pass: 45
gold_files: [sympy/physics/secondquant.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L0
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
second quantization 모듈의 LaTeX 출력이 dagger 연산자를 거듭제곱할 때 깨진다. `Commutator(Bd(a)**2, B(a))`가 `b^\dagger_{0}^{2}`처럼 이중 위첨자(double superscript)를 만들어 Jupyter에서 렌더링이 실패한다. 이슈는 원인(중괄호 미감싸기)과 해법(`{b^\dagger_{0}}^{2}` 형태로 그루핑)을 본문에 그대로 적어준다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 깨지는 출력 문자열 `b^\dagger_{0}`을 직접 보여줘서 `secondquant.py` 내 `_latex` 메서드들로 grep 한 방에 수렴한다. 탐색 거의 불필요.
- **S2 (Constraint-Reasoning, +S1)**: 픽스 위치는 자명하지만 "LaTeX에서 거듭제곱 합성 시 base가 atomic해야 한다"는 불변식을 이해하고 *각 `_latex` 반환 토큰 전체를 `{...}`로 감싸는* 일반화를 추론해야 한다. 단순 한 군데 상수치환이 아니라 동일 결함클래스가 여러 `_latex`에 반복되므로 기계적(S1) 성격도 동반.
- **K-Domain**: LaTeX superscript 그루핑 규칙 + sympy printer가 `Pow`를 `<base>^{2}`로 조립할 때 base 문자열을 그대로 끼워넣는다는 도메인 지식 필요.
- **primary = T-ConstraintReason**: 위치는 명확하나 "왜 중괄호로 전체를 감싸야 하는가"(외부 위첨자가 붙어도 base가 단일 토큰으로 보장되도록)를 추론으로 합성하는 것이 본질. 이슈가 답을 적어줘서 S1에 가깝지만, 동일 패턴을 모든 ladder operator/AntiSymmetricTensor `_latex`에 일관 적용하는 일반화 판단이 핵심.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 단일 파일(`secondquant.py`) 3개 헌크, 각 1줄 치환(총 3줄 변경), localize 직접성 최상(L0), `has-repro`(이슈에 실행 가능한 재현 + 기대 출력). 도메인 지식은 얕은 LaTeX 그루핑 규칙 수준. 다만 `regression-trap`이 약하게 존재 — `_latex` 출력 포맷을 바꾸므로 다수 기존 테스트의 기대 문자열이 함께 갱신돼야 한다(test_patch가 6개 단언을 수정). 공식 라벨 "15min-1h"와 일치하며 상향/하향 조정 불요. T1이 아닌 이유: 단일 상수가 아니라 동일 결함을 여러 `_latex`에 반복 적용하고, 출력포맷 변경이 인접 단언을 깨므로.

## 골드패치 분석
- **건드린 파일/함수**: `sympy/physics/secondquant.py`의 세 `_latex` 메서드 —
  - `AntiSymmetricTensor._latex` (라인 ~218): `"%s^{%s}_{%s}"` → `"{%s^{%s}_{%s}}"`
  - `CreateBoson._latex` (라인 ~478): `"b^\\dagger_{%s}"` → `"{b^\\dagger_{%s}}"`
  - `CreateFermion._latex` (라인 ~939): `"a^\\dagger_{%s}"` → `"{a^\\dagger_{%s}}"`
- **근본원인**: 이들 `_latex`가 위첨자/아래첨자를 포함한 문자열을 반환하는데, 상위 printer가 `Pow`를 출력할 때 이 반환값을 base로 받아 `<base>^{2}`로 이어 붙인다. base에 이미 `^\dagger`가 있어 `b^\dagger_{0}^{2}` 같은 **이중 위첨자**가 생기고 LaTeX가 이를 거부/오해석한다.
- **수정요지**: 각 반환 토큰 전체를 `{...}`로 감싸 base를 atomic 그룹으로 만든다. 그러면 외부 `^{2}`가 붙어도 `{b^\dagger_{0}}^{2}`가 되어 그루핑이 명확해진다.

## 검증 (test_patch)
- **FAIL_TO_PASS (6개)**: `test_issue_19661`이 핵심 신규 테스트 — `latex(Commutator(Bd(a)**2, B(a)))`가 `'- \left[b_{0},{b^\dagger_{0}}^{2}\right]'`임을 단언해 이중 위첨자 그루핑을 직접 검증한다. 나머지 5개(`test_create`/`test_commutation`/`test_create_f`/`test_NO`/`test_Tensors`)는 변경된 출력포맷에 맞춰 기존 기대 문자열을 `b^\dagger_{i}` → `{b^\dagger_{i}}`, `t^{ab}_{ij}` → `{t^{ab}_{ij}}` 등으로 갱신 — 포맷 변경이 의도대로 전파됨을 증명.
- **overfit 관점**: `test_issue_19661`이 Pow가 붙는 *진짜* 깨짐 케이스를 잡고, 나머지가 단독 출력(거듭제곱 없는 경우)도 새 포맷으로 일관됨을 강제하므로 special-case 회피가 어렵다. overfit 위험 낮음.
- **regression 관점**: `_latex` 포맷 변경이라 동일 출력을 단언하는 인접 테스트가 함께 깨질 수 있는데, test_patch가 그 6곳을 정확히 갱신했다. PASS_TO_PASS 45개(repr/str/srepr/대수연산)는 LaTeX 출력에 의존하지 않아 영향 없음.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 깨진 출력 `b^\dagger_{0}^{2}` 문자열을 단서로 `secondquant.py`에서 `_latex` 정의를 grep → `\dagger` 리터럴을 가진 `CreateBoson._latex`, `CreateFermion._latex` 즉시 발견. 추가로 `AntiSymmetricTensor._latex`도 동일하게 위/아래첨자 포함 토큰을 반환하므로 같은 결함클래스로 함께 포함.
2. **픽스와 일반화 근거**: 각 `_latex` 반환 문자열 전체를 `{...}`로 감싼다. 이게 올바른 일반화인 이유 — 깨짐은 "거듭제곱 시 base가 위첨자를 이미 가지면 이중 superscript"라는 **base의 비원자성** 때문이고, 한 케이스(`b^\dagger`)만 고치면 fermion/tensor에서 동일 버그 재발. 결함이 "위첨자 포함 토큰을 base로 노출하는 모든 `_latex`"에 걸치므로 세 곳 모두 감싸는 게 결함클래스 차원의 수리.
3. **regression 안전**: 출력포맷이 바뀌므로 동일 LaTeX를 단언하는 5개 기존 테스트를 새 포맷으로 갱신해야 한다(test_patch가 수행). repr/str 기반 PASS_TO_PASS 45개는 건드리면 안 되고 실제로 무관 — LaTeX printer만 변경하므로 `__repr__`/`__str__` 경로는 byte-identical 유지.
4. **함정 회피**: 오라클 없는 에이전트가 빠질 함정 — (a) `CreateBoson._latex` 한 곳만 고치고 `CreateFermion`/`AntiSymmetricTensor`를 누락(이슈 예시가 boson만 보여줌). dagger/superscript 토큰 반환하는 `_latex` 전수조사로 회피. (b) 중괄호를 base가 아니라 외부 `Pow` printer 쪽에 넣으려다 다른 출력까지 깨뜨림 — 수정 지점은 base를 생산하는 `_latex`여야 함. (c) 포맷 변경에 따른 기존 단언 갱신을 빠뜨려 FAIL_TO_PASS가 인접 테스트에서 새로 깨지는 것.
