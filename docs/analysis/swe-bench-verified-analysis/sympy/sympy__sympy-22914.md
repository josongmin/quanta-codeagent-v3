---
instance_id: sympy__sympy-22914
repo: sympy/sympy
base_commit: c4e836cdf73fc6aa7bab6a86719a0f08861ffb1d
version: "1.10"
difficulty: "15 min - 1 hour"
created_at: 2022-01-25T10:37:44Z
fail_to_pass: 1
pass_to_pass: 17
gold_files: [sympy/printing/pycode.py]
primary_type: T-DirectMap
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro]
---

## 문제 요약
`PythonCodePrinter`가 sympy의 `Min`/`Max` 함수를 파이썬 코드로 변환하지 못한다. `pycode(Min(a, b))`를 호출하면 `# Not supported in Python: # Min` 주석과 함께 `Min(a, b)`를 그대로 뱉는다. 이슈 본문은 파이썬 내장 `min`/`max`로 매핑하면 된다고 직접 명시하고, hints에서는 `_known_functions` 딕셔너리에 항목을 추가하는 최소 방법까지 제시한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 클래스(`PythonCodePrinter`)와 변환 대상 심볼(`Min`/`Max`)을 직접 지목. `pycode.py`의 `_known_functions`만 보면 끝. grep 한 방.
- **S1 (Direct-Map)**: 픽스가 사실상 명세됨 — 기존 `'Abs': 'abs'` 패턴과 동형으로 `'Min': 'min'`, `'Max': 'max'` 두 상수 항목을 테이블에 추가하는 기계적 작업. 이슈가 제안한 `_print_Min`/`_print_Max` 메서드 대신 hints의 테이블-등록 경로가 골드패치가 채택한 더 간결한 방법.
- **K-Domain**: sympy printer 아키텍처 지식이 약하게 필요 — `_known_functions`가 `CodePrinter`의 dispatch 메커니즘에 의해 `_print_Function`을 통해 자동 변환된다는 점을 알아야 "메서드 추가" 대신 "테이블 추가"로 풀 수 있음. 다만 일반 추론으로도 도달 가능.
- **primary = T-DirectMap**: 위치가 자명(L0)하고 픽스가 정형 테이블 등록(S1)이라 추론 합성이 불필요. 이슈가 픽스를 거의 그대로 적어주는 전형적 direct-map.

## 난이도 티어
- **T1 (존나쉬움)**: 1파일(`pycode.py`) + 골드패치 실질 2줄(추가만). localize 직접성 최상(L0), has-repro(이슈에 정확한 재현 스니펫과 잘못된 출력 동봉). P2P 17개지만 모두 인접 printer 테스트라 trap이 약함 — 딕셔너리에 키 2개를 *추가만* 하므로 기존 동작을 건드릴 표면이 없다.
- 공식 라벨 "15 min - 1 hour"는 개발자가 PR 절차(테스트 작성·CI)까지 포함한 시간일 뿐, 에이전트 관점 수정 난이도는 T1. 구조적 피처(파일 1·줄 ≲5·repro·additive)가 모두 최저난이도 컷(1파일·<5줄 ≈ 48% solve)에 들어맞아 시간라벨보다 낮게 재조정.

## 골드패치 분석
- **건드린 파일·함수**: `sympy/printing/pycode.py`의 모듈 레벨 딕셔너리 `_known_functions`.
- **근본원인**: `PythonCodePrinter`는 `_known_functions`(및 `_known_functions_math` 등)에 등록된 함수명만 변환할 수 있는데, `Min`/`Max`가 이 테이블에 누락되어 있었다. 미등록 함수는 `_print_Function`이 "Not supported" 주석을 달고 원형을 출력한다.
- **수정요지**: `_known_functions`에 `'Min': 'min'`, `'Max': 'max'` 두 항목을 추가. 이로써 dispatch가 sympy `Min`/`Max`를 파이썬 내장 `min`/`max` 호출로 렌더한다. 별도 `_print_Min`/`_print_Max` 메서드는 불필요(테이블 경로가 인자 직렬화까지 처리).

## 검증 (test_patch)
- **FAIL_TO_PASS** `test_PythonCodePrinter`: `assert prntr.doprint(Min(x, y)) == "min(x, y)"`와 `Max` 대응 단언 2줄 추가. 픽스 전에는 `Min(x, y)` 문자열이 나와 실패, 픽스 후 테이블 변환으로 `min(x, y)` 산출 → 통과. 즉 테스트가 정확히 골드패치의 동작을 증명한다.
- **overfit 관점**: FAIL_TO_PASS가 1개 테스트로 얇지만, 픽스 자체가 데이터-주도(테이블 항목)라 special-case 분기가 들어갈 여지가 없어 overfit 위험은 사실상 0. `min(x, y)`/`max(x, y)` 두 케이스가 다인자 정렬 직렬화를 함께 커버.
- **regression 관점**: 변경이 순수 additive(키 2개 추가)라 기존 17개 P2P(`test_NumPyPrinter`, `test_SciPyPrinter`, `test_MpmathPrinter` 등)가 보는 다른 함수 변환 경로를 건드리지 않는다. regression-trap 플래그 미부여 정당.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 출력 `# Not supported in Python: # Min`이 결정적 신호. 이 문자열을 `sympy/printing/`에서 grep → `CodePrinter._print_Function`의 미지원 처리 발견 → 지원 함수의 출처인 `_known_functions` 테이블(`pycode.py`)로 수렴. `'Abs': 'abs'` 한 줄이 정답 패턴을 보여준다.
2. **픽스와 일반화**: `_print_Min`/`_print_Max` 메서드를 손으로 짜는 대신 `_known_functions`에 `'Min':'min'`,`'Max':'max'` 등록 — 이것이 올바른 일반화인 이유는 (a) 기존 인프라가 인자 직렬화·괄호·재귀 출력을 이미 처리하고, (b) 동일 메커니즘이 향후 다른 빌트인 매핑에도 일관되게 작동하기 때문. 이슈 제안(메서드) 대비 hints 경로(테이블)가 코드 중복이 없어 더 정확한 SOTA.
3. **regression 안전**: 변경은 딕셔너리 신규 키 2개뿐 — 기존 키·다른 printer 서브클래스(NumPy/SciPy/Mpmath)의 동작에 영향 없음. 따라서 17개 P2P는 정의상 안전.
4. **함정 회피**: 오라클 없는 에이전트의 흔한 실수는 (a) 이슈가 적어준 대로 `_print_Min`/`_print_Max` 메서드를 추가해 *동작은 맞지만* 테이블 패턴과 중복되는 비-canonical 픽스를 내는 것(테스트는 통과하나 리뷰어 의도와 어긋남), (b) NumPy/SciPy printer에도 같은 변경을 시도해 scope를 넘기는 것. `_known_functions` 한 곳에 최소 추가하는 것이 정답. `min`/`max`가 파이썬 예약어가 아닌 내장이라 `test_pycode_reserved_words` 같은 인접 보호장치와도 충돌하지 않음.
