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
---

# django__django-14089

## 문제 요약
`django.utils.datastructures.OrderedSet`은 순서가 있는 집합인데도 Python 내장 `reversed()`에 인자로 넘길 수 없다. `OrderedSet`은 본래 순서를 보장하므로 역순 순회가 자연스럽게 기대되지만, `__reversed__()` 메서드가 없어 `reversed()` 호출이 `TypeError`로 실패한다. 사용자는 `__reversed__()`를 추가해 역순 순회를 지원해 달라고 요청했다.

## 유형 분류
- 버그 카테고리: 누락처리 (API-contract — reversible 프로토콜 미구현)
- 서브시스템: django core utils / datastructures
- 증상 타입: 예외 (`reversed(OrderedSet(...))` 호출 시 `TypeError: argument to reversed() must be a sequence`)
- 로컬라이제이션 신호: problem_statement가 클래스명(`OrderedSet`), 추가할 메서드명(`__reversed__()`), 그리고 링크로 파일 위치를 사실상 직접 지목한다. 거의 자명한 핀포인트.

## 골드패치 분석
- 건드린 파일/함수: `django/utils/datastructures.py` : `OrderedSet.__reversed__`
- 근본 원인: `OrderedSet`은 내부적으로 `self.dict`(insertion-order를 보존하는 `dict`)로 원소를 저장하고 `__iter__`는 `iter(self.dict)`를 반환한다. 하지만 `__reversed__`가 정의돼 있지 않아 reversible 프로토콜을 만족하지 못했다. `reversed()`는 `__reversed__` 없이 `__len__`+`__getitem__`(시퀀스 프로토콜)으로 폴백하는데 `OrderedSet`은 정수 인덱싱을 지원하지 않아 폴백도 불가능 → `TypeError`.
- 수정 요지: `__iter__` 바로 아래에 `__reversed__` 3줄을 추가. 내부 `self.dict`에 `reversed()`를 위임한다(`return reversed(self.dict)`). Python 3.8+ `dict`는 자체적으로 reversible하므로 키를 역삽입순으로 산출하는 이터레이터를 그대로 반환하면 된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_reversed (utils_tests.test_datastructures.OrderedSetTests)`
- 테스트가 어떻게 픽스를 증명하는지: `tests/utils_tests/test_datastructures.py`에 `test_reversed`를 추가하고 `collections.abc`를 import한다. `reversed(OrderedSet([1, 2, 3]))`를 호출해 (1) 반환값이 `collections.abc.Iterator`의 인스턴스인지(`assertIsInstance`)와 (2) `list(s) == [3, 2, 1]`로 실제 역순 산출 여부를 동시에 검증한다. 패치 전에는 `reversed()` 호출 자체가 `TypeError`를 내므로 RED, 패치 후 GREEN.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement가 클래스·메서드·파일을 사실상 다 알려준다. `OrderedSet` 클래스를 열어 `__iter__`/`__contains__` 인근에 `__reversed__`를 추가하면 끝.
- 함정/난이도 메모: 내부 저장소가 `set`이 아니라 insertion-order dict(`self.dict`)임을 파악해야 한다. `reversed(self.dict)`는 dict의 키 역순(=삽입 역순)을 주므로 의도와 일치한다. dict가 reversible해진 것은 Python 3.8부터이므로 베이스 런타임 가정만 충족하면 무난. 단일 파일·단일 메서드, 인접 코드 영향 없음.
- 우리 에이전트 관점: 막힐 지점이 거의 없는 자명한 추가. 위험은 과잉구현(원소 리스트를 직접 reverse하는 등 불필요한 로직)과, 반환값이 list가 아닌 iterator여야 한다는 테스트 계약(`assertIsInstance(..., Iterator)`)을 놓치는 것뿐. `reversed(self.dict)` 위임이 가장 간결하고 정답.
