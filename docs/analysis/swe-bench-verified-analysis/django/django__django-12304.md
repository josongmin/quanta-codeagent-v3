---
instance_id: django__django-12304
repo: django/django
base_commit: 4c1b401e8250f9f520b3c7dc369554477ce8b15a
version: 3.1
difficulty: <15 min fix
created_at: 2020-01-09T15:43:51Z
fail_to_pass: 1
pass_to_pass: 17
gold_files: [django/db/models/enums.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S5)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-12304

## 문제 요약
Django 3.0에서 도입된 enumeration 타입(`models.IntegerChoices` / `models.TextChoices`)을 Django 템플릿에서 쓸 수 없다. `{% if student.year_in_school == YearInSchool.FRESHMAN %}` 같은 표현을 쓰면, Django 템플릿 변수 해석기는 lookup 대상이 callable이면 인자 없이 자동 호출하는데, `YearInSchool`(클래스/Enum)이 callable이라 빈 인자로 호출되어 필수 `value` 인자 누락으로 실패한다. 사용자는 enum 멤버와 그 `.label`/`.value`를 템플릿에서 그냥 참조할 수 있길 기대했고, 이슈 본문이 직접 해결책("declare `do_not_call_in_templates = True` on the various Choices classes")까지 명시한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: 이슈 본문이 서브시스템(enumeration types), 인과("being callable, Django Templates always call callables with no arguments"), 그리고 속성명 `do_not_call_in_templates`까지 직접 지목한다. `django.db.models.enums`의 Choices 메타클래스가 grep 한 방에 나온다 — localize 비용 사실상 0.
- **S (Repair Strategy) = S1 Direct-Map (+S5 Spec-Inference)**: 이슈가 픽스를 거의 명세하므로 dominant는 S1(기계적: 속성 플래그 1개 추가). 단 "어느 객체에 붙이느냐"(메타클래스가 만드는 `cls` vs 개별 멤버 인스턴스)는 Django 템플릿 변수 해석 규약(`Variable._resolve_lookup`이 callable에 대해 `do_not_call_in_templates`를 검사하는 계약)에서 스펙을 재구성해야 정확히 도출되므로 보조로 S5. APR 관점: 이건 PAR/TBar식 정형 결함(누락 플래그/속성 추가) 템플릿 매칭이지, 식·조건을 추론 합성하는 S2도 후보 반복하는 S3도 아니다.
- **K (Knowledge) = K-Domain**: 정답 한 줄 자체는 단순하나, "왜 호출되는가"를 이해하려면 Django 템플릿 엔진의 callable auto-call 규약과 그 escape hatch(`do_not_call_in_templates`)라는 프레임워크 내부 지식이 병목이다. 순수 일반 파이썬 추론으로는 이 속성을 발명할 수 없다.
- **primary type = T-DirectMap**: 위치가 명확(L0)하고 픽스가 S1 기계적 플래그 추가다. 이슈가 픽스를 적어주지만 K-Domain 메커니즘 이해가 끼어 있어 완전한 T-LocTrivial(L0+S1, K-Gen)보다는 T-DirectMap이 정확하다.

## 난이도 티어
**T2 (쉬움).** 이 티어로 미는 구조적 피처: 단일 파일(`django/db/models/enums.py`) 1헌크 1줄 추가, `has-repro`(이슈가 실패하는 템플릿 코드 스니펫을 그대로 제공) — 가장 강한 easiness 신호, L0 직접 localize, S1 기계적 픽스. 공식 라벨도 `<15 min fix`로 일치한다.
- 단, T1(존나쉬움)으로 내리지 않은 이유: T1 프로파일은 L0+S1에 **K-Gen**을 요구하는데, 이 문제는 템플릿 auto-call 규약과 부착 대상(클래스 vs 멤버)이라는 K-Domain 함정 + 17개 PASS_TO_PASS를 안 깨야 하는 `regression-trap`이 얹혀 있다. 메타클래스 `cls`가 아니라 개별 멤버에만 플래그를 붙이면 클래스 참조 비교가 여전히 깨지고, enum 핵심 동작(`__contains__`, `_value2label_map_`, label property) 회귀로 P2P가 무너질 수 있다. 그래서 T1이 아니라 T2.
- 공식 difficulty(`<15 min fix`)와 tier(T2)는 모순 없음 — 이 케이스는 시간라벨과 구조난이도가 정렬되는 전형이다.

