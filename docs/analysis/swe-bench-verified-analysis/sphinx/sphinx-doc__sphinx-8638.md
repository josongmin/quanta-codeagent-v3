---
instance_id: sphinx-doc__sphinx-8638
repo: sphinx-doc/sphinx
base_commit: 4b452338f914d4f6b54704222d70ae8a746e3db5
version: "4.0"
difficulty: "15 min - 1 hour"
created_at: 2021-01-01T13:54:38Z
fail_to_pass: 1
pass_to_pass: 34
gold_files: [sphinx/domains/python.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L2
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, underspecified, cross-file-dep]
---

## 문제 요약
autodoc/apidoc로 클래스의 인스턴스 변수(`:ivar:`/`:var:`/`:cvar:`)를 문서화하면, 그 변수 *이름*이 프로젝트 내 동명의 다른 객체(전역 변수, 다른 클래스의 동명 변수 등)로 자동 하이퍼링크된다. 예: `subA::Foo.limit`이 무관한 `subB::Bar.limit`로 링크됨. 변수명이 같다는 이유만으로 의미상 무관한 심볼끼리 cross-reference가 걸리는 것은 비합리적이며, 변수 이름 자체는 링크 대상이 되어서는 안 된다.

## 유형 (정형화)
- **L = L2 (Diffuse)**: 이슈 본문은 증상(부정확한 autolink)만 묘사하고 파일/심볼을 전혀 지목하지 않는다. "변수 필드 이름이 왜 xref가 되는가"를 알려면 `:var:` 디렉티브 → `py` 도메인의 `doc_field_types` → `PyTypedField`의 `rolename` 인자 → `make_xref`가 필드 *이름*에 role을 부착하는 데이터플로우를 역추적해야 한다. grep 한 방으로 안 나옴.
- **S = S2 Constraint-Reasoning (+S5)**: 고칠 한 줄(`rolename='obj'`)을 찾았어도, "타입(`vartype`)은 xref로 남기되 변수 *이름*만 링크를 끊는다"는 올바른 불변식을 추론해야 한다. 의도된 스펙("변수 이름은 정의이지 참조가 아니다")은 코드만으론 안 나오고 이슈 본문에서 재구성(S5)된다.
- **K = K-Domain**: sphinx `py` 도메인의 docfield/xref 머신러리(`PyTypedField`, `rolename` vs `typerolename`, `make_xref`)를 알아야 한다. 일반 파이썬 추론으로는 못 푼다.
- **primary = T-DomainBound**: 병목이 "어디인지 찾기"보다 sphinx 내부 docfield 모델 이해에 있다. `rolename`이 필드 라벨(변수명)을, `typerolename`이 타입을 각각 xref화한다는 도메인 지식이 핵심.

## 난이도 티어
**T4 (약간 어려움)**. 구조적 피처: 골드패치는 **1파일·실질 1줄**(`rolename='obj'` 인자 삭제)로 매우 작지만, 티어를 끌어올리는 것은 patch scope가 아니라 **L2 localize 난이도 + K-Domain + regression-trap**이다. (1) 이슈에 repro 링크는 있으나 외부 레포·브라우저 확인이라 네이티브 스택트레이스가 없음(has-repro 신호 약함). (2) `rolename`을 지우되 같은 라인의 `typerolename='class'`/`typenames=('vartype',)`는 **건드리면 안 된다** — 타입 링크는 정상 동작이라 P2P(`test_info_field_list` 등 34개)가 깨진다. 공식 라벨 "15분-1시간"은 *수정 자체*는 사소하다는 뜻이라 prior와 정합하지만, 에이전트 관점의 localize·과잉수정 위험을 반영해 T4로 둔다.

