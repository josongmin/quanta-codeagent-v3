---
instance_id: sphinx-doc__sphinx-9258
repo: sphinx-doc/sphinx
base_commit: 06107f838c28ab6ca6bfc2cc208e15997fcb2146
version: "4.1"
difficulty: "<15 min fix"
created_at: 2021-05-21T16:56:41Z
fail_to_pass: 1
pass_to_pass: 45
gold_files: [sphinx/domains/python.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap]
---

## 문제 요약
`:type foo: bytes | str` 처럼 PEP 604 / PEP 484 Union 표기의 파이프(`|`) 구분자로 info-field-list의 타입을 명시해도 Sphinx가 이를 각 타입별 cross-reference로 분리·링크하지 않는다. 기존에는 `str or int` 처럼 `or` 키워드와 `[](),...` 구분자만 분할 대상이었고, `|`는 토큰 분리자에 없어 전체 문자열이 단일 타입으로 취급되었다. 요청은 PyCharm/PEP 484가 쓰는 파이프 union 문법을 type 필드에서도 자동 링크하도록 지원하는 것이다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 증상이 "type 필드에서 `|`가 분리되지 않음"으로, info-field-list 타입 분할을 담당하는 `make_xrefs`의 정규식 `delims` 한 곳을 직접 지목한다. `delims`/`make_xrefs`를 grep하면 한 방에 도달.
- **S1 (+S2)**: 결함클래스가 "구분자 토큰 누락"이라 픽스가 사실상 기계적 — 기존 alternation에 파이프 케이스를 한 항 추가. 다만 정규식 alternation에 `\s*\|\s*`를 어느 위치에·어떤 공백 처리로 끼워 넣을지(주변 공백을 토큰에 흡수시켜 ` | ` 텍스트 노드가 되도록)는 약간의 패턴 추론이 필요해 S2 보조.
- **K-Domain**: docutils/Sphinx의 info-field-list 처리, `re.split` 캡처그룹이 구분자 자체를 결과에 남긴다는 동작, 분할 토큰이 `delims_re.match`로 다시 걸러져 텍스트 노드로 보존되는 파이프라인 이해가 필요. 순수 일반 파이썬만으론 안전한 픽스가 어렵다.

primary type = **T-DirectMap**: 위치가 명확하고(L0) 픽스가 정규식에 토큰을 추가하는 기계적 매핑(S1)이다.
APR 관점: 이슈가 "어떤 입력이 어떤 동작을 해야 하는지"를 거의 명세하고, 결함이 "delimiter 테이블에 한 케이스 누락"이라는 정형 패턴이라 template-style(S1) 직매핑이 dominant하다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처:
- 파일수 1, 골드 헌크 1, 실질 변경 1줄(정규식 alternation 한 항 추가).
- localize 직접성 높음 — 증상→`make_xrefs`→`delims` 경로가 짧다.
- repro: 이슈에 명시 reST 스니펫이 있어 테스트화 직결(`has-repro`에 준함).
- 도메인 지식 필요하나 얕음(구분자 정규식 + `re.split` 캡처 동작).
- P2P 46개로 `regression-trap` 존재 — 같은 `make_xrefs`를 타는 `str or int`, `Union[...]`, `int | str` 시그니처 케이스(`test_pyfunction_with_union_type_operator` 등)를 깨면 안 됨.

공식 라벨 `<15 min fix`와 일치(T1~T2 prior). T1이 아니라 T2인 이유: 픽스가 완전 자명한 가드/상수가 아니라 정규식 alternation 내 위치·공백 흡수까지 맞춰야 하고, 넓은 P2P가 회귀 안전을 요구하기 때문.

