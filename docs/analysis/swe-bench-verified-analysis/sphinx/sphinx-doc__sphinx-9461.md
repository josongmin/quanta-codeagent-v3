---
instance_id: sphinx-doc__sphinx-9461
repo: sphinx-doc/sphinx
base_commit: 939c7bb7ff7c53a4d27df067cea637540f0e1dad
version: "4.2"
difficulty: "1-4 hours"
created_at: "2021-07-17T06:31:58Z"
fail_to_pass: 3
pass_to_pass: 59
gold_files: [sphinx/domains/python.py, sphinx/ext/autodoc/__init__.py, sphinx/util/inspect.py]
primary_type: T-DomainBound
tier: T5
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

## 문제 요약
Python 3.9부터 `@classmethod`와 `@property`를 중첩해 class-property를 쓸 수 있는데, Sphinx autodoc이 이런 멤버를 전혀 문서화하지 못한다. 근본 원인은 `type(Cls.classmethod_property)`가 `property`가 아니라 wrapped 함수가 반환하는 객체 타입을 돌려줘서, 일반 property처럼 `member.__doc__` 룩업이 안 먹히는 것이다. autodoc의 멤버 판별·docstring 추출·디렉티브 prefix 출력 세 군데가 모두 일반 property만 가정하고 있어서 동시에 손봐야 한다.

## 유형 (정형화)
- **L (Localization): L3** — 이슈가 "property가 안 잡힌다"는 증상만 주지 심볼을 직접 지목하지 않는다. 그리고 실제 수정은 `python.py`(디렉티브 prefix), `autodoc/__init__.py`(Documenter 판별/import), `util/inspect.py`(isclassmethod/getdoc) **3파일이 함께** 바뀌어야 동작한다. 멀티사이트 조율이 본질.
- **S (Strategy): S2 (+S6)** — 고칠 지점을 안 뒤에도, classmethod-wrapped-property를 어떻게 식별하고(`isinstance(obj, classmethod) and inspect.isproperty(obj.__func__)`) docstring을 어디서 끌어올지 불변식을 추론해 합성해야 한다(S2). 동시에 `PropertyDocumenter.import_object` 오버라이드 신설, `isclassmethod`/`getdoc` 시그니처에 `cls,name` 파라미터 도입 같은 소규모 구조 변경이 따라온다(S6).
- **K (Knowledge): K-Domain** — autodoc Documenter 계약(`can_document_member`/`import_object`/`add_directive_header`), descriptor 프로토콜, MRO 기반 docstring 상속까지 Sphinx+CPython 내부지식이 병목.
- **primary_type: T-DomainBound** — 픽스 자체 줄수는 적으나, "왜 안 잡히는가"가 descriptor/classmethod 내부동작 이해에 달려 있고 그 지식이 4개 함수 변경 전체를 좌우한다.

## 난이도 티어
**T5 (어려움)**. 공식 라벨 "1-4 hours"와 일치하는 방향. 구조적 피처: gold가 **3파일·4함수**에 걸친 조율된 변경(L3)이고, descriptor 도메인지식이 필수(K-Domain). `has-repro`(데모 레포 + 정확한 원인 분석)는 easiness 신호지만, 수정 산포(domains+autodoc+util)와 시그니처 확장이 이를 상쇄한다. PASS_TO_PASS 60개 중 `test_pyproperty`·`test_pyattribute`·`test_pyclassmethod` 등 인접 디렉티브 동작이 많아 prefix 로직을 잘못 건드리면 회귀가 광범위(regression-trap). 단순 가드 한 줄이 아니라 식별→import→prefix→docstring 4단계 파이프라인을 일관되게 맞춰야 하므로 T4가 아닌 T5.

