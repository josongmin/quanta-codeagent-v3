---
instance_id: sphinx-doc__sphinx-8548
repo: sphinx-doc/sphinx
base_commit: dd1615c59dc6fff633e27dbb3861f2d27e1fb976
version: "3.4"
difficulty: 1-4 hours
created_at: 2020-12-17T13:46:32Z
fail_to_pass: 1
pass_to_pass: 5
gold_files: [sphinx/ext/autodoc/__init__.py, sphinx/ext/autodoc/importer.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L2
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, underspecified]
---

## 문제 요약

autodoc의 `:inherited-members:` 옵션이 상속된 **인스턴스 속성**(예: `__init__` 안의 `self.attr1 = None  #: docstring`)에 대해 동작하지 않는다. 상속된 메서드와 클래스변수는 문서화되지만, 베이스클래스에서 정의된 인스턴스 속성의 주석 docstring은 누락된다. 이슈가 직접 진단하듯, autodoc은 캐시된 docstring을 `(namespace, attrname)` 키로 찾는데 이때 namespace를 **대상 클래스의 namespace로만** 잡고 베이스클래스 namespace를 검사하지 않는다.

## 유형 (정형화)

- **L = L2 (Diffuse).** 이슈 본문이 "`(namespace, attrname)` 키 검색"이라는 정확한 메커니즘을 짚어주지만, 그 키 조회가 실제로 일어나는 `importer.get_class_members`까지 도달하려면 autodoc 멤버수집 데이터플로우(`ClassDocumenter.get_object_members` → `get_class_members` → `ModuleAnalyzer.attr_docs`)를 따라가야 한다. grep 한 방이 아니라 cross-module 추적이 필요하다.
- **S = S2 (Constraint-Reasoning) +S6 (Design-Refactor).** 픽스는 "MRO를 돌며 각 베이스클래스의 모듈을 따로 분석하고 그 클래스의 `__qualname__`을 namespace로 매칭"이라는 올바른 불변식을 합성해야 한다(S2). 단순 가드 추가가 아니라, 단일 `analyzer`를 받던 흐름을 "클래스마다 analyzer를 새로 만드는" 루프 구조로 바꾸는 소규모 리팩터(S6)를 동반한다.
- **K = K-Domain.** `ModuleAnalyzer.for_module` / `attr_docs`의 키 형식이 `(qualname, attrname)`이라는 것, `getmro`, `unmangle`, `PycodeError`의 의미 등 sphinx autodoc/pycode 내부 지식이 병목이다.
- **primary = T-DomainBound.** 위치를 찾고 나서도 "왜 인스턴스 속성만 안 되는가"를 푸는 핵심은 sphinx의 docstring-클래스 강결합(comment docstring이 정의 클래스에 묶임) 도메인 지식이다. 이슈 코멘트에서 메인테이너조차 "comment based docstring is strongly coupled with its class"라고 진단한다.

## 난이도 티어

**T4 (약간 어려움).** 구조적 피처: gold가 2파일이지만 핵심 로직은 `importer.py` 한 함수에 집중(실질 single-site)되고, `__init__.py` 변경은 인자 1개 제거의 콜사이트 동기화일 뿐이다. localize는 L2로 직접 grep이 안 되고, 픽스는 단순 가드가 아니라 MRO 순회 + per-class analyzer 생성이라는 의미적 재배치를 요구한다. 도메인 지식(`attr_docs` 키 = qualname) 의존도가 높다. P2P 5개 중 `test_instance_variable`(상속 아닌 자기 인스턴스 속성)이 regression-trap이라 "베이스만 보던 것을 자기 클래스도 계속 잡게" 유지해야 한다. 공식 라벨 "1-4 hours"와 일치 — localize 노력 + 도메인 추론 + regression 동시 충족 때문에 T2/T3은 과소평가.

## 골드패치 분석

- **건드린 파일·함수:**
  - `sphinx/ext/autodoc/importer.py::get_class_members` — 본체. 시그니처에서 `analyzer: ModuleAnalyzer = None` 파라미터 제거.
  - `sphinx/ext/autodoc/__init__.py::ClassDocumenter.get_object_members` — 콜사이트에서 `self.analyzer` 인자 삭제.
  - import 추가: `from sphinx.pycode import ModuleAnalyzer, PycodeError`.
