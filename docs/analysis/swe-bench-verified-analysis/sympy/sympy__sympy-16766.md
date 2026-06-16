---
instance_id: sympy__sympy-16766
repo: sympy/sympy
base_commit: b8fe457a02cc24b3470ff678d0099c350b7fef43
version: "1.5"
difficulty: "<15 min fix"
created_at: 2019-05-01T22:02:17Z
fail_to_pass: 1
pass_to_pass: 7
gold_files: [sympy/printing/pycode.py]
primary_type: T-DirectMap
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro]
---

## 문제 요약
`PythonCodePrinter`가 `Indexed` 노드의 print 메서드를 갖고 있지 않아, `pycode(p[0])`(여기서 `p = IndexedBase("p")`)가 `# Not supported in Python: # Indexed` 경고 주석을 출력한다. 그 결과 `lambdify()`로 생성·저장한 코드에 경고가 섞여 들어간다. 이슈 작성자는 누락 원인이 `_print_Indexed` 메서드 부재임을 정확히 진단하고, 추가해야 할 메서드 본문까지 그대로 적어 제공한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 고칠 클래스(`PythonCodePrinter`)와 추가할 메서드명(`_print_Indexed`)을 직접 지목. grep 한 방으로 `sympy/printing/pycode.py`에 도달. 탐색 비용 사실상 0.
- **S1 (Direct-Map)**: 결함 클래스가 "프린터 dispatch 누락 → fallback 주석". 픽스가 정형 템플릿(노드 타입별 `_print_X` 메서드 추가)에 기계적으로 매칭. 이슈 본문이 픽스 본문을 거의 그대로 명세하므로 추론 합성 불필요.
- **K-Domain**: 일반 파이썬 추론만으론 부족. SymPy printer의 dispatch 관례(`_print_<클래스명>`), `Indexed`의 args 구조(`args[0]`=base, `args[1:]`=index 튜플), `parenthesize`/`_print` 재귀 호출 규약 등 프레임워크 내부 지식이 픽스 형태를 결정.

**Primary = T-DirectMap**: 위치가 완전히 명확(L0)하고 픽스가 기계적 메서드 추가(S1)다. K-Domain이 있으나 dominant 병목은 아니다 — 도메인 지식이 "어디서 막혔는지 찾기"를 어렵게 하는 게 아니라 이미 이슈가 다 알려줬다. APR 관점에서 이건 missing-case를 채우는 template repair(PAR/TBar류)이며, 이슈가 패치를 사실상 적어줬으므로 Direct-Map이 정확한 라벨.

## 난이도 티어
**T1 (존나쉬움)**. 구조적 피처:
- 파일수 1 (`pycode.py`), 추가 줄수 ~5줄, 단일 헌크.
- localize 직접성 최상(L0): 이슈가 파일·클래스·메서드명을 지목.
- `has-repro`: `pycode(p[0])` 3줄 재현 코드 + 기대/실제 출력 명시 — 가장 강한 easiness 신호.
- P2P trap 없음: 추가는 순수 additive(새 메서드 부착), 기존 dispatch 경로 미변경.
- 도메인 지식은 필요하나 이슈가 본문을 제공해 실질 추론 부담 0.

공식 라벨 `<15 min fix`와 완전히 일치. 1파일·<5줄·repro 동반은 ICLR 2024 컷에서 가장 높은 solve 구간(≈48%+)에 해당.

