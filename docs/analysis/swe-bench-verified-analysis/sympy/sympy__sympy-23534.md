---
instance_id: sympy__sympy-23534
repo: sympy/sympy
base_commit: 832c24fec1046eaa544a4cab4c69e3af3e651759
version: "1.11"
difficulty: "<15 min fix"
created_at: 2022-05-22T00:12:33Z
fail_to_pass: 1
pass_to_pass: 11
gold_files: [sympy/core/symbol.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L1
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

## 문제 요약
`symbols(('q:2', 'u:2'), cls=Function)` 처럼 입력에 **괄호 한 겹(tuple/iterable)**을 더 씌우면, `cls=Function`이 무시되고 결과가 `Function`이 아니라 `Symbol`로 생성된다. 괄호는 출력을 별도 tuple로 분해(deconstruct)하기 위해 필요하다. 기대값은 `UndefinedFunction`인데 실제로는 `Symbol`이 나온다. 단일 문자열 입력일 때는 정상 동작한다.

## 유형 (정형화)
- **L1 (Traceable)**: 진입점은 명백히 `symbols`. 단일-문자열 경로는 멀쩡하고 iterable 경로만 깨지므로, `symbols` 함수 안에서 "iterable이면 재귀" 처리하는 `else` 분기로 좁히면 끝. grep 한 방은 아니지만 후보는 단일파일·단일함수.
- **S1 (Direct-Map)**: 픽스는 기계적이다. 재귀호출 `symbols(name, **args)`가 `cls`를 전달하지 않아 기본값(`Symbol`)로 떨어지는 **인자 누락(forwarding bug)** — `cls=cls`만 끼워넣으면 된다. 추론 합성 불요.
- **K-Gen**: sympy 도메인 지식(assumptions/Function 내부) 불필요. "분기마다 같은 파라미터를 일관되게 전달해야 한다"는 일반 파이썬 추론으로 충분.
- **primary = T-DirectMap**: 위치가 좁고(L1) 결함이 정형 클래스(재귀 분기에서 키워드인자 drop)라 템플릿 매칭으로 직결. APR 관점에서 fault-localization만 끝나면 fix가 한 토큰(`cls=cls`)으로 결정되는 전형적 direct-map.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 1파일·1함수·1줄(헌크 1개), `has-repro`(이슈에 최소재현+기대/실제 출력 명시 → easiness 최강 신호), K-Gen, localize 직접성 중상(L1). 픽스 자체는 자명하나 T1이 아닌 이유는 두 가지 — (1) 정상 single-string 경로와 깨진 iterable 경로를 **대조**해 "왜 한쪽만 다른가"를 한 단계 따져야 하고, (2) `**args`가 이미 흐르는데 `cls`만 빠진 비대칭을 발견해야 해 이슈가 "픽스를 그대로 적어주는" T1보단 한 끗 더 든다. 공식 라벨 `<15 min fix`와 정합(T1/T2 모두 부합하나 비대칭 대조 한 스텝 때문에 T2).

## 골드패치 분석
- **파일·함수**: `sympy/core/symbol.py`의 `symbols()` 내부, 입력이 iterable(tuple/list)일 때 각 원소를 재귀 처리하는 `else` 분기.
- **근본원인**: 이 분기는 `for name in names: result.append(symbols(name, **args))`로 원소별 재귀하는데, `cls`는 `symbols(names, *, cls=Symbol, **args)` 시그니처에서 **별도 명시 파라미터**라 `**args`에 포함되지 않는다. 따라서 재귀 호출이 `cls`를 넘기지 못하고 안쪽 호출은 기본값 `Symbol`을 사용 → `Function`이 소실. 반면 단일-문자열 경로는 `cls(s, **args)`로 직접 `cls`를 닫아 정상이었다.
- **수정요지**: 재귀 호출에 `cls=cls`를 추가.
  ```python
  result.append(symbols(name, cls=cls, **args))
  ```
  iterable 중첩이 몇 겹이든 매 재귀에서 `cls`가 보존된다.

## 검증 (test_patch)
- **FAIL_TO_PASS** (`test_symbols`): `test_symbol.py`에 `from sympy.core.function import Function, UndefinedFunction` import 추가 후
  `assert type(symbols(('q:2', 'u:2'), cls=Function)[0][0]) == UndefinedFunction  # issue 23532`
  를 단언. 즉 (a) iterable 입력 + (b) `cls=Function` + (c) `:`-range 확장이 한 번에 걸린 케이스의 안쪽 원소가 `UndefinedFunction`(=`Function('q0')`의 metaclass)인지 확인. 패치 전엔 `Symbol`이라 실패, `cls=cls` 추가로 통과.
- **픽스 증명**: 단언이 `[0][0]`로 **중첩 tuple의 leaf**까지 내려가 보므로, 재귀 경로로 `cls`가 끝까지 전파됐음을 직접 관측. forwarding 수정의 효과를 정확히 겨냥.
- **overfit/regression 관점**: `regression-trap` 플래그 — 같은 `test_symbols`가 single-string/seq/literal/range 등 기존 단언을 다수 보유하고, P2P의 `test_symbols_become_functions_issue_3539`도 `cls=Function` 경로를 검증. `cls=cls`는 기존 정상경로의 인자흐름을 바꾸지 않아(누락분만 채움) 회귀 위험 낮음. overfit 위험은 작다 — 픽스가 테스트 입력에 특화된 special-case가 아니라 분기 전체의 파라미터 일관성을 복원하는 일반 수정.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 "괄호 한 겹 추가 시 `cls` 무시" + "single string은 정상"이 결정적 신호. `symbols` 함수로 진입해 입력 타입별 분기를 보면, `cls(s, **args)`로 `cls`를 직접 적용하는 정상 경로와, `symbols(name, **args)`로 재귀하는 iterable 경로가 대비된다. 후자에 `cls`가 빠진 비대칭이 곧 결함 지점.
2. **픽스와 일반화 근거**: 재귀 호출에 `cls=cls` 추가. `cls`는 키워드-only 명시 파라미터라 절대 `**args`에 안 실린다는 사실이 핵심 — 따라서 "args만 넘기면 되겠지"는 틀리고 명시적으로 닫아줘야 한다. 이는 특정 테스트값이 아니라 **모든 iterable/중첩 입력에서 cls 전파**를 보장하므로 올바른 일반화.
3. **regression 안전**: `test_symbols`의 기존 single/seq/range 단언과 `test_symbols_become_functions_issue_3539`(이미 `cls=Function` 사용)를 안 깨야 한다. `cls=cls`는 기존에 명시되던 `cls`와 동일 값을 재귀로 흘릴 뿐 정상경로 인자셋을 건드리지 않으므로 안전.
4. **함정 회피**: 오라클 없는 에이전트가 빠지기 쉬운 오답 — (a) `**args`에 `cls`가 들어있다고 가정해 "이미 전달됨"으로 오판하고 다른 곳을 고침; (b) iterable 경로 대신 단일-문자열 파싱부를 건드려 정상경로를 깨뜨림(regression). 피하는 법: `symbols`의 시그니처에서 `cls`가 별도 파라미터임을 확인하고, **깨진 경로(iterable 재귀)와 정상 경로(직접 `cls(s)`)의 인자흐름을 나란히 대조**해 누락분만 최소수정으로 채울 것.