- **근본원인:** 기존 코드는 호출자가 넘긴 **단일 `analyzer`**(대상 클래스 모듈)를 쓰고, `namespace = '.'.join(objpath)`(즉 대상 클래스의 namespace)와 `attr_docs`의 `ns`가 정확히 일치할 때만 속성을 채웠다. 베이스클래스의 인스턴스 속성은 (a) 다른 모듈에 있을 수 있고 (b) `ns`가 베이스의 qualname이라 leaf namespace와 매칭되지 않아 항상 누락됐다.
- **수정요지:** annotation-only 멤버 수집과 인스턴스 속성 수집을 **`for cls in getmro(subject)` 루프 안으로** 옮긴다. 각 `cls`마다 `modname = cls.__module__`, `qualname = cls.__qualname__`로 `ModuleAnalyzer.for_module(modname).analyze()`를 새로 만들고, `attr_docs`를 `ns == qualname`로 매칭한다. 즉 namespace 키를 "leaf objpath" → "각 베이스의 qualname"으로 일반화했다. `(AttributeError, PycodeError)`를 클래스별로 삼켜 분석 불가 모듈도 건너뛴다.

## 검증 (test_patch)

- **신규 fixture:** `tests/roots/test-ext-autodoc/target/instance_variable.py` — `Foo.attr1/attr2`(베이스 인스턴스 속성), `Bar(Foo)`가 `attr2`(오버라이드)와 `attr3`를 가진다.
- **FAIL_TO_PASS = `test_inherited_instance_variable`:** `{'members': True, 'inherited-members': True}`로 `Bar`를 autodoc 했을 때 `attr1`(상속, docstring foo) + `attr2`(자기, docstring bar) + `attr3`(자기, docstring bar) 3개가 모두 나와야 한다. 픽스 전엔 `attr1`이 누락됐다. MRO 순회로 `Foo` 모듈도 분석해 `Foo.attr1`을 잡아내는 것이 정확히 이 동작을 증명한다.
- **overfit 관점:** FAIL_TO_PASS가 1개로 얇아 overfit 우려가 있으나, fixture가 "베이스 전용(attr1)/오버라이드(attr2)/자기 전용(attr3)"을 모두 커버해 special-case 통과를 막는다. P2P의 `test_instance_variable`(inherited 없는 케이스)이 "자기 클래스도 여전히 잡힘"을 paired-control로 보장.
- **regression 관점:** P2P `test_classes`, `test_slots_attribute`, `test_show_inheritance_for_subclass_of_generic_type`가 클래스변수/슬롯/제네릭 경로를 지킨다. MRO 루프가 `object` 등 분석 불가 클래스에서 던지는 `PycodeError`를 삼키지 않으면 회귀하므로 예외 처리가 필수.

## 모범답안 (오라클 기반)

1. **localize:** 이슈의 "cached docstring을 `(namespace, attrname)`로 찾는다"는 신호 → autodoc에서 attr docstring 캐시는 `ModuleAnalyzer.attr_docs`. 이를 소비하는 곳을 grep하면 `importer.get_class_members`의 `analyzer.attr_docs.items()` 루프에 수렴. 거기서 `namespace == ns` 비교가 leaf objpath만 본다는 것을 확인.
2. **픽스와 일반화 근거:** 잘못된 불변식은 "모든 인스턴스 속성이 대상 클래스 모듈·namespace에 있다". 올바른 불변식은 "각 속성은 그것을 **정의한** 클래스의 모듈·qualname에 산다". 따라서 `getmro(subject)`로 정의 클래스들을 순회하며 클래스별 analyzer를 만들고 `ns == qualname`로 매칭하는 것이 일반적 해법 — 메서드/클래스변수 상속이 이미 MRO로 동작하던 것과 대칭을 맞춘다. 특정 attr 이름 하드코딩이 아니므로 overfit이 아니다.
3. **regression 안전:** `inherited-members`가 꺼진 일반 케이스(`test_instance_variable`)에서 자기 클래스 속성은 그대로 잡혀야 하고(MRO 첫 원소가 자기 자신이라 보존됨), 클래스변수/슬롯 경로(`test_classes`/`test_slots_attribute`)는 건드리지 않아야 한다. `PycodeError`/`AttributeError`를 클래스별로 삼켜 `object`처럼 소스 분석 불가한 베이스에서 죽지 않게 한다.
4. **함정 회피:** 오라클 없는 에이전트는 (a) `analyzer`를 단일로 둔 채 namespace 비교만 느슨하게 풀어 모든 모듈의 동명 속성을 잘못 끌어오거나(과일반화), (b) `attr_docs` 키가 `objpath` join이 아니라 `__qualname__` 기반임을 모르고 잘못된 키로 매칭하거나, (c) per-class `ModuleAnalyzer.for_module` 생성 시 `PycodeError` 처리를 빠뜨려 `object`/C확장 베이스에서 회귀를 낸다. 정답 경로는 "정의 클래스의 모듈을 그 클래스 qualname으로 분석"이라는 도메인 사실을 잡는 것.