## 골드패치 분석
- **건드린 파일·함수**: `django/db/models/enums.py` → `ChoicesMeta.__new__` (Choices Enum 메타클래스).
- **근본 원인**: Django 템플릿 변수 해석기(`Variable._resolve_lookup`)는 lookup 결과가 callable이고 `do_not_call_in_templates`가 truthy가 아니면 무인자로 자동 호출한다. Enum 클래스(`Suit`)와 그 functional-call 시그니처는 callable이라 `{{ Suit.DIAMOND }}` 해석 과정에서 호출이 트리거되고, `IntegerChoices`/`TextChoices`의 enum 생성자가 필수 인자를 못 받아 깨진다.
- **수정 요지**: 메타클래스 `__new__`에서 생성되는 클래스에 `cls.do_not_call_in_templates = True` 한 줄을 부여. `cls.label = property(...)` 설정 직후, `return enum.unique(cls)` 직전에 삽입된다. 이 플래그가 클래스 객체에 붙으면 템플릿 엔진이 enum을 호출하지 않고 객체 자체로 다뤄, `.label`/`.value` 속성 접근과 `==` 비교가 정상화된다. 메타클래스에 붙였기 때문에 모든 `Choices` 서브클래스가 자동 상속한다("on the various Choices classes" 한 번에 충족).

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `test_templates (model_enums.tests.ChoicesTests)`. `Template('{{ Suit.DIAMOND.label }}|{{ Suit.DIAMOND.value }}')`를 `Context({'Suit': Suit})`로 렌더 → 기대 출력 `'Diamond|1'`.
- **픽스 증명**: 패치 전엔 `Suit.DIAMOND` 해석 시 enum이 무인자 호출되어 렌더가 실패/오작동. 패치 후엔 `do_not_call_in_templates=True` 덕에 멤버 객체가 보존되어 `.label`='Diamond', `.value`=1이 출력된다. 테스트가 실제 템플릿 엔진(`Context`/`Template`)을 통과시키므로 escape-hatch 규약이 end-to-end로 관찰된다.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇지만, 정답이 special-case 코드가 아니라 메커니즘 차원의 단일 플래그라 CEGIS식 과소명세 함정은 약하다. `do_not_call_in_templates` 외에 이 테스트를 통과시킬 "꼼수"는 사실상 없어 overfit 위험 낮음(`overfit-risk` 미부여).
- **regression 관점**: `regression-trap` 부여. PASS_TO_PASS 17개가 `IntegerChoices`/`TextChoices`/`CustomChoices`의 containment, auto_label, empty_label, functional_api, `__str__`, 유효성(`test_invalid_definition`), 미지원 타입 거부(bool/timezone/uuid) 등 enum 핵심 동작 전반을 커버한다. 플래그를 멤버 인스턴스에 잘못 붙이거나 `__new__` 흐름(특히 `enum.unique(cls)` 반환)을 건드리면 이들이 깨진다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 신호 "being callable" + "Django Templates always call callables with no arguments" + 명시된 속성명 `do_not_call_in_templates` → `do_not_call_in_templates`를 코드베이스 grep하면 (a) 소비처 `django/template/base.py`의 `Variable._resolve_lookup`(callable 호출 전 이 속성 검사), (b) 부재처 `django/db/models/enums.py`의 `ChoicesMeta`가 드러난다. enum을 정의하는 단일 chokepoint = 메타클래스 `__new__`로 수렴.
2. **픽스(올바른 일반화인 이유)**: `cls.do_not_call_in_templates = True`를 메타클래스가 생성하는 **클래스 객체**(`cls`)에 부여. 멤버가 아니라 클래스에 붙여야 `Suit`(클래스) 참조와 `Suit.DIAMOND`(멤버) 참조 양쪽에서 auto-call이 억제된다. 메타클래스에 한 줄 = 모든 Choices 서브클래스가 상속 → "various Choices classes" 전부 커버. 이는 special-case가 아니라 Django가 공식 제공하는 escape-hatch 계약을 enum 타입에 일관 적용한 것이라 올바른 일반화다.
3. **regression 안전**: `__new__`의 기존 흐름(`_value2label_map_`, `cls.label` property, `enum.unique(cls)` 반환)을 건드리지 않고 플래그 한 줄만 추가하므로 P2P 17개(containment/label/functional_api/str/invalid-definition/unsupported-type)가 모두 보존된다. 추가 속성은 enum 의미론에 중립이다.
4. **함정 회피**: 오라클 없는 에이전트의 오답 경로 — (a) 단서를 못 읽고 `student.year_in_school == ...` **비교 로직**이나 model field 쪽을 의심(엉뚱한 파일). (b) `do_not_call_in_templates`를 **개별 멤버 인스턴스**나 멤버 메타에 붙여 클래스 참조 비교가 여전히 깨짐. (c) 템플릿 엔진(`base.py`) 쪽을 고쳐 모든 callable의 auto-call을 끄는 과잉 수정 → 광범위 회귀. 회피법: "메타클래스 `cls`에 부여 = 클래스+멤버 동시 커버 + 전 서브클래스 상속"이라는 부착 지점 한 가지만 정확히 짚으면 끝.
