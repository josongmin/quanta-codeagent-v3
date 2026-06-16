---
instance_id: sphinx-doc__sphinx-9230
repo: sphinx-doc/sphinx
base_commit: 567ff22716ac258b9edd2c1711d766b440ac0b11
version: "4.1"
difficulty: "<15 min fix"
created_at: 2021-05-15T11:33:05Z
fail_to_pass: 1
pass_to_pass: 44
gold_files: [sphinx/util/docfields.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`:param dict(str, str) opc_meta: (optional)` 처럼 타입에 공백이 포함된(또는 `Dict[str, str]` 같은) 파라미터를 docstring으로 쓰면 렌더가 깨진다. 기대값은 `opc_meta (dict(str,str))` 인데 실제로는 `str) opc_meta (dict(str,)` 처럼 타입과 이름이 뒤섞여 출력된다. 이슈는 명확한 재현 입력과 기대/실제 출력 대비를 제공한다.

## 유형 (정형화)
- **L = L1 (Traceable)**: 이슈에 파일/심볼 직접 지목은 없지만 "`:param type name:` 구문 처리"라는 기능 키워드가 `sphinx/util/docfields.py`의 `DocFieldTransformer.transform` 내 `# also support syntax like :param type name:` 분기로 좁게 수렴한다. grep 한두 방.
- **S = S2 (Constraint-Reasoning)**: 고칠 한 줄은 `fieldarg.split(None, 1)`이다. 그러나 올바른 픽스는 "타입에 공백이 있을 수 있다"는 불변식을 추론해 **왼쪽이 아니라 오른쪽에서 1회 분리**(`rsplit`)해야 한다는 식 합성이다. 후보를 마구 던져 테스트로 거르는 G&V가 아니라 "이름은 항상 마지막 토큰 하나, 타입은 나머지 전부"라는 도메인 규약을 따져 푸는 문제.
- **K = K-Domain**: Sphinx info-field(`:param:`/`:type:`) 문법 규약 — "타입 + 이름 = `<type ...> <name>`, 이름은 공백 없는 단일 토큰"이라는 autodoc 도메인 계약을 알아야 분리 방향이 결정된다.
- **primary = T-ConstraintReason**: 위치는 거의 자명(L1)하나 픽스의 본질이 `split→rsplit` 방향성 추론(엣지케이스 불변식 합성)이라 DirectMap(기계적 가드/상수)이 아니라 ConstraintReason.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 1파일·1줄·1헌크의 극소 패치(공식 라벨 "<15 min fix"와 일치)이며 `has-repro`로 재현이 쉽다 — 이는 T2 쪽으로 미는 신호다. 그러나 픽스가 `split`→`rsplit` 단일 토큰 치환이라 "기계적 None가드/상수변경"이 아니라 **분리 방향이라는 비자명 불변식 추론**을 요구(S2)하고, K-Domain(파라미터 이름은 마지막 단일 토큰) 지식이 결정적이라 T2가 아닌 T3로 올린다. P2P 44개가 같은 `test_domain_py` 모듈에 몰려 있어 약한 regression-trap도 존재한다(공백 없는 일반 `:param int age:` 케이스를 `rsplit`이 깨면 안 됨). 공식 시간라벨보다 한 단계 위로 보는 이유는 localize는 쉬워도 픽스 도출에 도메인 추론이 끼어서다.

## 골드패치 분석
- **파일·함수**: `sphinx/util/docfields.py` → `DocFieldTransformer.transform(self, node)`의 `if typedesc.is_typed:` 분기.
- **근본원인**: `argtype, argname = fieldarg.split(None, 1)`. `split(None, 1)`은 **첫 공백 기준 왼쪽 1회 분리**라, `dict(str, str) opc_meta`처럼 타입 내부에 공백이 있으면 `argtype="dict(str,"`, `argname="str) opc_meta"`로 잘려 타입/이름이 오염된다. Sphinx 규약상 이름은 공백 없는 단일 토큰이고 타입은 그 앞 전부인데, 왼쪽 분리는 이 불변식을 위반한다.
- **수정요지**: `split(None, 1)` → `rsplit(None, 1)`. **오른쪽 1회 분리**로 마지막 토큰을 `argname`, 나머지 전부를 `argtype`으로 잡아 타입 내부 공백을 보존한다. 이후 `types.setdefault(typename, {})[argname] = [nodes.Text(argtype)]`와 `fieldarg = argname`가 올바른 이름/타입으로 동작한다. `except ValueError`(공백 없는 단일 토큰=타입 없는 경우) 분기는 그대로라 행위 보존.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `tests/test_domain_py.py::test_info_field_list`에 `:param Dict[str, str] params: blah blah` 케이스를 추가. `bullet_list`에 `list_item` 하나가 더 늘고(파라미터 4→5), 새 항목이 `[literal_strong "params"] " (" [pending_xref Dict] [ "[" ] [str] [ ", " ] [str] [ "]" ] ")"`로 분해되는지 `assert_node`로 노드 트리를 정밀 검증한다. 즉 타입 `Dict[str, str]`(공백 포함)이 통째로 타입으로, `params`만 이름으로 분리됐음을 증명.
- **픽스 증명**: `split`이면 `argname`이 `str] params` 따위가 되어 `literal_strong`이 `params`가 아니고 xref target도 어긋나 assert가 실패한다. `rsplit`이라야 마지막 토큰 `params`만 이름으로 떨어져 트리가 일치 → 인과 직결.
- **overfit/regression**: FAIL_TO_PASS는 1개로 얇지만, 픽스가 1문자 의미 치환이라 special-case 우회 여지가 거의 없어 overfit 위험은 낮다(overfit-risk 미부여). 다만 같은 test에 기존 `:param age: / :type age: int` 등 공백 없는 케이스가 공존하므로 `rsplit`이 그것들을 깨지 않아야 한다(`rsplit(None,1)`은 토큰 2개일 때 `split`과 동일 → 안전). P2P 44개가 동일 도메인 모듈이라 regression-trap 플래그.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 "param에 공백 있는 datatype" + 기대출력 `opc_meta (dict(str,str))`에서 "`:param type name:` 구문 파서"를 키워드로 잡는다 → `sphinx/util/docfields.py`의 `DocFieldTransformer.transform`, 주석 `# also support syntax like :param type name:` 바로 아래 `if typedesc.is_typed:` 분기로 직행. 단일 후보.
2. **픽스와 일반화 근거**: `split(None, 1)`이 "타입은 1토큰"을 암묵 가정한 게 버그다. Sphinx 규약은 **이름이 공백 없는 단일 토큰**이고 타입은 그 앞 임의 토큰열이므로, 분리는 반드시 오른쪽에서 1회(`rsplit(None, 1)`)여야 일반화된다. `dict(str, str)`/`Dict[str, str]`/`a.b.C` 등 어떤 공백 포함 타입에도 무차별 적용되는 올바른 불변식 — 특정 입력에 맞춘 패치가 아니다.
3. **regression 안전**: 토큰이 2개(`int age`)면 `rsplit(None,1)==split(None,1)`이라 기존 단순 케이스는 byte-identical. 토큰 1개(타입 없는 `:param x:`)는 여전히 `ValueError`→`pass`로 빠진다. P2P의 `test_info_field_list_var`, `test_parse_annotation` 등 인접 케이스 불변.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 오답은 (a) 출력 렌더 단계(`PyObject`/`pending_xref` 생성부)를 의심해 엉뚱한 곳을 고치거나, (b) `split` 대신 정규식/괄호 카운팅 같은 과한 파서를 새로 짜 over-engineering하는 것이다. 정답은 `split`→`rsplit` 방향 치환이라는 **최소 변경**임을 "이름은 마지막 토큰" 불변식으로 확신하는 것 — 더 복잡하게 가면 P2P를 깨거나 overfit한다.
