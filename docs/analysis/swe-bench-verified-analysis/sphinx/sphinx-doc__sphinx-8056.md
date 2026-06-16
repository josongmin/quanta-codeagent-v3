---
instance_id: sphinx-doc__sphinx-8056
repo: sphinx-doc/sphinx
base_commit: e188d56ed1248dead58f3f8018c0e9a3f99193f7
version: "3.2"
difficulty: "15 min - 1 hour"
created_at: 2020-08-05T17:18:58Z
fail_to_pass: 1
pass_to_pass: 40
gold_files: [sphinx/ext/napoleon/docstring.py]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain
flags: [regression-trap, underspecified]
---

## 문제 요약
numpydoc 스타일 docstring에서 `x1, x2 : array_like` 처럼 여러 파라미터를 한 줄에 묶어 선언하면 napoleon 확장이 이를 단일 이름 `"x1, x2"` 로 취급해 잘못 렌더링한다. numpydoc 포맷 규약은 콤마로 구분된 다중 파라미터를 허용하지만, napoleon은 각 파라미터를 분리해 개별 `:param:`/`:type:` 으로 펼치지 못한다. `optional` 을 붙여도 동일 출력이라 옵션 여부 구분도 불가능하다.

## 유형 (정형화)
- **L = L1 (Traceable).** 이슈가 "napoleon", "numpydoc parameters" 라는 명확한 키워드를 주므로 `sphinx/ext/napoleon/docstring.py` 의 파라미터 섹션 파서로 좁게 수렴한다. 단, `_consume_field` vs `_consume_fields` vs `_parse_parameters_section` 중 어디를 손댈지는 데이터플로우를 한 단계 따라가야 한다 → 핀포인트(L0)는 아님.
- **S = S5 (Spec-Inference) +S6.** 버그의 "올바른 동작"이 코드에 적혀 있지 않다. numpydoc 외부 명세("콤마로 다중 파라미터 선언 가능")를 먼저 재구성해야 픽스 방향이 결정된다. 그 후 단일 필드를 N개 필드로 분기시키는 작은 구조 변경(`_consume_fields` 에 `multiple` 파라미터 도입 + split-then-emit)이 들어가므로 S6 보조.
- **K = K-Domain.** napoleon 내부 파이프라인(`_consume_field` → `_consume_fields` → `_format_docutils_params`)과 numpydoc/Google docstring 규약을 알아야 한다. 일반 파이썬 추론만으로는 어느 헌트가 콤마-분리를 책임져야 하는지 못 정한다.
- **primary = T-SpecInference.** 본질 난점은 "어디"가 아니라 numpydoc 명세를 코드 계약으로 번역하는 것 — 콤마 split을 `napoleon_use_param=True` 경로에만 적용해야 한다는 의도 추론이 핵심.

## 난이도 티어
**T3 (중간).** 구조적 피처: 단일 파일·단일 함수군, gold 헌크 2개·실질 +6/-3줄로 매우 작다. localize는 L1(키워드로 좁힘)이라 어렵지 않다. 그러나 (1) 재현 스택트레이스 없이 렌더 결과 스크린샷만 있어 `has-repro` 부재, (2) 명세를 외부 numpydoc 가이드에서 끌어와야 하는 underspecified 성격, (3) PASS_TO_PASS 42개가 napoleon Google/Numpy 파서 전반을 덮어 `multiple` 분기를 잘못 넣으면 광범위 회귀(regression-trap) — 이 세 요인이 T2(쉬움)에서 T3로 민다. 공식 라벨 "15분-1시간"과 일치한다(개발자에겐 작은 변경이나, 에이전트에겐 split 적용 위치 판단이 함정).

## 골드패치 분석
**파일:** `sphinx/ext/napoleon/docstring.py` (`GoogleDocstring` 베이스 메서드, `NumpyDocstring` 상속).

**근본 원인:** `_consume_fields` 가 `_consume_field` 가 돌려준 `(_name, _type, _desc)` 튜플을 그대로 누적한다. numpydoc 의 `x1, x2 : array_like` 한 줄은 `_name="x1, x2"` 단일 토큰으로 들어와 콤마가 그대로 이름에 남아, 다운스트림 `_format_docutils_params` 가 잘못된 단일 파라미터를 생성한다.

