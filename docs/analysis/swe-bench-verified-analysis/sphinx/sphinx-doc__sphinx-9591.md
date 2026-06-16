---
instance_id: sphinx-doc__sphinx-9591
repo: sphinx-doc/sphinx
base_commit: 9ed054279aeffd5b1d0642e2d24a8800389de29f
version: "4.2"
difficulty: "<15 min fix"
created_at: 2021-08-29T15:26:24Z
fail_to_pass: 1
pass_to_pass: 44
gold_files: [sphinx/domains/python.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S1 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약

`@property`의 반환 타입 어노테이션(`-> Point`)이 autodoc 문서에서 cross-reference(하이퍼링크)로 연결되지 않는다. 같은 클래스의 일반 속성(`start: Point`)은 정상적으로 링크되는데 property만 안 된다. 즉 동일 도메인 안에서 attribute와 property의 타입 렌더링이 비대칭적이며, property 쪽이 타입 문자열을 평문(plain text)으로만 출력한다.

## 유형 (정형화)

- **L (Localization) = L1**: 이슈가 "property의 type annotation"을 직접 지목한다. `sphinx/domains/python.py`의 `class PyProperty` → `handle_signature`로 grep 한두 방에 수렴. 같은 파일에 정상 동작하는 `PyAttribute.handle_signature`라는 직접 비교 대상이 존재해 후보가 좁다.
- **S (Repair Strategy) = S1 (+S5)**: 픽스 자체는 기계적이다 — 평문 `': ' + typ`을 `_parse_annotation(typ, self.env)`로 파싱한 노드로 교체. 이미 존재하는 도메인 헬퍼와 인접 패턴을 그대로 적용하는 template 매칭(S1). "어노테이션은 cross-ref되어야 한다"는 의도를 attribute의 관례/동작에서 재구성해야 한다는 점에서 보조적으로 S5(spec-inference) 성격.
- **K (Knowledge) = K-Domain**: `_parse_annotation`, `desc_annotation` 노드 구성, `pending_xref` 생성, `self.env` 전달 등 Sphinx Python 도메인 내부 지식이 병목. 일반 파이썬 추론만으론 "어떻게 링크 가능한 노드를 만드는가"를 알 수 없다.
- **primary = T-DomainBound**: 결함클래스는 단순하지만(평문→파싱 노드), 올바른 픽스는 Sphinx 도메인의 노드 빌딩 API 지식에 의존하므로 K-Domain이 dominant.

APR 관점: 후보가 하나로 거의 확정(인접 attribute 패턴 복제)이라 generate-&-validate가 아니라 template/direct-map. 단 "왜 그 노드 구성이 맞는가"는 도메인 계약에서 나온다.

## 난이도 티어

**T3 (중간)**. 구조적 피처: 1파일·1함수·실질 +2/-1줄의 극소 패치, has-repro(이슈에 완전 재현 레포·렌더 결과 첨부). 이것만 보면 T2에 가깝다. 그러나 두 가지가 T3로 민다 — (1) 올바른 노드 구성(`desc_annotation(typ, '', nodes.Text(': '), *annotations)`)을 도메인 API 지식 없이 합성하기 어렵고, (2) PASS_TO_PASS가 44개로 넓어 같은 파일의 인접 어노테이션 렌더 동작을 깨면 안 되는 regression-trap이 있다. 공식 라벨은 `<15 min fix`(개발자 구현시간) — 정답을 아는 메인테이너에게는 인접 복붙이라 빠르지만, 에이전트에겐 "노드를 어떻게 구성해야 xref가 생기는지"라는 도메인 합성이 시간라벨에 안 잡히는 비용이라 T3로 상향.

## 골드패치 분석

- **파일·함수**: `sphinx/domains/python.py` → `class PyProperty`의 `handle_signature`.
- **근본원인**: property의 type 어노테이션을 `signode += addnodes.desc_annotation(typ, ': ' + typ)`로 **평문 문자열**로만 추가했다. 이러면 타입명이 단순 텍스트 노드라 도메인의 xref 해석 단계가 걸 게 없어 링크가 생기지 않는다. 반면 `PyAttribute.handle_signature`는 이미 `_parse_annotation(typ, self.env)`로 파싱한 노드를 넣고 있어 정상 링크됨 — 즉 두 directive 간 동작 비대칭이 버그의 본질.
- **수정요지**: 평문을 `annotations = _parse_annotation(typ, self.env)`로 파싱하고 `signode += addnodes.desc_annotation(typ, '', nodes.Text(': '), *annotations)`로 교체. `_parse_annotation`이 타입 토큰을 `pending_xref` 노드로 만들어 이후 해석 단계에서 cross-reference로 resolve된다. 결과적으로 PyAttribute와 동일한 렌더 경로로 통일.

## 검증 (test_patch)

- **FAIL_TO_PASS** (`tests/test_domain_py.py::test_pyproperty`): property 시그니처의 type 어노테이션 노드 트리 기대값을 `[desc_annotation, ": str"]`(단일 평문)에서 `[desc_annotation, (": ", [pending_xref, "str"])]`로 변경. 즉 `pending_xref` 노드의 **존재**를 단언한다 — 이게 cross-reference 가능 여부를 증명하는 직접 신호.
- **픽스 증명**: 픽스가 `_parse_annotation`을 타면 `"str"`이 `pending_xref`로 감싸지므로 새 기대 트리와 정확히 일치. 픽스 없으면 평문 `": str"`이라 트리 불일치로 fail → red/green이 픽스에 직결.
- **overfit 관점**: FAIL_TO_PASS 1개로 얇지만, 픽스가 special-case(`str`만 처리)가 아니라 attribute와 공유하는 범용 `_parse_annotation` 경로를 재사용하므로 overfit 위험 낮음. `: ` 접두어를 별도 `nodes.Text(': ')`로 분리해 어노테이션 본문만 파싱 — 임의 문자열 핵 없이 일반화됨.
- **regression 관점**: PASS_TO_PASS 44개가 같은 `test_domain_py.py` 안의 모든 directive(pyfunction/pydata/pyattribute/union-type/canonical 등) 렌더를 커버. 특히 `test_parse_annotation`, `test_resolve_xref_for_properties`, `test_pyattribute`가 인접 동작을 고정해, property 렌더 변경이 attribute나 함수 시그니처를 깨지 않음을 보장.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 "property's type annotation은 cross-ref 안 됨, attribute는 됨"이라는 비대칭 신호 → `sphinx/domains/python.py`에서 `class PyProperty`와 `class PyAttribute`의 `handle_signature`를 나란히 비교. PyProperty만 `': ' + typ` 평문을 쓰고 PyAttribute는 `_parse_annotation`을 쓴다는 한 줄 차이를 포착.
2. **픽스와 일반화 근거**: PyAttribute의 검증된 패턴을 그대로 이식 — `_parse_annotation(typ, self.env)` + `desc_annotation(typ, '', nodes.Text(': '), *annotations)`. 이게 올바른 일반화인 이유는 (a) 도메인이 이미 보유한 범용 파서를 재사용하고, (b) 임의의 타입 표현(union·generic 등)도 `_parse_annotation`이 공통 처리하므로 `str` 같은 특정 입력에 종속되지 않기 때문.
3. **regression 안전**: `': '` 접두어를 어노테이션 노드와 분리해 별도 `nodes.Text`로 둬야 한다(파싱 대상은 타입 본문뿐). PyAttribute·pyfunction·pydata의 기존 렌더 기대(44 P2P)를 깨지 않으려면 `desc_annotation`의 raw 텍스트 인자(`typ`)는 보존하고 자식 노드만 교체.
4. **함정 회피**: 오라클 없는 에이전트의 오답 시나리오 — (a) `': ' + typ` 전체를 통째로 `_parse_annotation`에 넘겨 `: `까지 파싱되며 노드 트리가 어긋남(접두어 분리 누락), (b) `self.env`를 안 넘겨 xref 해석에 필요한 환경 컨텍스트 누락, (c) `desc_annotation`의 첫 인자(rawsource)를 빈 문자열로 바꿔 다른 단언을 깸. 회피법: 인접한 `PyAttribute.handle_signature`의 정확한 시그니처와 인자 순서를 verbatim 참조해 복제.
