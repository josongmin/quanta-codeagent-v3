---
instance_id: django__django-14089
repo: django/django
base_commit: d01709aae21de9cd2565b9c52f32732ea28a2d98
version: "4.0"
difficulty: <15 min fix
created_at: 2021-03-06T20:51:08Z
fail_to_pass: 1
pass_to_pass: 43
gold_files: [django/utils/datastructures.py]
primary_type: T-DirectMap
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-API
flags: [has-repro]
---

# django__django-14089

## 문제 요약
`django.utils.datastructures.OrderedSet`은 순서가 있는 집합인데도 Python 내장 `reversed()`에 인자로 넘길 수 없다. `OrderedSet`은 본래 삽입순서를 보장하므로 역순 순회가 자연스럽게 기대되지만, `__reversed__()` 메서드(reversible 프로토콜)가 없어 `reversed(OrderedSet(...))` 호출이 `TypeError`로 실패한다. 이슈는 클래스명·추가할 메서드명을 명시하며 "`__reversed__()`를 추가하면 straightforward하게 된다"고 픽스 방향까지 적시한다.

## 유형 (정형화)

**L (Localization) = L0 (Pinpointed).**
problem_statement가 클래스(`OrderedSet`), 추가할 메서드(`__reversed__()`), 그리고 소스 링크로 파일 위치(`django/utils/datastructures.py`)를 직접 지목한다. `grep OrderedSet` 한 방이면 끝. 후보 탐색이 사실상 없다.

**S (Repair Strategy) = S1 (Direct-Map / template).**
이슈가 픽스를 거의 명세한다 — "missing dunder protocol" 정형 결함클래스에 템플릿 매칭으로 바로 대응된다(`__iter__`가 `iter(self.dict)`를 위임하듯 `__reversed__`는 `reversed(self.dict)`를 위임). 추론으로 조건식을 합성(S2)할 일도, 여러 후보 중 테스트로 고를(S3/S4) 일도 없다. 결함 자체가 "메서드 부재"이고 픽스가 "대칭 메서드 추가"라 기계적이다.

**K (Knowledge) = K-API (API-contract).**
일반 파이썬 추론만으로도 `__reversed__` 추가는 떠올릴 수 있으나, 정확히 올바른 픽스가 되려면 두 가지 계약 지식이 필요하다: (1) Python의 reversible 프로토콜 계약 — `reversed()`는 `__reversed__`가 없으면 `__len__`+`__getitem__` 시퀀스 폴백을 시도하고, `OrderedSet`은 정수 인덱싱이 없어 폴백도 실패한다. (2) Python 3.8+에서 내장 `dict`가 자체 reversible(키를 삽입 역순으로 산출)이라는 API 계약. 이 둘을 알아야 `reversed(self.dict)` 위임이 list 사본 없이 올바른 iterator를 준다는 것이 보장된다. django 내부 도메인지식(ORM/migrations 등)은 불필요하므로 K-Domain은 아니다.

**Primary type = T-DirectMap.** 위치가 명확(L0)하고 픽스가 S1 기계적 추가(누락 dunder 보충)다. 찾으면 끝나고 픽스가 자명에 가까우나, "이슈가 픽스를 거의 적어줄" 만큼 자명한 T-LocTrivial보다는 reversible 프로토콜/dict reversibility라는 가벼운 API 계약 매핑이 끼어 T-DirectMap이 더 정확하다.

## 난이도 티어

**Tier = T1 (존나쉬움).** 공식 라벨 `<15 min fix`와 일치한다.

이 티어로 미는 구조적 피처:
- **수정 범위 최소**: 단일 파일(`gold_files` 1개), 단일 메서드, 순 추가 3줄(`+3/-0`). ICLR 2024의 "1파일·<5줄 ≈ 48% solve" 구간 한참 안쪽.
- **localize 직접성 = L0**: 이슈가 클래스·메서드·파일을 다 지목 → localization 에러(실패의 ~51%) 여지가 거의 없음.
- **has-repro 신호**: 이슈가 `reversed(OrderedSet(...))`라는 한 줄 재현을 사실상 제시(가장 강한 easiness 신호).
- **P2P trap 없음**: 순 추가라 기존 동작을 건드리지 않음 → 43개 PASS_TO_PASS 회귀 위험 미미.
- **도메인지식 얕음**: K-API이긴 하나 깊은 프레임워크 내부지식이 아니라 표준 파이썬 프로토콜 계약 수준.

공식 difficulty 라벨과 본 티어 평가는 어긋나지 않는다(둘 다 최저난이도). T1은 "이슈가 픽스를 거의 적어주는" 구간이고 본 문제가 정확히 그렇다.

