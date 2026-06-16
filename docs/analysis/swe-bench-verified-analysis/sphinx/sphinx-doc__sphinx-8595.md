---
instance_id: sphinx-doc__sphinx-8595
repo: sphinx-doc/sphinx
base_commit: b19bce971e82f2497d67fdacdeca8db08ae0ba56
version: "3.5"
difficulty: "<15 min fix"
created_at: 2020-12-27T03:07:50Z
fail_to_pass: 1
pass_to_pass: 0
gold_files: [sphinx/ext/autodoc/__init__.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, overfit-risk]
---

## 문제 요약
autodoc로 모듈을 문서화할 때, 모듈에 `__all__ = []`(빈 리스트)가 정의돼 있으면 이를 무시하고 모든 멤버(foo/bar/baz)를 문서화한다. 기대 동작은 "빈 `__all__`은 명시적으로 '아무것도 export하지 않음'을 의미하므로 어떤 멤버도 문서화하지 않는다"이다. 재현 코드(`__all__ = []` + 함수 3개 + `.. automodule:: :members:`)가 이슈에 포함돼 있다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 파일/함수를 직접 지목하진 않지만 키워드 `autodoc`+`__all__`+`:members:`로 `sphinx/ext/autodoc/__init__.py`의 `ModuleDocumenter.get_object_members`에 빠르게 수렴한다. grep `__all__`이면 `if not self.__all__` 분기가 즉시 드러남.
- **S2 (Constraint-Reasoning)**: 고칠 한 줄은 명확하나, 올바른 조건식을 "추론으로 합성"해야 한다. 핵심은 `None`(=`__all__` 미정의)과 `[]`(=빈 export 목록)를 falsy로 뭉뚱그리는 게 버그라는 점을 깨닫는 것. `not self.__all__` → `self.__all__ is None`으로 바꾸는 건 단순 치환이 아니라 3-상태(None/빈/비어있지않음) 불변식을 따져야 나온다.
- **K-Domain**: `self.__all__`의 세 가지 상태 의미(line 992 `self.__all__ = None` 초기화, `inspect.getall()`로 채워짐)와 autodoc의 implicit-member 분기 의미를 알아야 픽스가 안전하다. sphinx autodoc 내부 도메인 지식.
- **primary = T-ConstraintReason**: 위치는 쉽게 찾지만 진짜 난점은 "왜 `is None`이어야 하는가"를 None/empty 구분 불변식으로 추론하는 것. APR 관점에서 SemFix류의 조건식 합성(condition synthesis)에 해당하며, 템플릿 매칭(S1)으론 도출 안 됨 — falsy 가드는 흔한 안티패턴이라 오히려 잘못된 방향으로 유도되기 쉽다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 1파일·1줄(헌크 1개) 수정, has-repro 존재(가장 강한 easiness 신호), localize 직접성 높음(grep 한두 번). 다만 T1이 아닌 이유는 픽스가 "체크 추가/상수 변경" 같은 기계적 S1이 아니라 None vs `[]` 구분이라는 가벼운 엣지추론(S2)을 요구하기 때문 — 이슈가 픽스 코드를 적어주지 않는다. 공식 라벨 `<15 min fix`(개발자 구현시간)와 일치한다. P2P가 비어 있어 regression-trap은 없지만, 그래서 오히려 인접 동작(빈 `__all__` 외 케이스)을 안 깨는지는 에이전트 스스로 챙겨야 한다.

## 골드패치 분석
- **파일·함수**: `sphinx/ext/autodoc/__init__.py`의 `ModuleDocumenter.get_object_members(self, want_all)`.
- **근본원인**: `want_all`이 True일 때 `if not self.__all__:` 분기가 "implicit 멤버 처리(모듈 전체 문서화)"로 빠진다. `self.__all__`은 line 992에서 `None`으로 초기화되고 `__all__`이 모듈에 있으면 `inspect.getall()` 결과로 채워진다. 따라서 `None`=정의 안 됨, `[]`=명시적 빈 export인데, `not self.__all__`은 둘 다 falsy로 처리해 빈 리스트를 "미정의"와 동일 취급 → 모든 멤버를 문서화.
- **수정요지**: `if not self.__all__:` → `if self.__all__ is None:`. 이제 `None`일 때만 implicit-member 경로(전체 문서화)로 가고, `[]`이면 else 분기로 떨어져 모든 `member.skipped = True`가 되어(어떤 이름도 `[]`에 없으므로) 아무 멤버도 문서화되지 않는다.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `tests/test_ext_autodoc_automodule.py::test_empty_all` 1개. 신규 픽스처 `tests/roots/test-ext-autodoc/target/empty_all.py`(`__all__ = []` + foo/bar/baz)를 `do_autodoc(app, 'module', 'target.empty_all', {'members': True})`로 돌려, 출력이 모듈 헤더+docstring만 포함하고 함수 항목이 0개임을 정확히 단언(`assert list(actual) == [...]`).
- **픽스 증명**: 패치 전엔 else 분기를 안 타서 foo/bar/baz가 출력에 포함 → assert 실패. 패치 후 `[]`이 `is None`을 통과 못 하므로 else로 가 전부 skipped → 출력은 헤더+docstring뿐 → 통과.
- **overfit·regression 관점**: 테스트가 정확한 출력 리스트를 단언하므로 special-case 통과는 어렵다. 다만 FAIL_TO_PASS가 1개고 P2P가 0개라 "비어있지 않은 `__all__`", "`__all__` 미정의" 경로의 회귀를 이 테스트는 직접 막지 못한다 → `overfit-risk` 플래그. 단, `is None` 픽스는 None/non-empty 두 경로의 의미를 그대로 보존하므로 일반화로서 올바르다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈 신호 `autodoc` + `__all__` + `:members:` → `sphinx/ext/autodoc/__init__.py`에서 `grep __all__`. `ModuleDocumenter`의 `want_all` 분기 `if not self.__all__:`가 후보. line 992의 `self.__all__ = None` 초기화와 `inspect.getall()` 대입을 확인해 "None=미정의, 리스트=정의됨" 불변식을 파악.
2. **픽스**: `not self.__all__`이 `None`과 `[]`를 구분 못 하는 게 근본원인이라고 진단하고 `self.__all__ is None`으로 교체. 이게 올바른 일반화인 이유: 세 상태(None/빈/비어있지않음)를 정확히 분기 — None만 implicit 경로, `[]`/non-empty는 else에서 `__all__` 멤버십으로 필터. 빈 리스트는 자연스럽게 "전부 skip"으로 떨어진다(특수 분기 추가 불필요).
3. **regression 안전**: P2P가 비어 있어 명시적 가드는 없지만, non-empty `__all__`(특정 멤버만 문서화)과 `__all__` 미정의(전체 문서화) 동작이 픽스 전후 동일해야 한다. `is None`은 정확히 이 두 경로를 건드리지 않으므로 안전. 기존 `test_ext_autodoc`의 automodule 케이스들이 깨지지 않는지 확인.
4. **함정 회피**: 오라클 없는 에이전트가 빠질 함정 — (a) `not self.__all__`을 "빈 컨테이너 가드"로 오인해 그대로 두거나, 거꾸로 빈 케이스를 위한 별도 `if self.__all__ == []:` 특수 분기를 추가(과적합·복잡화). 올바른 답은 falsy를 `is None`으로 좁히는 최소 변경. (b) `get_module_members`(멤버 수집)를 건드려 수집 단계에서 거르려는 시도 — 이건 sort/skip 의미를 깨뜨림. 수정은 export 정책을 판단하는 `get_object_members`의 분기여야 한다.
