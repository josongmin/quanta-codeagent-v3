---
instance_id: sphinx-doc__sphinx-7454
repo: sphinx-doc/sphinx
base_commit: aca3f825f2e4a8817190f3c885a242a285aa0dba
version: "3.0"
difficulty: "<15 min fix"
created_at: 2020-04-09T17:08:30Z
fail_to_pass: 1
pass_to_pass: 27
gold_files: [sphinx/domains/python.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap]
---

## 문제 요약
`autodoc_typehints='description'` 모드에서는 함수 반환 타입 `None`이 파이썬 공식문서의 `None` 싱글톤 페이지로 클릭 가능한 링크가 생성되는데, `'signature'` 모드에서는 시그니처의 `None`이 링크되지 않는다. 두 모드가 `None`에 대해 일관되지 않게 동작한다. 기대 동작은 모드와 무관하게 `None`이 `None` 싱글톤 문서로 링크되는 것이다.

## 유형 (정형화)
- **L (Localization) = L1 (Traceable)**: 이슈는 파일/심볼을 직접 지목하지 않지만, "signature 모드 type annotation 파싱"이라는 키워드가 `sphinx/domains/python.py`의 `_parse_annotation` → 내부 `make_xref`로 좁게 수렴한다. 약간의 도메인 탐색 필요.
- **S (Strategy) = S2 Constraint-Reasoning (+S5 Spec-Inference)**: 고칠 지점은 명확하나, "왜 `None`만 다르게 처리해야 하는가"를 추론해야 한다. 파이썬 도메인에서 `None`은 클래스가 아니라 싱글톤 객체이므로 xref `reftype`을 `'class'`가 아닌 `'obj'`로 합성해야 intersphinx가 `library/constants.html#None`으로 해석한다 — 이 스펙은 description 모드의 기존 동작(올바른 레퍼런스)에서 역추론된다(S5).
- **K (Knowledge) = K-Domain**: Sphinx 파이썬 도메인의 xref 모델(`reftype` 'class' vs 'obj'), intersphinx 타깃 해석, `pending_xref` 노드 의미를 알아야 한다. 일반 파이썬 추론으로는 `None`을 특수처리할 이유가 안 나온다.
- **primary_type = T-DomainBound**: 픽스 자체는 5줄 분기지만, 진짜 병목은 "`None`은 reftype=obj여야 한다"는 프레임워크 내부 지식이다. 위치는 쉽게 찾혀도 올바른 상수값은 도메인 계약에서만 나온다.

APR 관점: 단일 지점에서 조건분기 1개를 합성하는 전형적 semantic repair(S2). 후보를 마구 시도하는 G&V가 아니라, xref 계약을 따져 `reftype`을 결정론적으로 골라야 한다.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일 1개(`sphinx/domains/python.py`), 순수 추가 5줄, 헌크 1개 → scope는 T1~T2급.
- localize 직접성: L1 (직접 포인터 없음, 도메인 탐색 약간 필요).
- repro: 이슈에 완전한 재현 스크립트 존재(has-repro급 신호)지만 HTML 출력 비교라 즉시 단위테스트화는 아님.
- 도메인 지식이 핵심 병목 → K-Domain이 티어를 T2에서 T3로 끌어올림.
- P2P 27개: 같은 `test_domain_py.py` 안의 광범위 시그니처/xref 동작을 안 깨야 함(regression-trap 약~중).

공식 라벨은 "<15 min fix"(T1~T2 시간대). diff 줄수만 보면 맞지만, "`None`=obj reftype"이라는 도메인 통찰이 시간라벨에 안 잡혀서 에이전트 난이도는 T3로 재조정한다. 통찰 없이 단순히 `None`을 무시·삭제하거나 reftype을 그대로 두면 틀린다.

