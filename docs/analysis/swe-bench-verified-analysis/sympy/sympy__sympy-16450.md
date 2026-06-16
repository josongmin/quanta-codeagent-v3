---
instance_id: sympy__sympy-16450
repo: sympy/sympy
base_commit: aefdd023dc4f73c441953ed51f5f05a076f0862f
version: "1.5"
difficulty: "<15 min fix"
created_at: 2019-03-26T18:00:02Z
fail_to_pass: 1
pass_to_pass: 38
gold_files: [sympy/simplify/simplify.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap]
---

## 문제 요약
`posify(eq)`는 `positive`가 미정인 심볼을 `positive=True`인 `Dummy`로 치환하는데, 이 과정에서 원본 심볼이 가졌던 다른 가정(assumption)을 전부 버린다. 이슈 재현: `x = Symbol('x', finite=True)`를 posify하면 결과 더미의 `is_finite`가 `None`이 되어 유한성 가정이 소실된다. posify의 본래 역할은 "positive가 없을 때만 positive=True를 새로 추가"하는 것이므로, finite를 포함한 나머지 가정은 보존되어야 한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 `posify`라는 함수명을 직접 지목한다. `simplify.py` 내 `posify` 한 함수, 그중에서도 `Dummy(...)`를 만드는 단 한 줄로 즉시 수렴. grep 한 방.
- **S1 (+S2)**: dominant는 Direct-Map — 결함은 "원본 가정을 전달하지 않음"이고 픽스는 `Dummy(s.name, positive=True)` 생성자에 `**s.assumptions0`를 추가하는 기계적 인자 보강. 다만 "어떤 dict를 펼쳐 넘겨야 정확히 원본 가정을 복원하면서 positive 신규추가와 충돌하지 않나"를 알려면 sympy 가정시스템 지식이 필요해 S2가 보조로 붙는다.
- **K-Domain**: `assumptions0` vs `_assumptions`, `is_positive is None` 게이트, kwarg와 positive=True의 우선순위 등 sympy assumption 내부계약을 알아야 정확히 고친다. 일반 파이썬 추론만으로는 `assumptions0`이 올바른 소스라는 걸 못 짚는다.
- **primary = T-DirectMap**: 위치가 자명(L0)하고 픽스가 "생성자에 가정 dict를 펼쳐 전달"이라는 정형 패턴이라 T-DirectMap. APR 관점에서 이는 PAR/TBar식 템플릿 매칭(누락 인자 전달)에 해당하며, generate-&-validate 탐색이 필요 없다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 단일 파일·단일 함수·실질 1줄 수정, 이슈에 완전한 재현 트랜스크립트(`In[1]..Out[7]`)가 있어 localize 직접성 최상, 도메인지식은 가벼움(가정 dict 하나 펼치기). T1이 아닌 이유는 K-Gen이 아니라 K-Domain이고(`assumptions0`이 정답 소스라는 점이 도메인 지식), 정확한 가정 dict를 어떻게 넘길지 약한 추론(S2)이 끼기 때문. T3까지 가지 않는 이유는 cross-module 데이터플로우나 스펙 재구성이 전혀 없고 픽스 형태가 사실상 명세돼 있기 때문. 공식 라벨 "<15 min fix"와 일치한다. 단, PASS_TO_PASS 38개가 simplify 모듈 전반(`test_simplify_*`, `test_logcombine_*`, `test_nsimplify` 등)을 덮어 regression-trap이 존재한다.

## 골드패치 분석
- **파일·함수**: `sympy/simplify/simplify.py` 의 `posify(eq)`.
- **근본원인**: 더미 치환 매핑 생성부 `reps = {s: Dummy(s.name, positive=True) for s in eq.free_symbols if s.is_positive is None}`가 `positive=True`만 넣고 `s`의 기존 가정을 일절 옮기지 않음. 그래서 finite/integer/even 등 모든 사전가정이 더미 생성 시 누락된다.
- **수정요지**: `Dummy(s.name, positive=True, **s.assumptions0)` 로 변경. `s.assumptions0`(해당 심볼에 명시·도출된 전체 가정 dict)를 펼쳐 넘겨 원본 가정을 전부 복원하고, 그 위에 `positive=True`를 추가한다. 게이트 `if s.is_positive is None`이 그대로라 positive가 이미 정의된 심볼은 건드리지 않으므로 positive와 assumptions0의 충돌 가능성도 차단된다.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_posify`** (1개): `k = Symbol('k', finite=True)` 에 대해 `eq, rep = posify(k)` 후 `eq.assumptions0`가 `positive/real/finite/...` 등 13개 키를 가진 완전한 dict와 정확히 일치하는지 단언. 핵심은 `'finite': True`, `'infinite': False`가 보존됨을 확인하는 것.
- **픽스 증명**: 패치 전에는 finite가 None이라 `assumptions0`에 finite 키가 누락→dict 불일치로 실패. 패치 후 `**s.assumptions0`로 finite가 전달되고 positive=True가 파생가정(real, nonnegative, nonzero, complex 등)을 채워 기대 dict와 완전 일치.
- **overfit·regression 관점**: 단언이 전체 `assumptions0` dict를 통째로 비교하므로 특정 키 하나만 우회로 통과시키는 special-case 픽스로는 못 빠져나간다 — overfit 위험은 낮다(다만 finite 하나만 보존하는 좁은 픽스는 dict 전체불일치로 걸린다). regression 측은 38개 P2P가 simplify 전반을 덮어, 가정 dict 변경이 인접 simplify 동작(logcombine/nsimplify/separatevars 등)을 깨지 않음을 보장한다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈 제목 "Posify ignores is_finite assumptions" + 재현코드의 `posify(x)` → `grep posify simplify.py`로 함수 본문에 즉시 도달. 더미 생성부 `Dummy(s.name, positive=True)`가 원본 `s`의 가정을 안 옮긴다는 게 한눈에 보인다.
2. **픽스와 일반화**: `Dummy(s.name, positive=True, **s.assumptions0)`. finite 하나만 보존하는 게 아니라 `assumptions0` 전체를 펼쳐 integer/rational/even/odd 등 **모든** 사전가정을 일반적으로 보존한다 — 이슈 본문이 "다른 가정도 보존되어야"라고 요구한 바와 정확히 맞는 일반화. hardcode된 finite 처리(`if s.is_finite: ...`)는 overfit이며 이슈 의도에 못 미친다.
3. **regression 안전**: `if s.is_positive is None` 게이트를 유지해야 한다 — 이미 positive/negative가 정해진 심볼(예: docstring 예제의 `Symbol('p', positive=True)`, `Symbol('n', negative=True)`)은 치환 대상에서 제외되어야 기존 posify 예제와 38개 P2P가 안 깨진다. positive=True를 명시 인자로 두고 그 뒤에 `**assumptions0`을 펼쳐도 게이트 덕에 positive 키 중복충돌이 발생하지 않음.
4. **함정 회피**: (a) `_assumptions` 대신 `assumptions0`을 써야 한다 — `_assumptions`는 내부 캐시/도출본이라 더미 생성자 kwarg로 부적합; `assumptions0`이 공개 계약. (b) finite만 if-분기로 보존하면 테스트의 full-dict 단언과 이슈 의도(integer/even/odd...) 모두를 못 만족한다. (c) 게이트를 제거하고 무조건 치환하면 이미 positive=True인 심볼에 positive kwarg가 중복 전달되어 충돌/예외 위험 — 게이트는 손대지 말 것.
