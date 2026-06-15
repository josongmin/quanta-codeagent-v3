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
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [has-repro, regression-trap, overfit-risk]
---

# django__django-11964

## 문제 요약
`TextChoices`/`IntegerChoices`로 정의한 enum 값을 모델 필드(CharField/IntegerField)에 갓 저장한 인스턴스에서 읽으면, 그 값이 순수 `str`/`int`가 아니라 enum 멤버 객체로 남아 있다. 그래서 `str(my_object.my_str_value)`가 `"first"`가 아니라 `"MyChoice.FIRST_CHOICE"`로 렌더된다. DB에서 다시 읽어온 인스턴스는 직렬화를 거쳐 순수 값(`"first"`)이 되므로, 생성 직후 vs 재조회 간 문자열 표현이 불일치한다. 외부 API로 갓 만든 인스턴스를 보낼 때 엉뚱한 값(`MyEnum.MyValue`)이 나가는 실질적 버그. 이슈에 재현 모델·테스트·실제 트레이스백(`AssertionError: 'MyChoice.FIRST_CHOICE' != 'first'`)이 첨부됨.

## 유형 (정형화)
- **L (Localization) = L1**: problem_statement가 `TextChoices`/`IntegerChoices`를 직접 호명하고 hints가 `<MyChoice.FIRST_CHOICE: 'first'>` 형태의 enum repr이 `__dict__`에 들어 있음을 적시한다. 다만 표면 증상은 "모델 필드 getter가 잘못된 타입을 준다"라 ORM 필드/descriptor 경로(`fields/__init__.py`, deferred loading)로 오인할 여지가 있어 L0(grep 한 방)는 아니다. 실수정점인 `django/db/models/enums.py`의 `Choices` 계층으로 수렴하려면 한 단계의 추적(증상→Enum 기본 `__str__`)이 필요 → L1.
- **S (Strategy) = S2 (+S5)**: 고칠 메서드(`Choices.__str__`)는 좁게 특정되지만, 픽스의 내용은 "올바른 동작이 무엇인가"를 추론·재구성하는 데 있다. enum 멤버의 정수/문자 캐스팅과 표준 `str()` 표현 사이의 불변식("값으로 렌더되어야 한다")을 따져 `return str(self.value)`를 합성해야 하므로 constraint-reasoning(S2)이 dominant. 동시에 "의도된 동작"은 코드만으론 결정되지 않고 이슈 본문·django의 choices 계약("필드 값처럼 행동해야 한다")에서 스펙을 재구성해야 하므로 S5 보조.
- **K (Knowledge) = K-Domain**: 순수 파이썬 추론만으론 `MyChoice(int, Choices)`가 왜 mixed-in 값 타입을 가지면서도 `Enum.__str__`을 타는지, 재조회 시 왜 순수 값이 되는지(ORM 직렬화 경로)를 알기 어렵다. django enums + Enum 메타클래스 도메인 지식이 병목이라 K-Domain.
- **Primary = T-DomainBound**: 위치는 한 단계 추적으로 잡히고 픽스도 짧지만, "ORM getter가 아니라 Enum의 문자열 계약이 진범"이라는 분별과 mixed-in Enum 의미론 이해가 본질적 난점이다. 따라서 K-Domain이 dominant한 T-DomainBound. (S2가 강하나 그 추론을 가능케 하는 게 도메인지식이라 T-ConstraintReason보다 T-DomainBound가 방어적.)

## 난이도 티어
**T3 (중간).** 구조적 피처:
- 파일수 1개, 변경 ~6줄(메서드 1개 추가) — scope는 T1/T2급으로 작다.
- `has-repro`(완전한 재현 모델+네이티브 트레이스백)는 강한 easiness 신호.
- 그러나 **localize 직접성이 함정**: 증상이 "필드 값 타입"이라 ORM 필드/descriptor를 의심하게 만드는 mislead가 있어 L1이며, 진짜 수정점이 enum의 `__str__`이라는 통찰에 도메인지식이 든다.
- `regression-trap`: PASS_TO_PASS 15개가 `IntegerChoices`/`TextChoices`의 label/containment/empty/functional-api/auto-label 등 인접 동작을 광범위하게 검증한다. `__str__`을 잘못 정의하면(예: 값+label 합성, 또는 `IntegerChoices`에서 int mix-in의 `__str__`을 깸) 이들이 깨질 수 있다.
- `overfit-risk`: 증상 문구가 `assertIsInstance(..., str)`(타입)인데 수용 테스트는 `str()` *표현*만 본다 — 타입 언래핑으로 과수정하면 표면 충족·오라클 불일치.

**공식 라벨(<15 min fix)과의 차이**: 공식은 "정답을 아는 개발자의 구현시간"이라 6줄짜리라 <15분이 맞다. 하지만 에이전트 관점에선 (a) ORM 오인 localize 함정 (b) 증상(타입) vs 테스트(표현)의 괴리로 인한 과수정 유혹 (c) mixed-in Enum 의미론이라는 도메인 장벽이 시간라벨에 안 잡힌다. 이 인과 피처들이 T1/T2를 넘어 T3로 민다.