**수정 요지:**
1. `_consume_fields` 시그니처에 `multiple: bool = False` 추가. `multiple and _name` 일 때 `_name.split(",")` 로 쪼개 각 이름을 `name.strip()` 한 뒤 동일 `_type`/`_desc` 를 공유하는 개별 필드로 append.
2. `_parse_parameters_section` 에서 `napoleon_use_param=True` 경로일 때만 `_consume_fields(multiple=True)` 호출, `False` 경로(`_format_fields`)는 기존 `_consume_fields()` 유지. fields 계산을 `if` 분기 안으로 옮겨 두 경로가 서로 다른 호출을 받도록 재배치.

## 검증 (test_patch)
**FAIL_TO_PASS (1개):** `NumpyDocstringTest::test_multiple_parameters`. `x1, x2 : array_like` 입력을 두 config로 검증한다. `napoleon_use_param=False` 에서는 `**x1, x2**` 가 한 필드로 유지(split 미적용)되고, `napoleon_use_param=True` 에서는 `:param x1:`/`:type x1:` + `:param x2:`/`:type x2:` 두 쌍으로 펼쳐져야 한다.

**픽스 증명:** `multiple=True` 가 정확히 `napoleon_use_param` 분기에만 적용되므로, param-모드에서만 split이 일어나는 기대 출력을 그대로 만족한다. `_descs`/`_type` 공유로 설명·타입이 두 파라미터에 복제되는 것도 테스트가 명시.

**overfit/regression 관점:** FAIL_TO_PASS는 1개로 얇지만(`overfit-risk` 잠재), split 로직이 `","` 라는 numpydoc 규약의 자연스러운 구분자라 special-case가 아니다. test_patch가 동시에 1230줄 근처 기존 기대값을 `*str*` → `:class:\`str\`` 로 갱신 — 무관 변경이 아니라 같은 릴리스 사이클의 출력 포맷 정합. PASS_TO_PASS 42개가 Google/Numpy 양쪽 파서를 회귀 가드로 잡아, `multiple` 을 `_parse_other_parameters_section` 등 다른 호출지에 누출시키면 즉시 깨진다.

## 모범답안 (오라클 기반)
1. **localize:** 이슈의 "napoleon + numpydoc Parameters" 신호로 `sphinx/ext/napoleon/docstring.py` 진입 → `_parse_parameters_section` 발견 → 호출하는 `_consume_fields` → 필드 단위 파싱 `_consume_field` 로 한 단계씩 내려가, 콤마가 `_name` 에 통째로 남는 지점이 `_consume_fields` 누적부임을 확인.
2. **픽스/일반화:** 콤마 split을 `_consume_field`(단일 필드 파싱) 가 아니라 `_consume_fields`(루프) 에 넣는 게 올바른 일반화 — 한 줄을 N필드로 fan-out 하는 책임은 누적 루프에 있다. 그리고 `multiple` 게이트를 `napoleon_use_param=True` 경로로 한정하는 것이 핵심: `_format_docutils_params` 만 파라미터별 `:param:` 을 생성하므로 split이 의미 있고, `_format_fields` 경로는 한 줄 묶음을 그대로 보여주는 게 맞다.
3. **regression 안전:** PASS_TO_PASS의 `test_parameters_with_class_reference`, `test_docstrings`, `test_escape_args_and_kwargs` 등은 콤마가 정상적으로 한 이름에 속하는 케이스(`*args, **kwargs` 등)나 Google 스타일을 검증한다. `multiple=False` 가 기본값이라 기존 모든 호출지가 byte-identical로 유지되는 것이 안전의 핵심.
4. **함정 회피:** 오라클 없는 에이전트가 빠지기 쉬운 함정 — (a) split을 `_consume_fields` 전역(기본 True)으로 적용해 `*args, **kwargs` 나 Other Parameters까지 쪼개 PASS_TO_PASS 다수를 깨뜨림; (b) `napoleon_use_param=False` 경로에도 split을 넣어 `**x1, x2**` 한 필드 기대를 위반; (c) `name.strip()` 누락으로 `" x2"` 처럼 앞공백이 남는 이름 생성. 정답은 split을 옵션 게이트로 가두고 param-모드에만 켜는 것.