## 골드패치 분석
- **건드린 파일/함수**: `django/utils/datastructures.py` : `OrderedSet.__reversed__` (신규 메서드).
- **근본 원인**: `OrderedSet`은 내부적으로 `self.dict`(insertion-order를 보존하는 `dict`)로 원소를 저장하고 `__iter__`는 `iter(self.dict)`를 반환한다. 그러나 `__reversed__`가 정의돼 있지 않아 reversible 프로토콜을 만족하지 못한다. `reversed()`는 `__reversed__`가 없으면 시퀀스 프로토콜(`__len__`+`__getitem__`)로 폴백하는데, `OrderedSet`은 정수 인덱싱(`__getitem__`)을 지원하지 않아 폴백도 불가능 → `TypeError`.
- **수정 요지**: `__iter__` 바로 아래(`__contains__` 위)에 `__reversed__` 메서드를 추가하고 내부 `self.dict`에 위임한다:
  ```python
  def __reversed__(self):
      return reversed(self.dict)
  ```
  Python 3.8+ `dict`는 자체 reversible하므로 키를 삽입 역순으로 산출하는 iterator를 그대로 반환한다. `__iter__`가 `iter(self.dict)`를 위임하는 것과 정확히 대칭이라 정순/역순 일관성이 보장된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_reversed (utils_tests.test_datastructures.OrderedSetTests)`.
- **픽스 증명**: `tests/utils_tests/test_datastructures.py`에 `import collections.abc`를 추가하고 `test_reversed`를 넣는다. `reversed(OrderedSet([1, 2, 3]))`를 호출해 두 가지를 동시에 단언한다 — (1) `assertIsInstance(s, collections.abc.Iterator)`로 반환값이 list가 아닌 **iterator**임을, (2) `assertEqual(list(s), [3, 2, 1])`로 실제 역순(삽입 역순) 산출을. 패치 전에는 `reversed()` 호출 자체가 `TypeError`라 RED, 패치 후 GREEN.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇지만, 테스트가 타입계약(Iterator)과 값계약([3,2,1])을 둘 다 잡아 special-case 우회를 막는다. `reversed(self.dict)` 위임은 입력 원소에 독립적인 일반해라 이 테스트 너머로도 올바르게 일반화된다(overfit-risk 플래그는 부여하지 않음).
- **regression 관점**: 순 추가이므로 기존 메서드 동작 불변. 43개 PASS_TO_PASS(같은 모듈의 `OrderedSetTests`·`MultiValueDictTests`·`CaseInsensitiveMappingTests` 등) 모두 영향 없음. `__getitem__`을 추가해 시퀀스로 만드는 식의 침습적 풀이가 아니라 dunder 한 개만 더해 regression 표면을 0에 가깝게 유지한다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 클래스명 `OrderedSet`, 메서드명 `__reversed__`, 파일 링크를 직접 준다 → `django/utils/datastructures.py`의 `OrderedSet` 클래스를 열고 `__iter__`/`__contains__` 인근을 본다. 추가 탐색 불필요(L0).

2. **픽스와 올바른 일반화 이유**: `__iter__`가 `return iter(self.dict)`로 내부 dict에 위임하는 패턴을 그대로 따라 `def __reversed__(self): return reversed(self.dict)`를 추가한다. 이것이 overfit이 아닌 일반해인 이유: `self.dict`는 삽입순서 dict이고 Python 3.8+에서 reversible하므로, 위임 결과는 임의 원소 집합에 대해 항상 "삽입 역순 iterator"를 산출한다 — 테스트의 [1,2,3] 입력에 종속된 로직이 전혀 없다. 정순(`__iter__`)과 동일한 출처(`self.dict`)에 위임하므로 정순/역순 대칭성도 자동 보장.

3. **regression 안전**: 깨면 안 되는 P2P는 같은 모듈의 기존 동작 — 특히 `OrderedSetTests`의 `test_bool/test_contains/test_discard/test_init_with_iterable/test_len/test_remove`와 `MultiValueDict`/`CaseInsensitiveMapping`/`ImmutableList` 테스트들. 순 추가(`+3/-0`)라 기존 메서드 시그니처·동작을 일절 건드리지 않으므로 안전하다. `__getitem__` 추가 같은 시퀀스화는 인덱싱 의미를 새로 도입해 regression 표면을 키우므로 회피한다.

4. **함정 회피**: 오라클 없는 에이전트가 틀릴 수 있는 지점 — (a) 내부 저장소를 `set`으로 오인해 "set은 순서가 없다"며 원소 리스트를 만들어 직접 reverse하는 과잉구현(불필요 사본 + 의도와 무관). 실제 저장소가 insertion-order `self.dict`임을 먼저 확인해야 한다. (b) `reversed(list(self.dict))`처럼 list 사본을 거쳐 반환하면 `list`나 `list_reverseiterator`가 되어도 우연히 테스트는 통과할 수 있으나, `reversed(self.dict)` 직접 위임이 가장 간결하고 dict 고유 reverse iterator를 그대로 노출하는 정답이다. (c) 테스트가 반환형을 `collections.abc.Iterator`로 단언하므로 list를 그대로 반환하면 RED — "iterator를 반환해야 한다"는 계약을 놓치지 말 것.
