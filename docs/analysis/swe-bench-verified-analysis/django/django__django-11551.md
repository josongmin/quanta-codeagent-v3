---
instance_id: django__django-11551
repo: django/django
base_commit: 7991111af12056ec9a856f35935d273526338c1f
version: 3.0
difficulty: 15 min - 1 hour
created_at: 2019-07-09T22:28:45Z
fail_to_pass: 1
pass_to_pass: 119
gold_files: [django/contrib/admin/checks.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-11551

## 문제 요약
ModelAdmin의 `list_display`에 "인스턴스를 통해서만 접근 가능한" 필드(예: django-positions의 `PositionField`)를 넣으면, Django 2.2.1부터 시작 시점 시스템 체크(`_check_list_display_item`)가 잘못된 `admin.E108`을 던져 앱 기동이 막힌다. 2.0.7에서는 정상 동작하던 설정이다. 근본 원인은 ticket 28490 수정 커밋 47016adbf54b가 도입한 회귀: `PositionField`의 디스크립터 `__get__`은 클래스(인스턴스 아님)에서 호출되면 `AttributeError`를 던지므로 `hasattr(obj.model, item)`이 False가 되고, 그 결과 정작 유효한 필드인데도 `get_field(item)`을 시도조차 못 하고 E108로 떨어진다. 이슈 본문은 `hasattr × get_field × field-None × M2M` 4변수의 12행 진리표와 정답 코드 블록까지 통째로 제시한다.

## 유형 (정형화)

**L (Localization) = L0 — Pinpointed.** problem_statement가 `django.admin.contrib.checks._check_list_display`, 정확한 메서드 `_check_list_display_item`, 회귀 유발 커밋 47016adbf54b, 에러 ID `admin.E108`/`E109`를 모두 직접 지목한다. grep 한 방으로 단일 함수에 도달한다. 탐색 비용은 사실상 0.

**S (Repair Strategy) = S2 (+S6) — Constraint-Reasoning + 소규모 Design-Refactor.** 고칠 위치는 자명하지만 픽스는 단순 한 줄 가드가 아니다. `hasattr`/`get_field 성공·실패`/`field is None`/`ManyToManyField 여부` 4개 조건의 12행 진리표 전부에서 올바른 반환(`[]`/E108/E109)을 만족하는 **제어흐름을 추론으로 합성**해야 한다(S2). 동시에 "None 변수로 케이스를 신호하던" 안티패턴을 제거하고 `try get_field → except FieldDoesNotExist: try getattr → except AttributeError: E108`의 예외-주도 구조로 분기 순서를 재배치하는 소규모 구조 변경이 수반된다(S6). 단순 G&V(테스트 돌려보며 후보 교체)로는 진리표의 raise+M2M 같은 희소 행을 놓치기 쉬워 S2/S6가 dominant.

**K (Knowledge) = K-Domain.** Django 디스크립터 프로토콜(`__get__`이 클래스 접근 시 raise → `hasattr` False), `Model._meta.get_field` vs `getattr(model, item)`의 의미 차이, `ManyToManyField` 검출, E108/E109 시스템 체크 계약을 정확히 알아야 한다. 일반 파이썬 추론만으로는 왜 `hasattr` 선검사가 틀렸는지 도달하기 어렵다.

**Primary type = T-ConstraintReason.** 위치는 명확(L0)하나 난점이 "올바른 분기 조건·순서를 진리표 불변식으로부터 합성"하는 데 있으므로 T-ConstraintReason. T-DirectMap이 아닌 이유: 기계적 None-가드/상수변경이 아니라 다중 조건 불변식 추론이 본질. T-DomainBound도 아님: 도메인 지식은 필요조건이지 병목 그 자체는 아니고, 핵심 작업은 조건 합성.

## 난이도 티어
**Tier = T4 (약간 어려움).** 공식 라벨은 "15 min - 1 hour"(≈T3 prior)지만 T4로 상향한다.

T4로 미는 구조적 피처:
- **S2+S6 결합**: 단일 함수지만 4변수 12행 진리표를 만족하는 제어흐름 재설계가 필요 — 가벼운 엣지추론(T2/T3)을 넘는 실질 constraint-reasoning.
- **넓은 regression-trap**: PASS_TO_PASS 119개 중 같은 `ListDisplayTests`/`ListDisplayLinksCheckTests`의 E108/E109/valid 케이스가 다수. 분기 순서를 잘못 잡으면 인접 동작이 무더기로 깨진다(루브릭의 "넓은 P2P trap → T4" 컷).
- **함정성**: 수정이 한 줄로 보이는 착시(아래 함정 회피 참조)가 강함.

T5로 가지 않는 이유: 단일 파일·단일 함수(L0), patch가 ~30줄·1헌크로 scope가 작고, **has-repro**(이슈에 진리표+완성된 정답 코드 블록 제공)라는 강한 easiness 신호가 있다. overfit 위험도 낮다(아래). 공식 라벨보다 높은 건 시간라벨이 "분기 추론의 미묘함 + 넓은 P2P trap"을 포착하지 못하기 때문.

## 골드패치 분석
- **건드린 파일·함수**: `django/contrib/admin/checks.py` → `ModelAdmin._check_list_display_item` 단 하나(1헌크).
- **근본 원인**: 회귀 커밋 47016adb가 `elif hasattr(obj.model, item):` 선분기를 도입. `PositionField` 같은 디스크립터는 `__get__(instance=None)`에서 `AttributeError`를 던져 `hasattr(obj.model, item)`가 False가 되는데, 기존 로직은 이 False를 곧장 "필드 없음 → E108"로 conflation 했다. 즉 `get_field(item)`이 멀쩡히 필드를 반환할 수 있는데도 시도조차 하지 않았다. 또한 raise 케이스에서 M2M 검사를 빠뜨리는 부수 버그도 존재.
- **수정 요지**: `hasattr` 선분기를 제거. 먼저 `field = obj.model._meta.get_field(item)`을 시도하고, `FieldDoesNotExist`면 그제서야 `field = getattr(obj.model, item)`을 시도, 그것마저 `AttributeError`면 E108을 반환한다. 둘 중 하나로 field를 확보하면 `isinstance(field, models.ManyToManyField)`로 E109 또는 `[]`(유효)를 반환. "field is None으로 케이스를 신호"하던 모호함을 제거하고, 실패 사유를 그 사유가 발생하는 `except` 블록 안에 가둬 진리표 12행을 전부 충족시킨다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `test_valid_field_accessible_via_instance (modeladmin.test_checks.ListDisplayTests)`.
- **픽스 증명 메커니즘**: 테스트는 `Field`를 상속한 `PositionField`를 정의하되 `contribute_to_class`로 자신을 클래스 속성에 심고, `__get__(instance, owner)`에서 `instance is None`이면 `AttributeError`를 던지도록 한다 — 이것이 바로 "클래스 접근 시 hasattr=False"인 실제 버그 조건을 최소 재현한다. 이 필드를 `list_display = ('field',)`에 넣고 `assertIsValid`로 **검증 에러 0개**를 단언. 픽스 전: `hasattr` False → `get_field` 미시도 → E108 오탐 → 실패. 픽스 후: `get_field('field')`가 정상 필드 반환 → `[]` → 통과.
- **overfit 관점**: F2P는 1개로 얇지만 special-case 통과 위험은 낮다. 골드 수정이 진리표 전체를 재구성하는 일반적 제어흐름이고, 픽스가 `try get_field`를 무조건 먼저 시도하는 구조라 테스트의 특정 필드명/타입에 결합되지 않는다. 따라서 overfit-risk 플래그는 부여하지 않음.
- **regression 관점**: regression-trap 플래그. 119개 P2P가 같은 체크 함수군의 정상/E108/E109 경로를 광범위하게 커버한다(`test_missing_field`, `test_invalid_field_type`, `test_valid_case` 등). 분기 순서를 틀리면 이 인접 동작들이 깨져 즉시 잡힌다 — 강한 정확성 그물.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 함수명 `_check_list_display_item`, 파일 `django/contrib/admin/checks.py`, 회귀 커밋 47016adb, 에러 ID E108/E109를 명시 → grep `_check_list_display_item`으로 즉시 단일 함수 진입. 커밋 47016adb의 diff를 보면 무엇이 추가됐는지(=`hasattr` 선분기) 바로 보인다.

2. **픽스와 올바른 일반화인 이유**: `hasattr(obj.model, item)` 분기를 제거하고 `get_field`를 항상 먼저 시도 → 실패 시 `getattr` → 둘 다 실패 시에만 E108. 이것이 올바른 일반화인 이유는, 버그가 특정 라이브러리(`PositionField`)가 아니라 "디스크립터가 클래스 접근에서 raise하는 모든 필드"라는 **구조적 클래스**를 잘못 배제했기 때문이다. 픽스는 그 클래스 전체를 `get_field`로 우선 구제하므로 테스트의 합성 필드뿐 아니라 동치 행동의 임의 필드에 일반화된다. 실패 사유를 발생 지점의 `except`에 가두는 설계가 None-signal 안티패턴이 만든 케이스 혼선을 원천 제거한다.

3. **regression 안전**: 같은 함수의 정상 경로(`test_valid_case`), 실제 누락 필드 E108(`test_missing_field`), M2M 거부 E109, 그리고 `ListDisplayLinks`/`Ordering` 등 119개 P2P를 깨지 말아야 한다. 핵심은 **분기 순서 보존**: get_field 성공 → M2M 검사 → `[]`, get_field 실패 & getattr 성공 → M2M 검사, 둘 다 실패 → E108. M2M 검사가 두 경로 모두에서 일어나도록 `isinstance` 검사를 try/except 밖 공통 위치로 빼는 것이 raise+M2M 행까지 살린다.

4. **함정 회피**: 오라클 없는 에이전트가 빠질 함정은 "한 줄 픽스 착시" — `hasattr(obj.model, item)`을 그냥 `try: getattr ... except` 로 감싸는 최소 수정. 이는 `get_field` 성공 케이스를 여전히 후순위로 두거나 raise 경로의 M2M 검사를 누락해 진리표 일부 행(예: get_field raises + M2M, 또는 hasattr False + get_field ok)을 틀린다. 회피법: 픽스 작성 전에 이슈의 12행 진리표를 명세로 받아들이고, get_field를 **무조건 1순위**로 두며 M2M 검사를 분기 합류점으로 끌어올린 뒤, 작성한 분기를 진리표 각 행에 손으로 대조한다. 이슈가 정답 코드 블록을 제공하므로 이를 충실히 반영하되, 인접 E108/E109 P2P로 즉시 회귀 검증하는 것이 안전.
