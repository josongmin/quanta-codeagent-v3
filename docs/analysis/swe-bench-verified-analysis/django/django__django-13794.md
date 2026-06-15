---
instance_id: django__django-13794
repo: django/django
base_commit: fe886eee36be8022f34cfe59aa61ff1c21fe01d9
version: 3.2
difficulty: <15 min fix
created_at: 2020-12-19T20:09:34Z
fail_to_pass: 3
pass_to_pass: 24
gold_files: [django/utils/functional.py]
primary_type: T-DirectMap
tier: T3
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-13794

## 문제 요약
템플릿의 `add` 필터로 일반 문자열과 lazy string(`gettext_lazy` 결과)을 이어붙이면 결과가 항상 빈 문자열이 된다. 내부적으로 `str + __proxy__` 연산이 `TypeError: can only concatenate str (not "__proxy__") to str`를 던지고, `add` 필터가 예외를 삼켜 빈 문자열을 반환하기 때문이다. 사용자는 `'string' | add:lazy('lazy')`가 `'stringlazy'`로 정상 연결되길 기대한다. 이슈 본문에 정확한 예외 메시지(`"__proxy__"` 타입명 포함)가 적혀 있어 재현/지목 신호가 강하다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** 이슈 본문의 예외 메시지가 `"__proxy__"` 타입을 그대로 노출한다. `__proxy__`는 `django/utils/functional.py`의 `lazy()` 팩토리가 동적으로 생성하는 프록시 클래스명이므로 `grep "__proxy__"` 또는 `grep "def lazy"` 한 방으로 단일 파일·단일 클래스에 도달한다. 후보 분기 없음.
- **S (Repair Strategy) = S1 Direct-Map (+S2 Constraint-Reasoning).** 결함 클래스가 "누락된 연산자 dunder"로 정형화된다 — 인접 메서드 `__mod__`가 이미 `self.__cast() % rhs` 위임 템플릿을 보여주므로, 같은 템플릿을 `__add__`로 복제하는 기계적 매핑이 본질(S1). 다만 단순 복제로 끝나지 않고 **좌변이 str일 때 우변 폴백이 필요**하다는 파이썬 연산자 디스패치 의미론을 추론해 `__radd__`까지 짝으로 추가해야 정확하므로 보조로 S2가 붙는다.
- **K (Knowledge) = K-Domain.** django `lazy`/`__proxy__` 위임 메커니즘과 `__cast()` 평가 시점 규약을 알아야 "필터를 고치는 표면 수정"이 아니라 "프록시에 연산자를 위임하는 일반 수정"으로 수렴한다. 순수 일반 파이썬만으로는 `add` 필터의 try/except를 손대는 오답에 빠지기 쉽다.
- **primary type = T-DirectMap.** 위치가 명확(L0)하고 픽스가 정형 결함(누락 dunder)에 대한 템플릿 매핑(S1)이라는 점이 dominant. T-ConstraintReason이 아닌 이유: 올바른 *식*을 추론으로 합성하는 게 핵심이 아니라(이미 옆에 패턴이 있음), 빠진 메서드를 채워넣는 매핑이 핵심이기 때문. T-DomainBound도 아닌 이유: 도메인 지식이 병목이라기보다 **localize가 자명한 상태에서 패턴 복제**가 주작업이라서(K-Domain은 오답 회피용 보조 신호).

왜 이 strategy인가(APR 관점): PAR/TBar류 template-based repair의 교과서 케이스다. "missing magic-method 위임"이라는 fix pattern이 동일 클래스 내 `__mod__`/`__str__` 선례로 이미 제공되므로, 패치 합성은 선례 패턴을 새 연산자에 인스턴스화하는 것으로 환원된다. 단, 패턴을 `__add__` 하나로만 인스턴스화하면 commutative-position(우변 str) 케이스를 놓치는 부분명세가 발생 — 이 지점에서 S2(연산자 디스패치 불변식 추론)가 개입해 `__radd__` 짝을 강제한다.

## 난이도 티어
**T3 (중간).** 공식 라벨은 `<15 min fix`(T1~T2 prior)지만 T3로 상향한다.

이 티어로 미는 구조적 피처:
- 파일/줄수는 T1~T2급(1파일, +6줄, 단일 헌크). localize 직접성도 L0로 매우 높음 → 하향 압력.
- 그러나 **`__radd__` 짝 누락 트랩**이 있다. `__add__`만 추가하면 `test_add08`(str|add:lazy, 좌변이 str → 우변 `__radd__` 폴백 필요)이 여전히 실패한다. 픽스가 "두 메서드의 조율된 한 쌍"이어야 정답이라는 점이 단순 one-liner 가드 추가(T1/T2)와 구분된다.
- **K-Domain 의존**: `add` 필터를 고치는 표면 오답으로 새는 경로가 명확히 존재(이슈가 "add filter"를 제목에 내세움 → 잘못된 localize 유인). 올바른 수정 지점이 필터가 아니라 프록시라는 판단에 도메인 이해가 필요.
- has-repro(정확한 예외 메시지)는 강한 easiness 신호라 T4까지 올리진 않음. P2P 24개는 lazy/cached_property/add 필터 전반을 커버하는 회귀 그물이지만 골드가 순수 additive(기존 메서드 미변경)라 regression-trap의 실질 압력은 중간.

종합하면 "localize는 쉬우나 픽스의 정확성(operator pair + 올바른 수정 지점)에 약한 추론·도메인 게이트가 있는" 전형적 T3. 공식 시간라벨과의 차이는 라벨이 *숙련 django 개발자의 구현시간*만 재고 에이전트의 **잘못된 수정 지점 유인**과 **dunder 짝 누락 함정**을 반영하지 못하기 때문.

