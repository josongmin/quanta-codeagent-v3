---
instance_id: sympy__sympy-23262
repo: sympy/sympy
base_commit: fdc707f73a65a429935c01532cd3970d3355eab6
version: "1.11"
difficulty: "15 min - 1 hour"
created_at: 2022-03-21T07:17:35Z
fail_to_pass: 1
pass_to_pass: 61
gold_files: [sympy/utilities/lambdify.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L1
repair_strategy: S2
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

## 문제 요약
`lambdify([], tuple([1]))`로 1-원소 튜플을 코드 생성하면 SymPy 1.10부터 `return (1,)`이 아니라 `return (1)`로 출력되어, 튜플이 아닌 정수가 반환된다. 2-원소 이상 튜플(`(1, 2)`)은 정상이며, 이슈 작성자는 1.9 → 1.10 회귀로 보고하고 #21993(커밋 6ccd2b07)으로 bisect했다. 즉 single-element tuple의 trailing comma가 누락되는 코드 생성 버그.

## 유형 (정형화)
- **L (Localization) = L1.** 이슈가 "Python code printer", "lambdify"를 직접 지목하고 bisect 커밋까지 제공한다. `lambdify.py` 내에서 튜플 문자열을 조립하는 함수(`_recursive_to_string`)를 키워드 grep("tuple", "right")로 좁은 단일 후보로 수렴 가능. 직접 심볼 지목(L0)까진 아니지만 탐색이 가볍다.
- **S (Repair Strategy) = S2.** 고칠 지점은 명확하나, 픽스는 "왜 single-element tuple만 깨지는가"라는 불변식을 추론해야 도출된다. `left, right = "()"`가 2글자 문자열을 2개 변수로 언팩해 `right="]"`/`")"`가 되고 trailing comma가 사라진다는 점을 이해하면, 올바른 delimiter 쌍을 합성하는 의미 기반 수정. 후보 난사(S3/S4)가 아니라 한 번의 정확한 추론으로 푼다.
- **K (Knowledge) = K-Gen.** sympy 내부 도메인 지식 불필요. 순수 파이썬 튜플 리터럴 문법(`(1,)` vs `(1)`)과 시퀀스 언팩 동작만 알면 된다.
- **Primary = T-ConstraintReason.** 위치는 쉽게 찾히지만 픽스의 본질은 "trailing comma 불변식"을 따져 올바른 구분자 식을 합성하는 데 있다. 가드/기본값 같은 기계적 템플릿(T-DirectMap)이 아니라, edge-case 추론이 핵심.

## 난이도 티어
**T2 (쉬움).** 구조적 피처: 단일 파일(`lambdify.py`) 1개 함수, 변경 2줄, has-repro(완전 재현 MWE + bisect 커밋 + 기대출력 명시 = 매우 강한 easiness 신호). 다만 픽스가 None-가드 같은 자명 템플릿이 아니라 "왜 `(1,)`만 깨지는가"라는 가벼운 엣지추론을 요구하므로 T1이 아닌 T2. 공식 라벨 "15분-1시간"과 정합적(상한선은 회귀 확인·테스트 작성 오버헤드 때문이지 픽스 자체는 자명). regression-trap이 약하게 존재(62개 P2P가 list/tuple/nested 출력 포맷 전반을 커버 → 구분자 변경이 인접 포맷을 깨면 안 됨)하지만 변경이 tuple 분기에 국한되어 위험은 낮음.

## 골드패치 분석
- **파일·함수:** `sympy/utilities/lambdify.py`의 `_recursive_to_string(doprint, arg)`.
- **근본원인:** tuple/list 분기에서 구분자를 시퀀스 언팩으로 할당한다 — `left, right = "[]"` / `left, right = "()"`. 2글자 문자열이 `left="["/"("`, `right="]"/")"`로 풀린다. 따라서 tuple 출력은 항상 `(` + 원소들 + `)`가 되고, 1-원소 튜플에 필요한 trailing comma가 자리잡을 곳이 없다. #21993에서 이 압축 표기를 도입하면서 1.9의 `(1,)` 동작이 깨진 회귀.
- **수정요지:** 언팩을 명시적 쌍 할당으로 교체. list는 `left, right = "[", "]"`(동작 동일, 정합성), tuple은 `left, right = "(", ",)"`로 바꿔 닫는 구분자에 comma를 박는다. 그 결과 조립식 `left + ', '.join(...) + right`에서 1-원소면 `(` + `1` + `,)` = `(1,)`, 다-원소면 `(` + `1, 2` + `,)` = `(1, 2,)`가 되어 둘 다 유효한 튜플 리터럴.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_issue_14941`** 에 두 줄 추가: `f2b = lambdify([], (1,))` 후 `assert f2b() == (1,)`. 픽스 전엔 생성 코드가 `return (1)`이라 `f2b()`가 정수 `1`을 반환 → `1 == (1,)` False로 실패. 픽스 후 `return (1,)`이라 튜플 반환 → 통과. 동작(런타임 반환값)을 직접 관찰하므로 단순 문자열 매칭보다 강한 증명.
- **overfit 관점:** 추가 단언이 1-원소 케이스 하나뿐이라 얇아 보이나, 픽스는 special-case 분기 추가가 아니라 구분자 식 자체를 일반화했다. 기존 `test_issue_14941`의 2-원소 tuple 단언(`f2(2,3)==(3,2)`)과 list 단언이 같은 테스트에 공존해 다-원소·다른 컨테이너 경로를 동시에 압박 → over-specialize한 가짜 픽스를 배제한다.
- **regression 관점:** 62개 P2P(`test_no_args`, `test_list_args`, `test_nested_args`, `test_lambdify_inspect` 등)가 list/tuple/중첩 출력 포맷 전반을 커버. tuple 닫음에 comma를 더해도 다-원소 튜플은 `(1, 2,)`로 여전히 유효하고 list 경로는 무변경이라 인접 포맷이 깨지지 않음.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈의 "Python code printer", `lambdify`, 그리고 기대 vs 실제 출력(`(1,)` → `(1)`)에서 출발. `lambdify.py`에서 튜플 문자열을 조립하는 곳을 grep("tuple", "iterable", "join")하면 `_recursive_to_string`로 수렴. 더 빠른 길은 hints의 bisect 커밋 6ccd2b07(#21993)을 `git show`해 이 함수가 새로 추가된 압축 구분자 코드임을 확인하는 것.
2. **픽스와 일반화 근거:** `left, right = "()"` 언팩이 trailing comma를 구조적으로 불가능하게 만든다는 점이 핵심 통찰. tuple 닫음을 `",)"`로 바꾸면 join 결과 길이와 무관하게 항상 comma가 들어가 1-원소든 다-원소든 유효한 튜플 리터럴이 된다. 1-원소만 특별 분기로 처리하는 것보다 구분자 식을 고치는 쪽이 올바른 일반화(special-case 누적 회피).
3. **regression 안전:** list 경로는 의미 무변경(`"[]"` 언팩 == `"[", "]"`)으로 유지해 `test_list_args`/`test_nested_args`를 보존. tuple 다-원소(`test_issue_14941`의 `f2(2,3)`)는 `(3, 2,)`로 여전히 통과. 62개 P2P가 전 출력 포맷을 지키는지 확인.
4. **함정 회피:** (a) `(1)`이 정수라는 파이썬 문법을 놓치고 "출력은 멀쩡해 보임"으로 오판 — 반드시 런타임 반환값(`==(1,)`)으로 검증할 것. (b) 1-원소만 `if len(arg)==1` 분기로 땜질하면 overfit이며 코드 복잡도만 증가 — 구분자 자체를 고쳐라. (c) list 닫음에 실수로 comma를 넣어 `[1,]`로 만들면(무해하나 불필요) 또는 다-원소 튜플에서 comma를 누락하면 안 됨. (d) Tuple(sympy 객체) 경로는 이미 정상이므로 건드리지 말 것 — 회귀 지점은 python tuple 출력에만 있다.