## 골드패치 분석
- **파일·심볼**: `sphinx/domains/python.py`, `PyObject.doc_field_types` 리스트의 `'variable'` 항목(`PyTypedField`).
- **근본원인**: `PyTypedField('variable', label=_('Variables'), rolename='obj', names=('var','ivar','cvar'), typerolename='class', typenames=('vartype',), ...)`에서 `rolename='obj'`가 지정돼 있었다. `TypedField`/`PyXrefMixin.make_xref`는 `rolename`이 있으면 **필드 항목 이름(=변수명)** 을 해당 role의 cross-reference로 만든다. 그래서 `:var int attr:`의 `attr`가 프로젝트의 임의 `obj`(동명 전역/타 클래스 변수)로 xref되어 부정확한 autolink가 발생했다.
- **수정요지**: `rolename='obj'` 인자를 제거. 변수 *이름*은 더 이상 어떤 role도 부착받지 않아 plain `literal_strong` 텍스트로 렌더된다. `typerolename='class'`/`typenames`는 유지되므로 변수 *타입*(`int`)은 여전히 `class` xref로 정상 링크된다.

## 검증 (test_patch)
FAIL_TO_PASS = `tests/test_domain_py.py::test_info_field_list_var` 1개. 입력 `.. py:class:: Class` + `:var int attr: blah blah`를 파싱해 노드 트리를 단언한다. 핵심:
- 변수 이름은 `[addnodes.literal_strong, "attr"]` — **pending_xref가 아님**(링크 끊김 증명).
- 변수 타입은 `[pending_xref, addnodes.literal_emphasis, "int"]`이며 `refdomain="py", reftype="class", reftarget="int"` — **타입 링크는 유지**됨을 명시.
즉 단일 테스트지만 "이름은 비링크, 타입은 링크"라는 두 불변식을 동시에 못박아 단순 삭제 overfit을 막는다. **overfit 관점**: 변수명을 통째로 plain text화하는 더 거친 수정(예: `vartype` xref까지 죽임)은 이 테스트의 `pending_xref` 단언에서 즉시 fail. **regression 관점**: `test_info_field_list`(파라미터/예외 필드) 등 34개 P2P가 다른 필드의 xref 동작을 보존하라고 강제 — `param`/`type`/`raises` role은 영향받지 않아야 한다.

## 모범답안 (오라클 기반)
1. **localize**: 증상은 "변수명이 무관한 동명 심볼로 링크". 신호 = `:ivar:/:var:/:cvar:` info-field. `grep -rn "'var', 'ivar', 'cvar'"` → `sphinx/domains/python.py`의 `PyObject.doc_field_types` `'variable'` 엔트리로 수렴. 거기서 `rolename='obj'`가 필드 이름을 xref화하는 유일한 원인임을 `PyTypedField`/`make_xref` 계약으로 확인.
2. **픽스**: `rolename='obj'` 삭제. 이게 올바른 일반화인 이유 — 변수 *이름*은 정의(declaration)이지 참조(reference)가 아니므로 어떤 role로도 resolve돼선 안 된다. 반면 변수 *타입*은 실제 참조라 `typerolename`은 보존. 즉 "이름/타입을 분리해 이름만 링크 차단"이 special-case가 아니라 docfield 의미론에 부합하는 일반 규칙.
3. **regression 안전**: `param`/`parameter`/`type`/`paramtype`(Parameters), `raises`(exceptions), `vartype`(타입) 링크가 그대로여야 함 — `test_info_field_list`·`test_pyattribute`·`test_resolve_xref_for_properties` 등 34 P2P가 이를 강제. 같은 라인의 `typerolename`/`typenames`/`can_collapse`/`names`/`label`은 절대 건드리지 않는다.
4. **함정 회피**: 오라클 없는 에이전트가 빠질 함정 — (a) `make_xref`/`PyXrefMixin`이나 도메인 `resolve_xref`의 휴리스틱을 고치려는 과잉 시도(원인은 role *부착*이지 resolve 로직이 아님), (b) `rolename`과 `typerolename`을 혼동해 타입 링크까지 죽이기, (c) 변수명을 전역적으로 비링크화하려고 `make_xrefs`를 패치(범위 과대). 정답은 데이터의 발생원인 한 인자를 끄는 것이며, 테스트의 `int→pending_xref` 단언이 이 경계를 강제한다.
