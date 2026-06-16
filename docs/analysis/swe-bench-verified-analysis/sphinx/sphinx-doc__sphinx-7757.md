---
instance_id: sphinx-doc__sphinx-7757
repo: sphinx-doc/sphinx
base_commit: 212fd67b9f0b4fae6a7c3501fdf1a9a5b2801329
version: "3.1"
difficulty: "15 min - 1 hour"
created_at: "2020-05-30T14:46:01Z"
fail_to_pass: 1
pass_to_pass: 33
gold_files: [sphinx/util/inspect.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약

`.. py:function:: foo(a, b=0, /, c=1)` 처럼 positional-only 인자(`/` 앞 인자)에 기본값이 있을 때, Sphinx 렌더 결과에서 그 기본값(`b=0`)이 사라진다. positional-or-keyword 인자(`c=1`)의 기본값은 정상 표시되므로, 시그니처 문자열 파서가 positional-only 구획만 기본값을 누락한다. Python 3.8+ PEP 570 문법에서만 재현된다.

## 유형 (정형화)

- **L1 (Traceable)**: 이슈는 심볼을 직접 지목하진 않지만 "시그니처 문자열 파싱 → 기본값 누락"이라는 명확한 신호가 있어, `sphinx/util/inspect.py::signature_from_str` 단일 함수로 수렴한다. `posonlyargs` grep 한두 방.
- **S2 (Constraint-Reasoning) +S6**: 고칠 지점은 자명하나, 올바른 픽스는 AST의 불변식을 추론해야 나온다. `ast.arguments.defaults`는 posonlyargs와 args를 **합친 뒤쪽 정렬(right-aligned) 단일 리스트**라는 도메인 사실을 알아야, 두 루프가 같은 `defaults`를 인덱스 공유하도록 재구성(S6: empty-pad 후 공통 인덱싱)할 수 있다. 단순 가드 추가(S1)로는 안 풀린다.
- **K-Domain**: Python `ast` 모듈의 `arguments` 노드 구조(특히 `posonlyargs`/`args`/`defaults`의 정렬 규약)와 `inspect.Parameter` 계약 지식이 병목.

primary는 **T-ConstraintReason**: 위치는 쉽게 찾지만 정답은 "defaults 리스트가 두 구획에 어떻게 분배되는가"라는 제약을 정확히 추론해 식을 합성해야 나온다.

## 난이도 티어

**T3 (중간)**. 구조적 피처:
- 파일 1개, 함수 1개, 헌크 1개(약 +20/-5줄) → scope는 작다(T1~T2 신호).
- has-repro: 이슈에 정확한 재현 시그니처가 있어 localize는 쉽다.
- 그러나 픽스가 **단순 가드가 아니라 인덱싱 모델 재구성**이라 추론 부담이 있고(S2+S6), AST defaults 정렬 도메인지식이 필요(K-Domain).
- regression-trap: PASS_TO_PASS 33개 중 `test_signature_from_str_*` 6개가 같은 함수를 직접 커버 → posonlyargs 없는 케이스/kwonly/default_values를 안 깨면서 고쳐야 함.

공식 라벨 "15 min - 1 hour"와 정합. scope만 보면 T2지만, defaults 분배 추론 + 인접 시그니처 케이스 regression 보호가 T3로 민다.

## 골드패치 분석

- **파일·함수**: `sphinx/util/inspect.py` → `signature_from_str()`
- **근본원인**: AST에서 `args.defaults`는 positional-only와 positional-or-keyword를 **합친** 위치들의 뒤쪽 정렬 단일 리스트다. 기존 코드는 (1) posonlyargs 루프에서 `default`를 아예 넘기지 않아 positional-only 기본값을 무조건 버렸고, (2) args 루프에서 `len(args.args)`와 `args.defaults`만으로 인덱스를 계산해, 앞쪽 posonlyargs가 점유한 default 슬롯을 무시했다(오프셋 오류).
- **수정요지**:
  - `defaults = list(args.defaults)`로 복사 후, `positionals = posonlyargs + len(args.args)` 전체 위치 수에 맞춰 앞쪽을 `Parameter.empty`로 패딩(`defaults.insert(0, Parameter.empty)`) → 이제 `defaults[i]`가 i번째 전체 위치 인자의 기본값(없으면 empty)을 직접 가리키는 공통 인덱스 모델이 된다.
  - posonlyargs 루프: `defaults[i]`로 default를 꺼내 `Parameter(... default=default ...)`로 전달(기존엔 default 누락).
  - args 루프: `defaults[i + posonlyargs]`로 posonlyargs 오프셋을 더해 공유 리스트를 정확히 인덱싱.

## 검증 (test_patch)

FAIL_TO_PASS = `test_signature_from_str_positionaly_only_args` 1개. 입력을 기존 `(a, /, b)`에서 `(a, b=0, /, c=1)`로 강화해 픽스를 증명한다:
- `a` → POSITIONAL_ONLY, default == empty (앞쪽 패딩이 정확).
- `b` → POSITIONAL_ONLY, default == `'0'` (이전엔 누락되던 핵심 케이스).
- `c` → POSITIONAL_OR_KEYWORD, default == `'1'` (오프셋 `+posonlyargs` 적용 확인).

세 종류(no-default posonly / default posonly / default poskw)를 한 시그니처에 섞어 인덱스 분배 전체를 강제하므로 overfit 여지가 좁다. **overfit 관점**: special-case로 통과하기 어렵다(인덱스 산술을 실제로 맞춰야 함). **regression 관점**: posonlyargs 없는 케이스에선 `posonlyargs=0`이라 `defaults[i+0]`이 기존 의미와 동치 → `test_signature_from_str_default_values` 등 6개 인접 테스트가 안전망.

## 모범답안 (오라클 기반)

1. **localize**: 이슈의 "positional only argument 기본값 사라짐" + py:function 시그니처 문자열 → 문자열→Signature 변환 지점인 `signature_from_str`. `posonlyargs` grep으로 즉시 도달. 거기서 posonlyargs 루프가 `default`를 전혀 안 넘긴다는 1차 결함이 눈에 띈다.
2. **픽스와 일반화**: 단순히 posonly 루프에 `default=ast_unparse(args.defaults[...])`를 붙이면 안 된다 — `args.defaults`는 posonly+args 합산 정렬이므로 인덱스가 어긋난다. 올바른 일반화는 defaults를 전체 위치 수만큼 앞에서 empty 패딩한 단일 배열로 정규화하고, 두 루프가 `i`(posonly)와 `i+posonlyargs`(args)로 같은 배열을 공유하는 것. 이래야 "어느 구획이든 i번째 위치의 기본값"이라는 불변식이 성립해 임의 조합에 일반화된다.
3. **regression 안전**: posonlyargs가 없으면 `posonlyargs=0`, 패딩량 = `len(args.args)-len(defaults)`로 기존 `len(args.args)-i <= len(args.defaults)` 분기와 수학적으로 동치 → `test_signature_from_str_basic/default_values/annotations/kwonly` 6개를 보존. kwonly/vararg/kwarg 경로는 미접촉이라 영향 없음.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 오답은 (a) posonly 루프에만 default를 붙이고 args 루프 오프셋을 그대로 두어 `c` 기본값이 한 칸 밀리는 것, (b) `args.defaults`를 posonly/args가 각각 따로 갖는다고 가정하는 것. 회피법: AST가 defaults를 **공유 right-aligned 리스트**로 둔다는 사실을 `(a, b=0, /, c=1)` 같은 혼합 입력으로 직접 검증해 인덱스 모델을 먼저 못박고 코드를 짠다.
