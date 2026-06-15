---
instance_id: django__django-11964
repo: django/django
base_commit: fc2b1cc926e34041953738e58fa6ad3053059b22
version: 3.1
difficulty: <15 min fix
created_at: 2019-10-23T14:16:45Z
fail_to_pass: 2
pass_to_pass: 15
gold_files: [django/db/models/enums.py]
---

# django__django-11964

## 문제 요약
`TextChoices`/`IntegerChoices`로 정의한 enum 값을 모델 필드(CharField/IntegerField)에 갓 저장한 인스턴스에서 읽으면, 그 값이 순수 `str`/`int`가 아니라 enum 멤버 객체로 남아 있다. 그래서 `str(my_object.my_str_value)`가 `"first"`가 아니라 `"MyChoice.FIRST_CHOICE"`로 렌더된다. DB에서 다시 읽어온 인스턴스는 정상적으로 `"first"`가 되어, 생성 직후 vs 재조회 간 타입/문자열 표현이 불일치한다. 외부 API로 갓 만든 인스턴스를 보낼 때 엉뚱한 값(`MyEnum.MyValue`)이 나가는 실질적 버그.

## 유형 분류
- 버그 카테고리: API-contract (객체의 `__str__` 계약 위반) / edge-case (생성 직후 vs 재조회 표현 불일치)
- 서브시스템: django ORM model enumeration types (`django.db.models.enums`)
- 증상 타입: silent-wrong (예외 없이 잘못된 문자열 표현)
- 로컬라이제이션 신호: problem_statement가 `TextChoices`/`IntegerChoices`를 직접 지목하고, hints가 `<MyChoice.FIRST_CHOICE: 'first'>` 형태의 enum repr이 `__dict__`에 들어 있다고 명시 → enum 정의 모듈 `enums.py`로 직결.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/enums.py` → `class Choices`에 `__str__` 추가
- 근본 원인: `Choices`는 `enum.Enum`을 상속하는데, `enum.Enum`의 기본 `__str__`은 `"<ClassName>.<MEMBER>"`(예: `MyChoice.FIRST_CHOICE`)를 반환한다. `IntegerChoices(int, Choices)`/`TextChoices(str, Choices)`는 값 타입을 섞었지만 문자열화는 여전히 Enum 기본 동작을 타서, 캐스팅 시 멤버 이름 표현이 새어 나온다.
- 수정 요지: `Choices`에 `def __str__(self): return str(self.value)`를 정의해, 어떤 컨텍스트(템플릿, `str()` 캐스팅 등)에서든 멤버 이름이 아니라 실제 값(`"first"`, `"1"`)으로 렌더되게 한다. 기존 `pass` 본문을 이 메서드로 교체. 단 5줄짜리 최소 수정.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_str` (신규) + `test_textchoices` (str 표현이 값으로 바뀌어 기존 단언 갱신).
- 신규 `test_str`은 `Gender, Suit, YearInSchool, Vehicle` 네 enum을 순회하며 각 멤버에 대해 `str(test[member.name]) == str(member.value)`를 단언한다. 즉 enum 멤버를 문자열화하면 멤버 이름이 아니라 그 값의 문자열이어야 한다는 것을 직접 증명한다. 픽스 전에는 `str(member)`가 `"Gender.MALE"` 같은 값을 내서 실패, 픽스 후 `str(self.value)`로 통과.

## 공략 포인트 (뭘 조져야)
- 어디부터: `django/db/models/enums.py`의 `Choices`/`IntegerChoices`/`TextChoices` 클래스 정의. enum 기본 `__str__`이 문제임을 인지하면 한 줄.
- 함정/난이도: (1) 표면 증상이 "모델 필드에서 값을 읽으면 타입이 다르다"라 ORM descriptor/필드 getter 쪽(`fields/__init__.py`, deferred loading)을 의심하기 쉬우나, 진짜 수정점은 enum의 `__str__`. 재조회 인스턴스는 DB 직렬화를 거쳐 순수 값이 되므로 ORM 경로는 손대지 않는다. (2) `__str__`만 고치고 실제 값 타입(`isinstance`)은 그대로 둔다 — golden은 `__str__` 표현만 정정하지 값 객체 자체를 언래핑하지 않는다. 멀티파일 아님(단일 파일).
- 우리 에이전트 관점: problem_statement의 `assertIsInstance(..., str)` 단언에 끌려 "필드 getter에서 enum을 언래핑해야 한다"는 과한 수정으로 빠질 위험이 크다. 실제 golden은 그 isinstance 측면은 건드리지 않고 `__str__`만 정정하므로, 증상 문구(타입)와 실제 수용 테스트(`str()` 표현)의 괴리를 분별해 최소 변경에 수렴하는 것이 관건.
