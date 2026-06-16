---
instance_id: sphinx-doc__sphinx-7748
repo: sphinx-doc/sphinx
base_commit: 9988d5ce267bf0df4791770b469431b1fb00dcdd
version: "3.1"
difficulty: "15 min - 1 hour"
created_at: 2020-05-30T06:41:07Z
fail_to_pass: 2
pass_to_pass: 12
gold_files: [sphinx/ext/autodoc/__init__.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain
flags: [regression-trap, underspecified]
---

## 문제 요약
SWIG로 래핑한 C++ 클래스처럼 오버로드된 메서드는 docstring 첫머리에 여러 시그니처를 나란히 적는 관례를 쓴다. 그러나 `autodoc_docstring_signature` 기능은 docstring의 **첫 줄 시그니처 하나만** 집어내고 나머지 오버로드 시그니처는 버린다. 모든 시그니처를 수집해 함께 렌더링하길 원하는 기능 요청이다.

## 유형 (정형화)
- **L (Localization) = L1**: 이슈가 `autodoc_docstring_signature` 기능명을 직접 지목하므로 `sphinx/ext/autodoc/__init__.py`의 `DocstringSignatureMixin._find_signature`로 바로 수렴한다. 단일 파일·단일 메서드지만 "기능명→내부 메서드" 1단계 매핑이 필요해 L0는 아니다.
- **S (Repair Strategy) = S6 (+S5)**: 한 줄 가드가 아니라 루프 구조 변경이 본질이다. 기존엔 `docstrings[i][0]` 한 줄만 보고 첫 매치에서 `break`했는데, 이를 **각 docstring 내부 줄을 순회**하며 여러 시그니처를 누적(`self._signatures`)하고 줄 끝 `\\` 연속행 처리(`multiline`)까지 더하는 collect-then-render 리팩터(S6)다. "여러 시그니처를 어떻게 표현/조인할지"는 코드만으론 안 정해지고 Sphinx 도메인 관례에서 스펙을 재구성해야 해 S5 보조.
- **K (Knowledge) = K-Domain**: autodoc Documenter 라이프사이클(`get_doc`/`format_signature`/`_new_docstrings` 캐시), `py_ext_sig_re` 정규식, `prepare_docstring`, `ClassDocumenter`의 `__mro__`/`__init__` 후보 처리 등 autodoc 내부 지식이 병목이다.
- **primary_type = T-DomainBound**: 위치는 쉽게 잡히고(L1) 픽스도 멀티사이트가 아니지만, 올바른 동작을 짜려면 autodoc 시그니처 추출/렌더 파이프라인 지식이 결정적이라 도메인 바운드가 dominant.

## 난이도 티어
**T4 (약간 어려움)**. 구조적 피처: 파일 1개·함수 3~4개(`_find_signature`/`get_doc`/`format_signature` + `FunctionDocumenter.format_signature`의 singledispatch 루프), 변경 ~40줄로 소규모 refactor(S6)다. localize는 직접적(L1)이고 has-repro는 아니지만 이슈가 명확해 underspecified는 약하다. T4로 미는 핵심은 (1) 단순 픽스가 아닌 루프 재구조화 + multiline 연속행 + 시그니처 누적이라는 **조율된 변경**, (2) K-Domain 의존, (3) `_new_docstrings`를 클래스 속성으로 승격하면서 `get_doc`의 `getattr` 폴백을 깨면 안 되는 **regression-trap**이다. 공식 라벨("15분~1시간")과 일치 — 개발자에겐 짧지만 오라클 없는 에이전트에겐 정확한 출력 포맷(조인 형태) 추론이 함정.

## 골드패치 분석
- **건드린 파일·함수**: `sphinx/ext/autodoc/__init__.py` — `DocstringSignatureMixin` (`_find_signature`, `get_doc`, `format_signature`), 그리고 `FunctionDocumenter.format_signature`(singledispatch 등록함수 루프 포함). base 9988d5ce 소스에서 `documenter.objpath = [None]`이 들어가는 `format_signature`는 `FunctionDocumenter`에 정의돼 있고, `SingledispatchFunctionDocumenter`는 'Retained for backwards compatibility, now does the same as the FunctionDocumenter' docstring만 가진 빈 deprecated 서브클래스로 `format_signature`를 오버라이드하지 않는다.
- **근본원인**: `_find_signature`가 각 docstring의 **첫 줄(`doclines[0]`)만** 정규식 매칭하고 첫 매치 즉시 `break`해, 오버로드된 추가 시그니처를 구조적으로 버렸다.
- **수정요지**:
  1. 클래스 속성 `_new_docstrings = None`, `_signatures = None` 도입. `valid_names` 계산을 루프 밖으로 호이스트.
  2. `_find_signature`를 docstring별 **내부 줄 순회**(`for j, line in enumerate(doclines)`)로 바꿔, 매치마다 `result`(첫 시그니처) 또는 `self._signatures`(후속)에 누적. 빈 줄이면 `break`.
  3. 줄 끝 `\\`(백슬래시)면 `multiline=True`로 보고 다음 줄도 계속 매칭(여러 시그니처 허용), 아니면 `break`.
  4. `format_signature`가 `self._signatures`가 있으면 `"\n".join([sig] + self._signatures)`로 여러 줄 시그니처를 렌더.
  5. `FunctionDocumenter.format_signature`(singledispatch 등록함수 루프)에서 임시 `FunctionDocumenter(self.directive, '')`에 `documenter.objpath = [None]`을 세팅 — 이 임시 documenter는 `resolve_name`을 거치지 않아 `self.objpath`가 클래스 기본값 `None`(빈 리스트 아님)이라, 그냥 두면 `_find_signature`가 무조건 실행하는 `valid_names = [self.objpath[-1]]`에서 `None[-1]` → `TypeError: 'NoneType' object is not subscriptable`로 깨진다. (이게 이제 터지는 이유: 패치가 `valid_names` 계산을 정규식 매치 이후 조건부 위치에서 `_find_signature` 최상단 무조건 실행으로 호이스트했기 때문.)

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**: `test_autoclass_content_and_docstring_signature_init`, `..._both`. 새 fixture 클래스 `E`의 `__init__` docstring이 `E(...) -> None \` 연속행 + `E(...) -> None` 두 시그니처를 담고, 기대 출력은 `.. py:class:: E(foo: int, ...) -> None` 줄과 들여쓰기 정렬된 둘째 `E(foo: str, ...) -> None` 줄이 함께 나오는 것이다. multiline 누적 + join이 정확히 이 출력을 만든다.
- **픽스 증명**: 패치 전엔 `E`의 첫 시그니처만 잡혀 둘째 줄이 누락되므로 두 테스트가 RED. 패치 후 `_signatures` 누적과 `format_signature` join으로 GREEN.
- **overfit·regression 관점**: 단일 fixture지만 `\\` 연속행 + 비연속 멀티시그니처 양쪽 경로를 커버. `..._class` 테스트(PASS_TO_PASS)는 `E()` 단일 출력을 기대 — 클래스 content 모드에선 시그니처 누적이 안 새는지 확인. 기존 `test_autodoc_docstring_signature` 등 12개 P2P가 단일 시그니처/`get_doc` 캐시 폴백 회귀를 잡는다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 `autodoc_docstring_signature` 키워드 → `sphinx/ext/autodoc` grep → `DocstringSignatureMixin._find_signature`. 첫 매치에서 `break`하고 `doclines[0]`만 보는 단일-시그니처 가정을 즉시 발견.
2. **픽스와 일반화**: 첫-줄-한-개 가정을 깨고 docstring 내부 줄을 순회해 시그니처를 누적하는 게 올바른 일반화. 첫 시그니처는 `result`로 기존 `self.args/retann` 경로를 보존하고 나머지는 `self._signatures`로 모아 `format_signature`에서 join — 이는 기존 단일-시그니처 동작을 그대로 superset으로 감싸므로 overfit이 아니다. 줄 끝 `\\` 처리는 SWIG/Qt 관례를 흡수하는 도메인 정당화 — 단, `\\`는 '한 시그니처를 여러 줄로 잇는' 연속행 마커가 아니다. 각 줄이 그 자체로 완결된 별개 시그니처이고, 끝의 `\\`는 '뒤에 시그니처가 더 있으니 계속 읽으라'는 신호다(패치: 매치 성공 후 `if multiline: continue` 로 같은 docstring의 다음 줄을 또 다른 시그니처로 매칭, 아니면 `break`).
3. **regression 안전**: `_new_docstrings`를 인스턴스 동적 속성에서 클래스 기본값 `None`으로 승격하되 `get_doc`의 의미를 유지(있으면 가공본, 없으면 `super().get_doc`)해야 `test_autodoc_docstring_signature`/`test_autodoc_inherit_docstrings`가 안 깨진다. `FunctionDocumenter.format_signature`의 singledispatch 루프에서 임시 `FunctionDocumenter(self.directive, '')`에 `objpath = [None]`을 안 넣으면, 이 documenter는 `resolve_name`을 거치지 않아 `objpath`가 기본값 `None`이라 `_find_signature`가 무조건 실행하는 `valid_names = [self.objpath[-1]]`에서 `None[-1]` → `TypeError: 'NoneType' object is not subscriptable`로 인접 동작이 깨진다(빈 리스트 IndexError가 아니다; `SingledispatchFunctionDocumenter`는 오버라이드 없는 빈 deprecated 서브클래스라 이 코드의 owner가 아니다).
4. **함정 회피**: 오라클 없는 에이전트는 (a) 멀티시그니처를 어떤 포맷으로 조인할지(`\n` join + 들여쓰기 정렬) 추론을 틀려 출력이 기대와 어긋나기 쉽고, (b) `\\` 연속행 케이스를 빠뜨려 `..._both` fixture만 부분 통과하며, (c) `_new_docstrings` 캐시/`get_doc` 폴백을 건드려 P2P 회귀를 낸다. 기대 출력 문자열(들여쓰기 포함)을 fixture에서 역산하고, 단일 시그니처 경로를 byte-identical하게 보존하는 것이 핵심.