## 골드패치 분석
- **파일·함수**: `sphinx/domains/python.py`의 `PyXrefMixin.make_xrefs`.
- **근본원인**: 타입 토큰 분할용 정규식 `delims`가 `[ ] ( ) , `·`or`·`...`만 구분자로 인식하고 파이프 `|`를 포함하지 않아, `int | str`가 `re.split`에서 분리되지 않고 통째로 하나의 sub_target이 되어 단일 xref로 잘못 처리됨.
- **수정요지**: alternation에 `\s*\|\s*` 항 추가.
  - before: `r'(\s*[\[\]\(\),](?:\s*or\s)?\s*|\s+or\s+|\.\.\.)'`
  - after:  `r'(\s*[\[\]\(\),](?:\s*or\s)?\s*|\s+or\s+|\s*\|\s*|\.\.\.)'`
  주변 공백을 토큰에 흡수(`\s*\|\s*`)시켜, 캡처그룹으로 결과에 남는 구분자가 ` | ` 형태의 emphasis 텍스트 노드가 되고, 양옆 `int`/`str`는 각각 `make_xref`로 들어가 `pending_xref`(reftype=class)로 링크된다.

## 검증 (test_patch)
- **FAIL_TO_PASS** `test_info_field_list_piped_type`: `:type age: int | str` 입력에 대해 paragraph가 `[pending_xref → int]`, `[literal_emphasis " | "]`, `[pending_xref → str]` 구조로 나뉘는지 `assert_node`로 검증. 두 `pending_xref`의 `reftarget`이 각각 `"int"`/`"str"`, `refdomain="py"`, `reftype="class"`임까지 확인 — 즉 분할뿐 아니라 양쪽이 진짜 클래스 cross-ref로 링크됨을 증명한다.
- **픽스 증명**: 정규식에 `\s*\|\s*`가 추가되어야만 `re.split`이 ` | `를 구분자로 떼어내고, 나머지 두 조각이 xref 대상이 되어 위 노드 구조가 성립.
- **overfit/regression 관점**: 테스트가 분할된 양쪽 노드 타입·텍스트·xref 속성을 모두 단언해 special-case 통과 여지가 작다(overfit 위험 낮음). 다만 FAIL_TO_PASS가 1개라 다중 파이프(`a | b | c`)·`Optional` 혼용은 미검증. regression은 P2P의 기존 `or`/`Union[...]`/시그니처 union(`test_pyfunction_with_union_type_operator`, `test_pydata_with_union_type_operator`) 케이스로 광범위하게 보호됨.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "`:type ...: int | str`가 링크 안 됨" → info-field-list 타입 렌더링 담당 코드 탐색 → `sphinx/domains/python.py`의 `PyXrefMixin.make_xrefs`에서 `delims` 정규식과 `re.split(delims, target)`을 발견. 기존에 `or`만 처리되는 것을 보고 구분자 테이블이 단일 출처임을 확인.
2. **픽스**: alternation에 `\s*\|\s*` 한 항 추가. 이게 올바른 일반화인 이유 — 결함이 "delimiter 누락"이라는 일반 케이스이고, `or`/`,`/`[]` 분할과 동일 메커니즘(캡처그룹으로 구분자 보존 후 `delims_re.match`로 텍스트화)에 파이프만 합류시키는 것이라 모든 `A | B | ...` 입력에 자연히 일반화된다. 주변 공백을 `\s*`로 흡수해야 출력 ` | ` 텍스트와 양옆 토큰 분리가 깔끔.
3. **regression 안전**: 새 항을 기존 항들과 OR로 병렬 추가하므로 `str or int`, `Union[str, int]`, 시그니처 union(`int | str`) 경로는 동작 불변 — P2P의 `test_info_field_list`, `test_pyfunction_with_union_type_operator`, `test_pydata_with_union_type_operator`가 이를 가드. `|`를 너무 탐욕적으로(예: 공백 없이 `\|`만, 또는 character class에 `|` 삽입) 넣어 다른 토큰을 깨지 않도록 별도 alternation 항으로 격리.
4. **함정 회피**: (a) 파이프를 `[\[\]\(\),]` character class에 넣으면 정규식에서 그냥 리터럴 `|`이 되어 의미는 맞지만 공백 흡수가 빠져 ` | ` 텍스트 노드가 부정확해질 수 있음 — 독립 항 `\s*\|\s*`가 정답. (b) `|`를 이스케이프(`\|`) 안 하면 alternation 메타문자로 오인. (c) 오라클 없는 에이전트는 분할만 하고 양옆이 `pending_xref`로 링크되는지 확인 안 하고 끝낼 수 있음 — 테스트가 reftype/reftarget까지 보므로 단순 텍스트 분리로는 불충분.
