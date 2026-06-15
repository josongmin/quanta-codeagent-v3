---
instance_id: django__django-7530
repo: django/django
base_commit: f8fab6f90233c7114d642dfe01a4e6d4cb14ee7d
version: 1.11
difficulty: 15 min - 1 hour
created_at: 2016-11-08T17:27:19Z
fail_to_pass: 1
pass_to_pass: 59
gold_files: [django/core/management/commands/makemigrations.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
---

# django__django-7530

## 문제 요약
`makemigrations`의 마이그레이션 이력 일관성 검사(consistency check) 단계에서 `router.allow_migrate()`를 호출할 때, 각 앱(`app_label`)에 대해 **그 앱이 실제 소유한 모델만**이 아니라 **프로젝트 전체의 모든 모델**을 짝지어 호출하고 있었다. 즉 `(app_label, model_name)` 조합이 잘못 생성된다. 그 결과 샤드마다 모델 구성이 다른 라우터(보고자의 use-case)에서는 존재하지 않는 (앱, 모델) 조합이 넘어와 라우터가 깨졌다. 보고자는 ticket:27200#comment:14를 인용하며, 각 앱에 대해 해당 앱이 실제로 가진 모델만 전달되기를 기대했다.

## 유형 (정형화)
- **L1 (Traceable)** — problem_statement가 `makemigrations` / `router.allow_migrate()` / "consistency checks"를 명시해 `django/core/management/commands/makemigrations.py`의 일관성 검사 루프로 좁게 수렴한다. 단, 정확한 라인(어떤 모델-순회 표현식이 틀렸는지)은 `Apps.get_models` API 의미를 알아야 짚히므로 L0(grep 한 방, 심볼 직접지목)는 아니다. → **L1**.
- **S2 (Constraint-Reasoning) +S1** — 고칠 지점은 좁혀지지만, 픽스가 자명한 가드/상수 추가가 아니라 "`app_label`마다 그 앱 모델만"이라는 **불변식**(전달 인자 쌍 ⊆ 해당 앱 소유 모델)을 충족하도록 올바른 순회식을 합성해야 한다. `apps.get_models(app_label)`(전역 반환, 인자 오용) → `apps.get_app_config(app_label).get_models()`(앱-국소)로의 교체는 의미를 추론해야 도달한다. 일단 그 불변식을 잡으면 변경 자체는 한 줄 기계적 치환(S1적)이라 S1 보조 표기. → **S2 (+S1)**.
- **K-Domain** — 핵심 함정이 Django app registry API 계약이다: `Apps.get_models()`는 app-label 필터 인자를 받지 않고 전체를 반환하며, 앱별 모델은 `AppConfig.get_models()`로 얻는다는 프레임워크 내부지식이 병목. 일반 파이썬 추론(K-Gen)으론 "왜 잘못인지"를 못 잡는다. → **K-Domain**.
- **primary type = T-DomainBound** — 위치 좁히기(L1)도 픽스 합성(S2)도 적당하지만, 진짜 병목은 `Apps.get_models` vs `AppConfig.get_models`라는 django 도메인 API 계약 지식이다. 위치가 다소 모호하긴 해도 L2/L3 수준의 "찾기 자체가 난점"은 아니므로 T-DiffuseLoc이 아니고, 픽스가 None-가드류 정형결함도 아니라 T-DirectMap도 아니다. K-Domain이 dominant → **T-DomainBound**.

## 난이도 티어 — **T3 (중간)**
이 티어로 미는 구조적 피처:
- **1파일·1줄 diff** (`makemigrations.py` 단일 헌크, 실질 1라인 치환) → scope 자체는 작아 T5/T6를 배제.
- **L1 + S2 실질 추론** → "찾으면 끝, 픽스 자명"(T1/T2)을 넘어선다. 핵심은 `apps.get_models(app_label)`가 "그 앱 모델"을 준다는 **그럴듯한 오해**를 깨야 한다는 점 — 라인은 좁혀도 올바른 교체식 도출에 도메인 추론이 든다.
- **has-repro 없음** — 네이티브 스택트레이스/재현 스크립트가 본문에 없다(보고자 라우터 환경 묘사뿐). 강한 easiness 신호 부재가 T2 아래로 못 내려가게 한다.
- **regression-trap (넓은 P2P)** — 동일 명령의 인접 동작 다수를 안 깨야 한다(아래 검증 참조). 넓은 P2P trap은 T4까지도 밀 수 있는 신호지만, 변경이 1라인이고 의미가 국소적이라 회귀 위험의 *실질*은 제한적 → T4까지 올리진 않는다.
- 공식 라벨 "15 min - 1 hour"는 개발자 구현시간 기준의 prior로 T3와 정합적이다. 다만 공식 라벨은 K-Domain(`get_models` API 오해를 풀어야 함)을 시간으로 환산해 깔끔히 못 잡으므로, 그 도메인 함정을 명시적으로 반영해 T3로 둔다(라벨과 큰 괴리 없음).

## 골드패치 분석
- **건드린 파일/함수**: `django/core/management/commands/makemigrations.py` — `Command.handle()` 내 일관성 검사 제너레이터 표현식(`any(router.allow_migrate(connection.alias, app_label, model_name=model._meta.object_name) for app_label in consistency_check_labels for model in ...)`).
- **근본 원인**: 안쪽 루프가 `for model in apps.get_models(app_label)`였다. `Apps.get_models()`는 **app-label 필터 인자를 받지 않고 프로젝트 전체 모델을 반환**한다 — 여기서 넘긴 `app_label`은 시그니처상 `include_auto_created`/`include_swapped` 위치로 silently 오용/무시된다. 결과적으로 모든 `app_label`에 대해 전체 모델 집합이 곱해져, `(app_label, 그 앱이 소유하지 않은 model)` 같은 잘못된 쌍이 `allow_migrate`로 전달된다.
- **수정 요지**: `for model in apps.get_models(app_label)` → `for model in apps.get_app_config(app_label).get_models()`. 먼저 해당 `app_label`의 `AppConfig`를 `apps.get_app_config(app_label)`로 가져온 뒤, 그 앱이 소유한 모델만 `get_models()`로 순회한다. 이로써 `allow_migrate(alias, app_label, model_name=...)`에 항상 (앱, 그 앱의 모델) 유효 쌍만 전달된다.

## 검증 (test_patch)
- **주의 — 데이터 불일치**: 이 인스턴스 레코드의 `FAIL_TO_PASS`(1개)와 `PASS_TO_PASS`(59개)는 `SquashMigrationsTests`/일반 `MakeMigrationsTests`·`MigrateTests` 항목으로 채워져 있어, test_patch가 실제로 강화한 `test_makemigrations_consistency_checks_respect_routers`와 라벨 매핑이 어긋나 보인다. 본 분석은 frontmatter 카운트(fail_to_pass=1, pass_to_pass=59)를 JSON 배열 길이 그대로 따르되, **픽스를 실증하는 검증 변경은 test_patch의 consistency-checks 테스트**로 해석한다.
- **FAIL_TO_PASS 동작(실질 검증 변경)**: `tests/migrations/test_commands.py::test_makemigrations_consistency_checks_respect_routers`에 `@override_settings(INSTALLED_APPS=['migrations', 'migrations2'])`를 추가해 두 앱 구성을 고정한다. 기존 `allow_migrate.assert_called_with(...)`(마지막 호출만 검사)를 `assert_any_call('other', 'migrations', model_name='UnicodeModel')`로 완화한 뒤, **모든 호출**(`for mock_call in allow_migrate.mock_calls`)을 순회하며 각 호출의 `connection_alias ∈ ['default','other']`이고 `apps.get_app_config(app_name).get_model(call_kwargs['model_name'])`가 예외 없이 통과하는지 검사한다.
- **픽스 증명**: 버그 코드에서는 `migrations` 앱 라벨에 `migrations2`의 모델이 섞여 전달되므로 `apps.get_app_config('migrations').get_model('<migrations2의 모델>')`가 `LookupError`를 던져 테스트가 실패한다. 골드패치 후에는 각 `app_label`에 그 앱 소유 모델만 전달되어 모든 `get_model` 조회가 성공 → 통과. 즉 테스트가 "전달된 모든 (app_name, model_name) 쌍이 그 앱에 실재하는 유효 조합"이라는 정확한 불변식을 강제한다.
- **overfit 관점**: FAIL_TO_PASS 자체는 얇아 보일 수 있으나, 테스트가 `assert_any_call` + **전수 mock_calls 순회 + 실제 app registry 조회**로 일반 불변식을 검사하므로 special-case 통과가 어렵다. `assert_called_with` 한 줄만 맞추는 식의 overfit 패치는 다른 (앱, 모델) 쌍 검사에서 막힌다 → overfit-risk 낮음(그래서 플래그 미부여).
- **regression 관점**: 넓은 `PASS_TO_PASS`(makemigrations/migrate/squashmigrations 다수)가 동일 명령 경로를 커버하므로, 모델 순회 소스를 바꾸면서 일반 makemigrations 동작(변경 감지·머지·dry-run·inconsistent-history 등)을 깨면 즉시 잡힌다 → **regression-trap** 플래그.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 직접 신호 `makemigrations` + `router.allow_migrate()` + "consistency checks"로 `django/core/management/commands/makemigrations.py`를 연다. `handle()`에서 `allow_migrate`를 호출하는 제너레이터 표현식을 찾고, 모델을 어디서 순회하는지(`apps.get_models(app_label)`) 짚는다. (L1 — 파일은 즉시, 정확 라인은 API 의미 확인 후.)
2. **픽스와 올바른 일반화인 이유**: `apps.get_models(app_label)`이 "그 앱 모델"이라는 가정을 의심하고 `Apps.get_models` 시그니처를 확인하면, 인자가 app-label 필터가 아니라 전체 반환임을 알게 된다. 올바른 일반화는 "각 `app_label`에 대해 그 앱이 **소유한** 모델만 짝짓는다"는 불변식이고, 이를 표현하는 정규 API가 `apps.get_app_config(app_label).get_models()`다. 특정 테스트 입력에 맞춘 필터링이 아니라 app↔model 소유 관계를 통째로 바로잡으므로 임의 입력에 일반화된다(overfit 아님).
3. **regression 안전**: `migrations`/`migrate`/`squashmigrations`를 아우르는 넓은 P2P를 안 깨야 한다 — 모델 순회 소스를 바꿔도 일관성 검사가 여전히 모든 관련 앱·모델을 빠짐없이 검사해야 하고(누락 시 inconsistent-history/empty-connections 류 테스트가 깨짐), 일반 makemigrations 흐름(dry-run·merge·no-changes 등)에 부작용이 없어야 한다. `get_app_config(...).get_models()`는 동일 모델 집합을 앱-국소로 정확히 분할하므로 커버리지를 줄이지 않는다.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 실패 — (a) `apps.get_models(app_label)`를 "그 앱 모델"로 오독해 버그를 못 알아봄(K-Domain 결핍), (b) `allow_migrate` grep만 하고 순회 소스의 의미를 안 따져 부분 수정에 그침, (c) `[m for m in apps.get_models() if m._meta.app_label == app_label]` 같은 ad-hoc 필터로 우회(동작은 같아도 비관용적·중복순회). 피하는 법: `Apps.get_models` 시그니처를 직접 확인해 인자 오용을 검증하고, 관용적 정규 API(`get_app_config().get_models()`)로 교체한 뒤, 강화된 테스트가 **모든** mock_call의 (앱, 모델) 유효성을 검사함을 의식해 전 범위를 만족시키는지 점검한다.