## 골드패치 분석
- **건드린 파일·함수**: `sphinx/domains/python.py` → `_parse_annotation()` 내부 클로저 `make_xref(text)`.
- **근본원인**: `make_xref`가 모든 annotation 토큰을 무조건 `reftype='class'`로 `pending_xref`를 만든다. `None`은 클래스가 아니라 객체(싱글톤)이므로, `reftype='class'`로는 intersphinx가 `None`을 클래스 인벤토리에서 찾으려다 매칭 실패 → 링크가 생성되지 않는다. 반면 description 모드 경로는 `None`을 obj로 다뤄 링크가 났던 것이 불일치의 원인.
- **수정요지**: `make_xref`에서 `text == 'None'`이면 `reftype = 'obj'`, 아니면 `reftype = 'class'`로 분기한 뒤 그 값을 `pending_xref(..., reftype=reftype, ...)`에 전달. `None`만 객체-레퍼런스로 만들어 signature 모드도 `constants.html#None`으로 링크되게 한다.

## 검증 (test_patch)
- **FAIL_TO_PASS** (`tests/test_domain_py.py::test_parse_annotation` 1개): (1) 기존 `int` 케이스에 `assert_node(doctree[0], pending_xref, refdomain="py", reftype="class", reftarget="int")`를 추가해 일반 타입은 여전히 class reftype임을 고정. (2) 신규 `_parse_annotation("None")` 케이스에서 `reftype="obj", reftarget="None"`을 단언 — 픽스의 핵심 분기를 직접 검증.
- **픽스 증명**: 패치 전에는 `None`도 `reftype='class'`로 생성되어 신규 단언이 `obj != class`로 RED. 분기 추가 후 GREEN. 동시에 `int`가 여전히 class임을 단언하므로 "모두 obj로 바꾸는" 과잉수정도 차단한다.
- **overfit 관점**: 테스트가 노드의 reftype/reftarget을 직접 본다(HTML 문자열이 아니라). `None`만 분기하므로 다른 토큰 동작은 불변 — overfit 위험 낮음. `flags`에서 overfit-risk 제외.
- **regression 관점**: P2P 27개가 시그니처 파싱·xref 해석 전반을 커버. `None` 외 토큰은 동일 경로라 안전. regression-trap은 "같은 파일 광범위 P2P" 때문에 표기하되 강도는 낮음.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "signature 모드에서 `None`이 링크 안 됨" + "description 모드는 됨" 대비가 핵심 신호. signature의 타입힌트는 파싱→xref 노드로 만들어지므로 파이썬 도메인 annotation 파서를 찾는다 → `sphinx/domains/python.py::_parse_annotation`의 `make_xref`. 여기가 모든 토큰을 `pending_xref(reftype='class')`로 만드는 단일 지점임을 확인.
2. **픽스와 일반화**: `None`은 파이썬 도메인에서 클래스가 아니라 객체이므로 `reftype='obj'`여야 intersphinx가 `constants.html#None`을 해석한다. `text == 'None'` 분기로 obj를 주고 나머지는 class 유지. 이는 description 모드가 이미 쓰는 obj 레퍼런스와 동작을 일치시키는 것이라 올바른 일반화 — 특정 테스트를 통과시키려는 special-case가 아니라 도메인 계약을 맞춤.
3. **regression 안전**: `int`/`List` 등 실제 클래스 토큰은 반드시 `reftype='class'`를 유지해야 한다(P2P의 시그니처/xref 테스트들). 분기를 `None`에만 한정했으므로 기존 경로 불변. test_patch가 `int`의 class reftype을 명시 단언해 이 경계를 봉인.
4. **함정 회피**: (a) `None`을 클래스로 취급해 모든 토큰을 obj로 바꾸면 일반 클래스 링크가 깨진다 — 반드시 `None`만 분기. (b) 단순히 `None`을 xref에서 제외(텍스트만 출력)하면 "링크되게 한다"는 기대 동작에 미달. (c) intersphinx의 `obj` vs `class` 인벤토리 구분을 모르면 reftype 값을 잘못 골라 RED가 사라지지 않는다 — 이 도메인 지식이 정답의 분기점.