## 골드패치 분석
건드린 파일·함수:
- `sphinx/domains/python.py` — `PyProperty.option_spec`에 `'classmethod': directives.flag` 추가, `get_signature_prefix`를 `['property']` 하드코딩에서 `abstractmethod`/`classmethod` 옵션에 따라 `'abstract'`/`'class'`를 앞에 붙여 조립하도록 변경 → `"class property "` prefix 출력.
- `sphinx/ext/autodoc/__init__.py` — `PropertyDocumenter.can_document_member`가 일반 property 외에 `parent.__dict__`에서 `isinstance(obj, classmethod) and inspect.isproperty(obj.__func__)`인 경우도 수용. 신설된 `import_object`는 import 후 `self.object`가 property가 아니면 classmethod-wrapped property인지 확인해 `self.object = obj.__func__`로 교체하고 `self.isclassmethod = True` 설정. `add_directive_header`는 `isclassmethod`면 `:classmethod:` 라인 출력. 또한 `Documenter` 쪽 `getdoc` 호출 인자를 `self.parent, self.object_name` → `self.object, membername`으로 교정.
- `sphinx/util/inspect.py` — `isclassmethod(obj, cls=None, name=None)`에 MRO를 순회하며 `basecls.__dict__[name]`을 재검사하는 분기 추가. `getdoc`은 `cls and name and isclassmethod(...)`이면 MRO를 따라 `meth.__func__`의 docstring을 끌어오도록 확장.

근본원인: classmethod-wrapped property는 `type()`이 property를 반환하지 않아 기존 property 판별·`__doc__` 룩업 경로를 전부 우회한다. 수정요지: 판별을 `__dict__` 기반 raw descriptor 검사로 바꾸고, docstring은 `__func__`에서, prefix는 옵션 조립으로 처리.

## 검증 (test_patch)
FAIL_TO_PASS 3개:
- `test_pyproperty` — `:classmethod:` 옵션을 가진 `py:property`가 `"class property "` annotation으로 렌더되고 도메인 객체로 등록되는지.
- `test_ext_autodoc_autoclass.py::test_properties` / `test_ext_autodoc_autoproperty.py::test_class_properties` — `target/properties.py`에 추가된 `prop2`(`@classmethod @property`)가 `:classmethod:` 옵션과 docstring과 함께 autodoc 출력되는지.

테스트 픽스처가 `prop` 하나에서 `prop1`(일반) + `prop2`(classmethod-property)로 확장되어, 일반 property 회귀와 신규 동작을 같은 테스트에서 동시에 검증한다. pinpoint된 prefix 문자열/옵션/docstring을 모두 단언하므로 overfit-risk는 낮음 — special-case 하드코딩으로는 `:classmethod:` prefix와 `__func__` docstring을 동시에 못 통과한다. 다만 Python 3.9+에서만 의미 있는 동작이라(이슈 EDIT2 참조) 환경 의존이 있다. regression 관점에선 60개 P2P(특히 `test_pyproperty` 변형 전 동작·다른 디렉티브 prefix)가 보호막.

## 모범답안 (오라클 기반)
1. **localize**: "property가 안 잡힌다"는 증상 + 이슈의 정확한 원인 분석("`type()`이 property를 안 돌려준다")에서 출발 → property 판별 지점인 `PropertyDocumenter.can_document_member`를 찾고, 거기서부터 import(`import_object`)·docstring(`util/inspect.getdoc`)·렌더(`PyProperty.get_signature_prefix`)로 데이터플로우를 거슬러 4개 사이트를 모두 식별.
2. **픽스와 일반화**: 핵심 불변식은 "classmethod로 감싼 property는 `parent.__dict__`의 raw descriptor가 `classmethod`이고 그 `__func__`가 property"이다. 이 검사로 식별하고 `self.object`를 `__func__`로 교체하면 이후 abstractmethod/typehints 등 기존 property 경로가 그대로 재사용된다 — 한 멤버에 대한 특수처리가 아니라 descriptor 구조에 기반한 일반 규칙이라 올바른 일반화.
3. **regression 안전**: `get_signature_prefix`를 `['property']` 고정에서 조립식으로 바꾸되 옵션 없으면 결과가 `"property "`로 동일해야 `test_pyattribute`/일반 property 케이스가 안 깨진다. `isclassmethod`/`getdoc`의 새 파라미터는 기본값 `None`으로 둬 기존 호출부 60개 P2P를 그대로 통과시켜야 한다.
4. **함정 회피**: (a) prefix를 `class property` 순서로 조립하지 않고 `property class`로 두면 단언 실패 — `'abstract'`/`'class'`를 앞에, `'property'`를 끝에 붙이는 순서 준수. (b) `can_document_member`만 고치고 `import_object`를 안 만들면 멤버는 잡히나 `self.object`가 여전히 wrapper라 docstring·typehint가 비어 부분적으로만 통과한다 — 4사이트를 함께 손봐야 함. (c) docstring을 `self.parent, self.object_name`로 끌면 잘못된 컨텍스트라 `self.object, membername`으로 교정해야 MRO 상속 docstring이 올바르게 해석된다.
