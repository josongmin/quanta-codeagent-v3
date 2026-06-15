---
instance_id: django__django-11999
repo: django/django
base_commit: 84633905273fc916e3d17883810d9969c03f73c2
version: "3.1"
difficulty: 15 min - 1 hour
created_at: 2019-10-31T10:39:18Z
fail_to_pass: 1
pass_to_pass: 30
gold_files: [django/db/models/fields/__init__.py]
primary_type: T-DirectMap
tier: T3
loc_axis: L1
repair_strategy: S1 (+S5)
knowledge: K-Domain
flags: [has-repro, regression-trap, underspecified]
---

# django__django-11999

## 문제 요약
Django 2.2 이상에서 모델에 `get_FOO_display()` 메서드를 직접 정의해도 무시되고, 항상 choices 기반 자동생성 메서드가 호출된다. 이슈 예시에서 `foo_bar = CharField(choices=[(1,'foo'),(2,'bar')])`와 사용자 정의 `get_foo_bar_display()`(→`"something"`)를 함께 선언하면, 2.1에서는 `"something"`이 반환됐지만 2.2+에서는 choices 값(`'foo'`/`'bar'`)이 반환된다. hints에 따르면 regression 커밋(`a68ea231...`)이 원인이며, 다만 2.1의 "정상" 동작도 클래스 본문 속성 선언 순서에 의존하던 우연이었다. 기대 동작은 "사용자가 모델에 정의한 동명 메서드가 자동생성 메서드를 이긴다".

