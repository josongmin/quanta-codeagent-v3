---
instance_id: sympy__sympy-19346
repo: sympy/sympy
base_commit: 94fb720696f5f5d12bad8bc813699fd696afd2fb
version: "1.7"
difficulty: "15 min - 1 hour"
created_at: "2020-05-17T12:23:33Z"
fail_to_pass: 1
pass_to_pass: 40
gold_files: [sympy/printing/repr.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro]
---

## 문제 요약
`srepr`는 `list`와 `tuple`의 원소는 재귀적으로 올바르게 출력하지만(`[Symbol('x'), Symbol('y')]`), `dict`와 `set`은 잘못 출력한다(`{x: y}`, `{x, y}` — 원소가 `repr`로 안 떨어지고 기본 `str`로 새어나옴). 이슈 본문이 정확히 어떤 컨테이너 타입이 빠졌는지를 지목하고, list/tuple이 어떻게 처리되는지 대조 예시까지 제공한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 "list/tuple은 되는데 dict/set이 안 된다"고 직접 대조한다. `ReprPrinter`에 이미 `_print_list`/`_print_tuple`이 있고 `_print_dict`/`_print_set`만 누락 — grep 한 방으로 수렴.
- **S1 (Direct-Map)**: 결함 클래스가 "기존 dispatch 패턴에 빠진 case 추가". list 핸들러를 그대로 본떠 dict/set 핸들러를 기계적으로 작성하면 끝. 새 식·불변식 추론 없음.
- **K-Domain**: SymPy printer dispatch 메커니즘(`Printer._print` 메서드명 규약, `reprify`/`doprint` 헬퍼)을 알아야 한다. 일반 파이썬 지식만으론 "왜 `_print_dict`라는 이름인가"를 못 맞춘다.
- **primary = T-DirectMap**: 위치가 자명(L0)하고 픽스가 기존 템플릿(`_print_list`) 복제라는 기계적 매핑(S1)이므로 ConstraintReason이 아니라 DirectMap. APR 관점에서 PAR/TBar식 패턴-기반 수리("같은 클래스의 인접 핸들러를 missing case로 복제")가 정확히 들어맞는다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처:
- 파일 1개(`sympy/printing/repr.py`), 헌크 1개, 추가 약 10줄.
- localize 직접성 최상(L0) — 이슈가 누락 타입 2개를 명시.
- has-repro: 본문에 그대로 실행 가능한 재현 스니펫.
- P2P trap 약함: 40개 P2P 중 `test_list`/`test_tuple`/`test_Matrix` 등은 **별도 핸들러**라 신규 메서드 추가가 건드리지 않는다(순수 additive).
- 도메인 지식이 K-Gen이 아니라 K-Domain이라 T1은 아님. 공식 라벨 "15 min - 1 hour"와 일치 — additive 한 줄짜리 신규 핸들러라 구현시간 짧음.

## 골드패치 분석
- **파일/함수**: `sympy/printing/repr.py`, `ReprPrinter` 클래스에 `_print_dict`, `_print_set` 두 메서드 신규 추가(`_print_list` 바로 아래).
- **근본원인**: `srepr`는 `ReprPrinter._print(expr)`가 `type(expr).__name__`으로 dispatch한다. `dict`/`set`에 대응하는 `_print_dict`/`_print_set`가 없어 `Printer`의 fallback(`emptyPrinter` → 객체 기본 `str`/`repr`)으로 떨어지고, 그 결과 컨테이너 원소가 재귀적 `srepr` 처리를 못 받아 `Symbol('x')`가 아니라 `x`로 출력됐다.
- **수정요지**: 
  - `_print_dict`: `expr.items()`를 돌며 key/value 각각 `self.doprint(...)`로 재귀 출력, `"{%s}"` 안에 `", "`로 join.
  - `_print_set`: 빈 집합은 리터럴 `"set()"`(파이썬 `{}`는 dict이라 모호) 특수처리, 그 외엔 `self.reprify(expr, ", ")`로 list 핸들러와 동일 헬퍼 재사용 후 `"{%s}"`로 감쌈.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_dict`** (1개): 빈 dict `{}`, 단일쌍 `{x: y}`, 이중쌍(순서 비결정이라 두 순열 모두 허용), 그리고 중첩 `{x: {y: z}}`까지 검사 — 재귀 doprint가 실제로 작동함을 중첩 케이스가 증명한다.
- test_patch는 `test_set`도 추가하나 FAIL_TO_PASS 배열에는 `test_dict`만 들어있다. 픽스 증명의 핵심은 `srepr({x: y}) == "{Symbol('x'): Symbol('y')}"`로 원소가 `repr` 형태로 떨어지는 것.
- **overfit 관점**: 중첩 dict와 빈 dict까지 커버해 special-case 통과 여지가 작다. 다만 set의 빈/비빈 분기는 `test_set`이 보지만 F2P에 없어, 엄밀히 F2P만 보면 `set()` 분기는 under-tested(경미한 overfit-risk이나 골드가 이미 올바르게 처리).
- **regression 관점**: 신규 메서드 2개 추가이므로 기존 `_print_list`/`_print_tuple`/`_print_MatrixBase` 등 40개 P2P 경로를 byte-identical로 보존. 충돌 없음.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 "list/tuple OK, dict/set wrong"이라고 대조하므로 → `printing/repr.py`에서 `_print_list`를 grep → 같은 클래스에 `_print_dict`/`_print_set`가 없음을 확인. 이게 곧 누락 dispatch라는 결론.
2. **픽스와 일반화**: `_print_list`의 패턴(`reprify` + format string)을 복제하되, dict는 key/value를 **둘 다** `doprint`로 재귀해야 함(한쪽만 하면 새는 버그 재발). 이는 컨테이너 원소를 항상 재귀 출력한다는 printer의 일반 계약을 따르는 것이라 overfit이 아니다.
3. **regression 안전**: 신규 메서드만 추가하고 기존 핸들러·`reprify`·`doprint`는 손대지 않아야 `test_list`/`test_tuple`/`test_Matrix` 등 40 P2P가 안 깨진다. 헬퍼 재사용(`reprify`)이 일관성과 안전성을 동시에 확보.
4. **함정 회피**: 빈 `set()`을 `{}`로 출력하면 dict와 충돌하므로 반드시 리터럴 `"set()"`로 특수처리해야 한다 — 오라클 없는 에이전트가 이 분기를 빠뜨리기 쉽다. 또 dict value 쪽 `doprint`를 누락해 key만 재귀하는 half-fix도 흔한 함정인데, 중첩 케이스(`{x: {y: z}}`)가 이를 잡아낸다.