## 골드패치 분석
- **건드린 파일·함수**: `django/utils/functional.py` — `lazy()` 내부에 동적 정의되는 `__proxy__` 클래스. 정확히 `__mod__` 정의 직후, `__deepcopy__` 직전에 두 메서드 삽입.
- **근본 원인**: `__proxy__`는 실제 평가값으로의 위임을 dunder 단위로 opt-in 한다(`__str__`, `__mod__` 등만 구현). `__add__`/`__radd__`가 없어서 `str + __proxy__`(좌변 str) 시 `str.__add__`가 `__proxy__`를 거부(`NotImplemented`) → 파이썬이 우변의 `__proxy__.__radd__`로 폴백하려 하나 그것도 미정의 → `TypeError`. `add` 템플릿 필터는 이 예외를 try/except로 삼키고 빈 문자열을 반환하므로 사용자에게는 "조용히 빈 출력"으로 보인다.
- **수정 요지**: 두 연산자를 위임 패턴으로 추가.
  - `__add__(self, other)`: `return self.__cast() + other` — 프록시를 먼저 실제 타입(str/int…)으로 캐스팅한 뒤 덧셈.
  - `__radd__(self, other)`: `return other + self.__cast()` — 프록시가 우변일 때 좌변 실제값과의 덧셈 지원.
  - `__cast()`는 평가 시점에 실제 타입을 산출하므로 문자열 연결과 숫자 덧셈을 동시에 만족(타입 비종속 일반화).

## 검증 (test_patch)
- **FAIL_TO_PASS 동작(정확히 3개)**:
  - `test_lazy_add` (utils_tests.test_functional.FunctionalTests): `lazy(lambda: 4, int)() + lazy(lambda: 5, int)()` == `9` — proxy+proxy 정수 덧셈 (`__add__` 경로, str 아닌 타입에서도 동작 증명).
  - `test_add08` (template_tests.filter_tests.test_add.AddTests): `{{ s1|add:lazy_s2 }}` → `'stringlazy'` — **좌변 str + 우변 lazy = `__radd__` 경로**. `__add__`만 추가했다면 여기서 실패.
  - `test_add09` (...AddTests): `{{ lazy_s1|add:lazy_s2 }}` → `'stringlazy'` — lazy+lazy.
- **픽스 증명**: 픽스 전 `add` 필터는 `TypeError`를 만나 빈 문자열을 렌더링. `__add__`/`__radd__` 추가 후 양변을 캐스팅해 정상 연결/덧셈. 세 테스트가 `__add__`-only / `__radd__` / 두-lazy 경로를 각각 커버해 operator-pair 완전성을 강제한다.
- **overfit 관점**: FAIL_TO_PASS가 3개지만 좌변·우변·동시 lazy의 3 디스패치 경로를 분리 커버하므로, `add` 필터 try/except에 `str()` 강제를 넣는 special-case 오답은 `test_lazy_add`(int 덧셈, 필터 무관) 때문에 통과 못 한다 → overfit 방어력 양호. 그래도 FAIL_TO_PASS가 얇은 편이라 `overfit-risk`까지 달지는 않되 주의.
- **regression 관점**: 골드는 순수 additive(기존 dunder 미변경)라 P2P 24개(`test_add01~07`, `test_lazy*`, `cached_property*`, `classproperty*`)를 깰 표면이 거의 없음. `regression-trap` 플래그는 P2P 광범위(lazy 전반)라 형식상 표기하되 실질 위험은 낮음.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈 예외 메시지의 `"__proxy__"` 타입명 → `grep -rn "__proxy__\|def lazy" django/utils/functional.py`로 `lazy()` 내부 `__proxy__` 클래스에 직행. 제목의 "add filter"에 낚여 `django/template/defaultfilters.py`의 `add`를 고치지 말 것 — 그쪽은 예외를 *삼킬 뿐* 원인이 아님(예외 메시지가 가리키는 타입이 프록시임을 우선시).
2. **픽스와 일반화 근거**: `__proxy__`에 `__add__`(=`self.__cast() + other`)와 `__radd__`(=`other + self.__cast()`) 한 쌍을 추가. `__cast()`로 평가 시점 실제 타입을 얻으므로 str 연결뿐 아니라 int 덧셈까지 자동 일반화된다 — 이것이 "필터에서 str() 강제"같은 특정 시나리오 hack보다 올바른 이유. 인접 `__mod__`의 `self.__cast() % rhs` 위임 패턴을 읽으면 동일 관용구로 자연 수렴.
3. **regression 안전**: 두 메서드는 신규 추가(additive)라 기존 `__str__`/`__mod__`/`cached_property`/`classproperty` 동작 불변 → P2P 24개 안전. 기존 메서드 시그니처·캐스팅 규약을 건드리지 않는다.
4. **함정 회피**: (a) **수정 지점 오인** — "add filter" 제목에 끌려 필터 try/except를 손대면 `test_lazy_add`(필터를 안 거치는 순수 `lazy()+lazy()`)에서 실패. 예외 타입 `__proxy__`를 신뢰해 프록시를 고쳐라. (b) **dunder 짝 누락** — `__add__`만 추가하면 좌변이 str인 `test_add08`이 우변 폴백 `__radd__` 부재로 실패. 파이썬 연산자 디스패치(좌변이 `NotImplemented` 반환 시 우변 reflected dunder 호출)를 인지해 `__radd__`를 반드시 짝으로 추가할 것.
