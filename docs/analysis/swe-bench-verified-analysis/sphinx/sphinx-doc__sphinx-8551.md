---
instance_id: sphinx-doc__sphinx-8551
repo: sphinx-doc/sphinx
base_commit: 57ed10c68057c96491acbd3e62254ccfaf9e3861
version: "3.4"
difficulty: "15 min - 1 hour"
created_at: 2020-12-19T09:34:31Z
fail_to_pass: 1
pass_to_pass: 32
gold_files: [sphinx/domains/python.py, sphinx/util/docfields.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L3
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

## 문제 요약
`:type:`/`:rtype:`/`:param:` 같은 info field가 만드는 암묵적 xref는 명시적 `:py:class:` role과 달리 unqualified 이름(`A`)을 현재 모듈/클래스 컨텍스트 기준으로 좁히지 못한다. 그 결과 모든 (sub)module을 전역 탐색해 "more than one target found for cross-reference 'A'" 모호성 경고를 내거나, 컨텍스트와 무관하게 엉뚱한 대상(`mod.submod` 스코프인데 `mod.A`)으로 silently 잘못 해석한다. 기대 동작은 명시 role과 동일하게 현재 모듈→부모 모듈 순으로 탐색해 경고 없이 `mod.submod.A`로 resolve.

## 유형 (정형화)
- **L = L3 (Multi-site)**: 픽스가 `python.py`(xref 노드에 컨텍스트 부착)와 `docfields.py`(그 컨텍스트의 출처인 `env`를 전달) 두 파일에서 **조율되어** 일어나야 동작한다. 한쪽만 고치면 무의미(`make_xref`에 `env`가 안 들어오면 None).
- **S = S2 (Constraint-Reasoning) + S5 (Spec-Inference)**: 정확한 픽스 식은 "명시 role이 이미 하는 것과 같은 불변식"(노드에 `py:module`/`py:class`를 심어 `searchmode`/`refspecific` 탐색이 스코프를 좁히게)을 추론해 합성하는 것. 의도된 동작은 코드만으로 결정되지 않고 명시 role 경로(python.py:1033-1034)를 스펙으로 삼아 재구성해야 한다.
- **K = K-Domain**: docutils 노드 트리, sphinx Python domain의 `ref_context`, `pending_xref` 해석 파이프라인(`resolve_xref`의 `node.get('py:module')` 의존)을 알아야만 픽스가 가능. 일반 파이썬 추론으로는 도달 불가.
- **primary = T-DomainBound**: 병목이 "프레임워크 내부에서 명시 xref가 컨텍스트를 어떻게 운반하는가"라는 도메인 지식. localize 자체도 cross-file라 어렵지만, 올바른 픽스를 짜는 결정 요인은 sphinx domain 내부 계약 지식이다.

## 난이도 티어
**T4 (약간 어려움)**. 구조적 피처: (1) 파일 2개 + 함수 2개, 총 +3줄의 작은 패치지만 L3 조율이 본질이라 "1파일 <5줄" 쉬움 컷에 안 들어감. (2) `has-repro`(이슈에 완전한 rst 재현 + 정확한 경고 문구)는 easiness 신호지만, 재현이 가리키는 곳은 증상(경고 출력)일 뿐 근본 결함 위치(`make_xref`가 `env`를 못 받음)와 직접 연결되지 않아 localize에 도메인 추적이 필요. (3) `regression-trap`: PASS_TO_PASS 32개가 같은 도메인(`test_domain_py`)이라 xref 해석 변경이 인접 동작을 깰 위험. (4) 깊은 도메인 지식 의존. 공식 라벨 "15min-1h"(개발자 구현시간)와 대체로 일치 — 정답을 알면 +3줄이지만, 그 +3줄을 도출하려면 명시 role 경로를 역추적해야 해서 에이전트 관점에선 T4가 타당.

## 골드패치 분석
- **건드린 파일·함수**: `sphinx/domains/python.py`의 `PyXrefMixin.make_xref`, `sphinx/util/docfields.py`의 `DocFieldTransformer.transform`(내부 `make_xref(s)` 호출부).
- **근본원인**: info field용 xref는 `PyXrefMixin.make_xref`로 생성되며 결과 노드에 `refspecific=True`만 달았다. 그러나 `PythonDomain.resolve_xref`는 탐색 스코프를 `node.get('py:module')`/`node.get('py:class')`에서 읽는다(python.py:1295-1296). 명시 `:py:class:` role 경로는 `refnode['py:module']`/`['py:class']`를 채워 넣지만(python.py:1033-1034), info field 경로는 이를 채우지 않았고, 게다가 호출처(`docfields.transform`)가 `make_xref`에 `env`조차 넘기지 않아 채울 방법이 원천 차단돼 있었다 → 전역 탐색으로 모호성.
- **수정요지**: `make_xref`에서 `result['py:module'] = env.ref_context.get('py:module')`, `result['py:class'] = env.ref_context.get('py:class')`를 추가해 명시 role과 동일한 컨텍스트를 노드에 부착. 이를 위해 `docfields.transform`이 `env=self.directive.state.document.settings.env`를 `make_xref` 호출에 전달하도록 배선. 두 변경이 짝(payload + 그 payload의 source)을 이룬다.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `tests/test_domain_py.py::test_info_field_list` 신설. `.. py:module:: example` + `.. py:class:: Class` 컨텍스트에서 `:param str name:`/`:type age: int`가 만드는 `pending_xref` 노드가 `**{"py:module": "example", "py:class": "Class"}`를 갖는지 `assert_node`로 직접 검증. 즉 노드에 컨텍스트가 실제로 박혔는지를 본다(증상이 아닌 메커니즘 단언).
- **픽스 증명**: 패치 전에는 그 두 속성이 없어 단언 실패. 패치 후 `make_xref`가 `env.ref_context`에서 값을 복사하므로 `example`/`Class`가 채워져 통과. 노드 속성을 직접 보므로 "경고가 안 났다" 류의 우회 통과가 불가능.
- **overfit/regression 관점**: FAIL_TO_PASS가 1개라 `overfit-risk`는 형식상 존재하나, 테스트가 노드 속성 자체를 단언해 special-case 통과 여지가 작다. 더 큰 위험은 regression — 32개 PASS_TO_PASS(annotation/signature/index 등)가 같은 domain이라, 컨텍스트 부착이 기존 resolve 동작을 바꾸지 않음을 보장해야 한다. 명시 role이 이미 하는 것과 byte-동일한 키를 심을 뿐이라 안전.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈 신호 "info field xref가 explicit role과 다르게 동작"을 단서로, explicit `:py:class:`가 컨텍스트를 어떻게 운반하는지부터 본다 → `PythonDomain.resolve_xref`가 `node.get('py:module')`/`'py:class'`로 스코프를 좁히고(python.py:1295), 명시 경로는 python.py:1033-1034에서 이를 채움을 확인. 그다음 info field 경로 `PyXrefMixin.make_xref`(python.py:272)가 `refspecific`만 달고 두 키를 안 채움을 발견. 호출처 `docfields.transform`이 `env`를 안 넘기는 것까지 역추적해야 cross-file 짝이 완성된다.
2. **픽스와 일반화**: 명시 role이 이미 쓰는 동일한 키(`py:module`/`py:class`)를 info field 노드에도 심는다. 이는 special-case 하드코딩이 아니라 "두 xref 경로가 같은 resolve 계약을 따른다"는 불변식을 복원하는 올바른 일반화 — `:type:`/`:rtype:`/`:param:` 전부에 동일 효과.
3. **regression 안전**: PASS_TO_PASS의 signature/annotation/index 테스트는 resolve 스코프 자체를 안 건드린다. 추가 키는 explicit role이 이미 심던 것과 동일하므로 기존 통과 경로의 동작이 불변. `env`가 None일 수 있는 경로는 `.get`이라 안전.
4. **함정 회피**: 오라클 없는 에이전트가 흔히 빠질 함정 — (a) `python.py` 한 파일만 고쳐 `make_xref`에 키를 넣지만 `docfields`가 `env`를 안 넘겨 항상 None이 되는 dead-fix. (b) 증상(경고)만 보고 warning 억제 로직을 손대는 잘못된 localize. (c) `resolve_xref`/`find_obj`의 탐색 알고리즘을 새로 짜려는 과잉수정. 올바른 길은 "explicit role 경로를 스펙으로 미러링"이며, 두 파일을 짝으로 고쳐 컨텍스트 출처(`env`)와 부착(노드 키)을 동시에 잇는 것.