## 골드패치 분석
- **건드린 파일·함수**: `django/db/models/enums.py` → `class Choices(enum.Enum, metaclass=ChoicesMeta)`의 본문 `pass`를 `__str__` 메서드로 교체.
- **근본 원인**: `Choices`는 `enum.Enum`을 상속한다. `enum.Enum`의 기본 `__str__`은 `"<ClassName>.<MEMBER>"`(예: `MyChoice.FIRST_CHOICE`)를 반환한다. `IntegerChoices(int, Choices)`/`TextChoices(str, Choices)`는 값 타입을 믹스인했지만 `Enum`이 `__str__`을 정의해 두기 때문에 믹스인 타입(int/str)의 `__str__`이 아니라 Enum의 멤버-이름 표현이 우선한다. 그래서 갓 생성한(아직 DB 직렬화 안 거친) 인스턴스를 `str()`/템플릿으로 렌더하면 멤버 이름이 새어 나온다. 재조회 인스턴스는 DB write/read를 거치며 순수 값으로 변환돼 정상이라, 생성/재조회 표현이 갈린다.
- **수정 요지**: `Choices`에 `def __str__(self): return str(self.value)`를 정의. 이로써 모든 `Choices` 서브클래스(Integer/Text 포함)에서 문자열화가 멤버 이름이 아니라 실제 값(`"first"`, `"1"`)으로 렌더된다. 값 객체 자체(`isinstance`/타입)는 손대지 않고 **표현(`__str__`)만** 정정하는 최소 변경.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**: `test_str`(신규) + `test_textchoices`(기존, str 표현 기대값이 멤버이름→값으로 바뀌어 갱신·재통과).
- **픽스 증명**: 신규 `test_str`은 `Gender, Suit, YearInSchool, Vehicle` 네 enum을 순회하며 각 멤버에 대해 `str(test[member.name]) == str(member.value)`를 단언한다. 즉 "멤버를 문자열화하면 멤버 이름(`"Gender.MALE"`)이 아니라 그 값의 문자열이어야 한다"를 직접 증명. 픽스 전엔 Enum 기본 `__str__`이 `"Gender.MALE"`을 내 실패, 픽스 후 `str(self.value)`로 통과한다.
- **overfit 관점**: 테스트가 `str()` 표현만 단언하고 `isinstance`는 안 본다. 따라서 "필드 getter에서 enum을 언래핑해 순수 타입으로 만든다"는 더 무거운 수정도 표면 통과시킬 수 있어 `overfit-risk`. 하지만 그 방향은 (a) gold보다 침습적이고 (b) 재조회와의 *타입* 일치까지 보장하려다 ORM 경로를 광범위하게 건드려 P2P를 깰 위험이 크다.
- **regression 관점**: PASS_TO_PASS 15개가 Integer/Text choices의 label·containment·empty·auto-label·functional-api를 검증. `__str__`을 값+label 합성이나 repr-스타일로 잘못 정의하면, 또는 `IntegerChoices`에서 int 믹스인 동작에 의존하는 단언이 있으면 깨진다. gold의 `return str(self.value)`는 라벨·containment·정의 검증과 직교하므로 이들을 보존한다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 증상은 "필드 getter가 enum을 준다"지만, hints의 `<MyChoice.FIRST_CHOICE: 'first'>` repr과 트레이스백 `'MyChoice.FIRST_CHOICE' != 'first'`가 핵심 신호다. 이는 ORM 값 변환 버그가 아니라 **객체의 문자열 표현** 문제임을 가리킨다(재조회는 멀쩡 → 값 자체는 올바르고 표현만 틀림). 따라서 ORM 필드 경로가 아니라 `TextChoices`/`IntegerChoices`의 정의 모듈 `django/db/models/enums.py`, 그 공통 베이스 `Choices`로 직행한다.
2. **픽스와 일반화 정당성**: `Choices`에 `__str__`을 정의해 `str(self.value)`를 반환한다. 베이스 `Choices`에 단다는 점이 올바른 일반화의 핵심 — Integer/Text/커스텀 믹스인 모든 서브클래스가 동일 계약("값처럼 렌더")을 상속한다. 특정 서브클래스나 특정 테스트 enum에만 거는 것은 overfit. 값 *표현*만 고치고 *타입*은 건드리지 않는 것이, 이슈가 호소한 "외부 API로 엉뚱한 값 송신" 문제(표현 문제)를 정확히 해소하면서 기존 mixed-in 값 의미론을 보존하는 최소·정확 일반화다.
3. **regression 안전**: PASS_TO_PASS의 `test_integerchoices*`, `test_textchoices_*`(label/containment/empty/auto-label/functional-api)와 `CustomChoicesTests`(bool/timezone/uuid unsupported)를 깨면 안 된다. `__str__`만 추가하고 라벨 계산·멤버십·값 타입에 손대지 않으므로 이들과 직교 → 안전. `IntegerChoices`의 int 믹스인 산술/동등성은 `__str__` 변경과 무관하게 유지된다.
4. **함정 회피**: 오라클 없는 에이전트의 주된 오답은 (a) 증상 문구 `assertIsInstance(..., str)`에 끌려 "필드 getter에서 enum을 언래핑"하는 ORM 수정으로 빠지는 것 — 이는 P2P 광역 파손·overfit. (b) `__str__` 대신 `__repr__`을 고치거나, 값+label을 합성해 라벨 테스트를 깨는 것. (c) `Choices` 베이스가 아니라 Integer/Text 각각에 따로 정의해 커스텀 믹스인 케이스를 누락하는 것. 회피법: "재조회는 정상"이라는 단서로 *값이 아니라 표현*이 진범임을 못박고, 공통 베이스 `Choices.__str__`에 `str(self.value)` 한 메서드만 추가하는 최소 변경에 수렴한다.