## 유형 (정형화)
- **L (Localization) = L1 (Traceable).** 이슈가 심볼을 직접 지목하진 않지만 `get_FIELD_display`/`choices`/"version 2.2"라는 강한 키워드 + hints에 regression 커밋 SHA(`a68ea231`)와 후속 티켓(#30254)까지 명시돼, `Field.contribute_to_class` 내 `partialmethod(cls._get_FIELD_display, ...)` 한 지점으로 빠르게 수렴한다. grep 한 방까지는 아니고 약한 추적 노력. 단일 파일·단일 함수.
- **S (Repair Strategy) = S1 Direct-Map (+S5 Spec-Inference).** 결함클래스가 "무조건 덮어쓰기(unconditional `setattr`) → 존재여부 가드 누락"이라는 정형 패턴이고, 픽스가 `if not hasattr(...)` 한 줄 가드로 기계적으로 매핑된다(S1). 결정적으로 hints의 마지막 댓글이 정답 코드를 거의 그대로 적어준다("Doesn't this fix it? `if not hasattr(...)`"). S5 보조: 의도된 스펙("사용자 메서드가 우선")은 코드만으로는 결정 불가 — 선언 순서 의존이라 어느 쪽이 "정답 동작"인지 이슈/메인테이너 토론에서 재구성해야 한다(Carlton Gibson이 "behaviour change지만 bugfix"로 의도를 확정해준 것이 스펙 소스).
- **K (Knowledge) = K-Domain.** `contribute_to_class` 기여 lifecycle, `ModelBase.__new__`의 `add_to_class` 순서, `_get_FIELD_display` partialmethod 자동생성 메커니즘 — django model field metaclass 내부 지식이 병목. 일반 파이썬 추론(K-Gen)으로는 "왜 선언 순서가 결과를 바꾸나"를 못 짚는다.
- **Primary = T-DirectMap.** 위치가 명확(L1)하고 픽스가 정형 가드(S1: presence-check 추가)로 기계적 매핑되는 게 dominant 축. T-DirectMap의 정의("위치 명확 + S1 기계적 픽스: 가드 추가")에 정확히 부합. T-SpecInference로 보기엔 스펙이 hints에서 이미 확정돼 추론 부담이 작고, T-DomainBound로 보기엔 도메인지식이 픽스 *형태*를 좌우하지 않고 *근본원인 이해*에만 필요해 dominant가 아니다.

## 난이도 티어
**T3 (중간).**
- 티어를 **올리는** 피처: (1) **localize가 자명하지 않음** — `_get_FIELD_display`(Model 메서드)를 고치는 오답 유혹이 존재하고, 진짜 지점인 `contribute_to_class`로 가려면 metaclass lifecycle 이해가 필요(L1, K-Domain). (2) **underspecified** — 이슈 본문만 보면 "2.1에선 됐는데"라 단순 regression revert로 오인하기 쉽고, 실제로는 2.1 동작도 buggy(순서 의존)였다는 점을 토론에서 읽어내야 한다. (3) **regression-trap** — P2P 30개 중 `test_choices_and_field_display`, `test_empty_iterator_choices`, `test_iterator_choices`, `test_get_FIELD_display_translated` 등 `get_FIELD_display` 자동생성에 직접 의존하는 인접 테스트가 다수라, "자동생성 자체를 끄거나 분기를 잘못 짜면" 줄줄이 깨진다.
- 티어를 **내리는** 피처: 단일 파일·실효 2줄·has-repro(이슈에 즉시 실행 가능한 재현 모델 + hints에 ipython 트랜스크립트)·hints가 정답 코드를 명시. 이것만 보면 T2에 가깝다.
- **공식 라벨("15 min - 1 hour")과의 정합.** 공식 시간라벨과 T3는 대체로 일치하나, 공식 라벨은 "개발자 구현시간"이라 *코드를 쓰는 데 걸리는 시간*만 잡는다. 에이전트 관점 난이도의 진짜 원천은 "(a) 잘못된 지점(`_get_FIELD_display`)을 안 고치기 (b) 단순 순서뒤집기 함정 회피 (c) 자동생성 의존 P2P를 안 깨기"인데, 이 셋이 시간라벨엔 안 잡힌다. 그래서 T2(쉬움)가 아니라 T3로 둔다 — 픽스 자체는 trivial하나 *오답에 빠지지 않는* 절제가 필요.

## 골드패치 분석
- **건드린 파일·함수:** `django/db/models/fields/__init__.py` → `Field.contribute_to_class`.
- **근본 원인:** `self.choices is not None`이면 **무조건**
  `setattr(cls, 'get_%s_display' % self.name, partialmethod(cls._get_FIELD_display, field=self))`
  를 실행했다. 필드가 클래스에 기여되는 `add_to_class` 시점이 사용자가 본문에 정의한 동명 메서드 처리보다 (선언 순서에 따라) 나중이면, 자동생성 partialmethod가 사용자 메서드를 덮어쓴다. 2.1에서 "되던" 것조차 선언 순서에 의존한 우연이었고, regression 커밋 `a68ea231`이 그 순서 우연을 깨뜨려 항상 덮어쓰게 만들었다.
- **수정 요지:** `setattr` 앞에 멱등 가드를 추가 —
  `if not hasattr(cls, 'get_%s_display' % self.name):` 일 때만 자동생성을 수행. 이미 클래스(또는 상위 클래스 상속분)에 `get_<name>_display`가 존재하면 건너뛰어 사용자 정의 메서드를 보존한다. 실효 2줄(+포매팅 줄바꿈). `setattr` 자체 로직·`_get_FIELD_display`는 불변.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_overriding_FIELD_display (model_fields.tests.GetFieldDisplayTests)`.
- **동작:** 테스트는 `foo_bar = IntegerField(choices=[(1,'foo'),(2,'bar')])`를 가진 `FooBar` 모델 안에 `get_foo_bar_display(self)`를 직접 구현해 `'something'`을 반환하게 하고, `FooBar(foo_bar=1).get_foo_bar_display() == 'something'`을 단언한다.
- **픽스 증명:** 픽스 전에는 choices 자동생성 partialmethod가 사용자 메서드를 덮어써 `'foo'`를 반환 → 실패. `hasattr` 가드 적용 후 사용자 메서드가 이미 존재하므로 자동생성을 건너뛰고 `'something'` 반환 → 통과. 가드가 동작의 직접 원인임이 입증된다.
- **overfit 관점:** FAIL_TO_PASS가 1개뿐이라 얇아 보이지만, 픽스가 special-case(`if field.name == 'foo_bar'` 류)가 아니라 일반 `hasattr` 가드라 overfit-risk는 낮다. 단 테스트는 "정의 순서(메서드가 필드 *뒤*)"라는 한 케이스만 커버하고, 메서드가 필드 *앞*에 선언된 경우나 상속된 오버라이드는 검증하지 않는다 → 입력공간 일부 미검증(약한 underspecified).
- **regression 관점:** P2P 30개에 `get_FIELD_display` 자동생성에 의존하는 케이스 다수(`test_choices_and_field_display`, `test_iterator_choices`, `test_empty_iterator_choices`, `test_get_FIELD_display_translated`). 가드는 "동명 메서드가 *없을 때만* 종전대로 자동생성"이라 이들 경로를 그대로 보존 → 회귀 없음. 만약 자동생성을 조건 없이 제거하거나 분기를 잘못 짰다면 이 P2P들이 깨진다(regression-trap 실재).

## 모범답안 (오라클 기반)
1. **Localize 경로:** 이슈의 신호 `get_FIELD_display` + `choices` + "version 2.2"로 codebase를 grep → `get_%s_display` 문자열 포매팅이 등장하는 단 한 곳, `Field.contribute_to_class`의 `partialmethod(cls._get_FIELD_display, field=self)` 자동생성 라인에 도달. hints의 regression 커밋 `a68ea231`이 결정적 확증 단서. 함정인 `Model._get_FIELD_display`(실제 값 lookup만 함)는 *생성*이 아니라 *조회*라 근본원인이 아님을 구분.
2. **픽스와 왜 올바른 일반화인가:** `setattr` 앞에 `if not hasattr(cls, 'get_%s_display' % self.name):` 가드. 이게 special-case가 아닌 올바른 일반화인 이유 — (a) 사용자가 *어떤 이름의* 필드/메서드를 정의했든 동작(이름 하드코딩 없음), (b) `hasattr`이 상속 체인까지 포함하므로 상위 클래스에서 오버라이드한 경우도 보존, (c) "사용자 명시 정의가 프레임워크 자동생성을 이긴다"는 일반 OOP 우선순위 원칙에 부합. 순서뒤집기(`contribute_to_class`에서 처리 순서 조정)는 pass/fail을 선언 순서에 따라 *반전*만 시키므로 unstable — 거부.
3. **Regression 안전:** 가드는 동명 메서드가 *없을 때* 기존 자동생성을 100% 보존하므로, choices 자동 display에 의존하는 P2P(`test_choices_and_field_display`, `test_iterator_choices`, `test_empty_iterator_choices`, translated display 등)는 모두 그대로 통과. `_get_FIELD_display`나 `setattr`의 내부 로직을 건드리지 않는 것이 회귀를 막는 핵심.
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (i) "2.1에선 됐으니 regression 커밋 revert"로 가면 순서 의존 버그를 부활시켜 다른 케이스를 깬다; 이슈를 "revert"가 아닌 "presence-guard"로 읽어야 한다. (ii) `Model._get_FIELD_display`에 `if field.attname == ...` 분기를 넣는 과복잡 오답(hints가 명시적으로 부적절하다 지적) — 이름 하드코딩 overfit. (iii) 자동생성을 무조건 끄면 30개 P2P가 붕괴. 회피법: "덮어쓰기 전 존재 검사"라는 최소 멱등 가드를 선택하고, `hasattr`이 상속까지 잡는다는 점을 근거로 분기 로직 확장을 절제할 것.