## 골드패치 분석
- **건드린 파일·함수**: `sympy/printing/pycode.py` — `PythonCodePrinter` 클래스에 `_print_Indexed` 메서드 신규 추가 (`_print_Not` 바로 뒤).
- **근본원인**: SymPy printer는 노드 타입별 `_print_<ClassName>` 메서드로 dispatch한다. `PythonCodePrinter`(및 그 상위)에 `Indexed` 핸들러가 없어, `CodePrinter`의 미지원 fallback이 `# Not supported in Python: # Indexed` 주석을 emit했다. 즉 누락된 dispatch case가 원인.
- **수정요지**:
```python
def _print_Indexed(self, expr):
    base = expr.args[0]
    index = expr.args[1:]
    return "{}[{}]".format(str(base), ", ".join([self._print(ind) for ind in index]))
```
base는 그대로 문자열화하고, index 각 원소는 `self._print`로 재귀 출력해 `base[i, j, ...]` 형태의 유효한 파이썬 subscript를 생성. 이슈가 제안한 `base, *index = expr.args` 언패킹 대신 명시적 `args[0]`/`args[1:]` 슬라이싱을 썼을 뿐 의미는 동일.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_PythonCodePrinter`** (1개): 테스트 파일에 `from sympy.tensor import IndexedBase`와 `p = IndexedBase("p")`를 추가하고, 기존 테스트 함수 안에 단언 `prntr.doprint(p[0, 1]) == 'p[0, 1]'`을 1줄 삽입. 패치 전엔 미지원 주석이 섞여 불일치 → FAIL, 패치 후 `_print_Indexed`가 `p[0, 1]`을 정확히 생성 → PASS.
- **픽스 증명**: 다중 인덱스 `p[0, 1]`을 검증하므로 `args[1:]` 튜플을 `", ".join`으로 묶는 로직(단일 인덱스가 아닌 일반 케이스)이 실제로 운동. 단순 `p[0]`만 검증했다면 join 분기가 vacuous였을 텐데, 콤마 결합까지 확인.
- **overfit 관점**: FAIL_TO_PASS가 단언 1개로 얇아 보이나, 메서드가 본질적으로 일반화된 형태(인덱스 개수 무관, 각 인덱스 재귀 print)라 special-case 통과 여지가 거의 없다. `has-repro`이고 픽스가 구조적으로 유일해 overfit-risk 미표기.
- **regression 관점**: 순수 additive — 기존 노드들의 print 경로를 건드리지 않음. PASS_TO_PASS 7개(`test_MpmathPrinter`/`test_NumPyPrinter`/`test_SciPyPrinter`/`test_pycode_reserved_words`/`test_printmethod`/`test_codegen_ast_nodes`/`test_issue_14283`)는 모두 그대로 통과해야 하며, 새 메서드가 이들 dispatch에 끼어들 일이 없어 regression-trap 약함.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 `# Not supported in Python: # Indexed` 출력 → SymPy printer의 미지원 fallback 메시지임을 인지 → `pycode`가 사용하는 `PythonCodePrinter`(`sympy/printing/pycode.py`)로 직행. 이슈가 클래스·메서드명을 명시하므로 grep `_print_Not` 인접에 추가 지점 확정.
2. **픽스와 일반화 근거**: `Indexed`의 `args[0]`(base)·`args[1:]`(index 튜플) 구조에 맞춰 `_print_Indexed`를 추가. 각 index를 `self._print`로 재귀 출력하므로 인덱스가 심볼/표현식이어도, 개수가 1개든 N개든 올바른 `base[...]` subscript가 나온다 — 이게 `p[0]`만 처리하는 하드코딩이 아니라 올바른 일반화인 이유.
3. **regression 안전**: 새 메서드 부착은 기존 `_print_*` dispatch와 직교. PASS_TO_PASS의 다른 프린터(Mpmath/NumPy/SciPy)·예약어·printmethod·AST 노드 테스트는 `Indexed` 경로를 타지 않으므로 영향 없음. base를 `self._print` 대신 `str(base)`로 둔 골드 선택도 base가 `IndexedBase` 심볼명이라 안전.
4. **함정 회피**: (a) 인덱스를 `self._print`로 재귀하지 않고 `str(ind)`로 끝내면 표현식 인덱스에서 부정확해진다 — 재귀 print가 정답. (b) 단일 인덱스만 가정해 `args[1]`로 접근하면 다중 인덱스(`p[0,1]`)에서 깨짐 — 슬라이스+join이 필수(테스트가 정확히 이걸 찌름). (c) `NumPyPrinter` 등 하위 클래스에도 별도 오버라이드를 넣고 싶은 유혹이 있으나 상속으로 충분하고 골드는 기본 클래스 한 곳만 손댔다 — scope를 넓히지 말 것.
