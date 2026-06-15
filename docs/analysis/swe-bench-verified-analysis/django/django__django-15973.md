---
instance_id: django__django-15973
repo: django/django
base_commit: 2480554dc4ada4ecf3f6a08e318735a2e50783f3
version: 4.2
difficulty: 15 min - 1 hour
created_at: 2022-08-19T18:10:02Z
fail_to_pass: 1
pass_to_pass: 157
gold_files: [django/db/migrations/autodetector.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L2
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

# django__django-15973

## 문제 요약
ManyToManyField의 `through` 모델을 별도 앱에 정의하면 마이그레이션 적용 시 `AttributeError: 'str' object has no attribute '_meta'`가 발생한다. 사용자는 fonte/variavel/fonte_variavel 세 앱으로 모델을 쪼갰고, m2m 필드는 fonte에, through 모델(FonteVariavelModel)은 fonte_variavel에 두었다. autodetector가 생성한 마이그레이션의 dependencies에 through 모델이 속한 앱이 빠지면서, 실제 적용 단계(`schema_editor.create_model`)에서 through가 문자열 참조인 채로 남아 `field.remote_field.through._meta` 접근이 터진다. through 모델을 m2m 필드와 같은 앱에 두면 정상 동작한다(= 앱 경계/의존성 문제라는 강한 단서). 풀 트레이스백·재현 모델이 이슈에 포함되어 있다(has-repro).

## 유형 (정형화)

3축 점수:

- **L = L2 (Diffuse).** 트레이스백 끝단(`schema.py`의 `_meta` 접근)은 증상 발생 지점이지 결함 지점이 아니다. 진짜 결함은 "마이그레이션을 *만드는*" autodetector의 의존성 계산이며, 증상(apply)과 결함(generate)이 다른 서브시스템으로 분리돼 있다. 표면 스택만 따라가면 schema.py로 가서 오답이 된다 — 결함 사이트를 찾으려면 "같은 앱은 되고 다른 앱은 안 됨"이라는 차이를 의존성 누락으로 환원하는 cross-module 데이터플로우 추론이 필요. 단일 사이트 픽스지만 거기까지 가는 길이 직접적이지 않아 L1이 아니라 L2.
- **S = S2 Constraint-Reasoning (+S5 Spec-Inference).** 고칠 *한 줄*을 찾고 나면 픽스는 작지만, 무엇이 올바른 인자인지는 "FK 의존성은 그 FK가 가리키는 *대상 모델*을 resolve해야 한다"는 불변식 추론으로만 도출된다. through 분기에서는 대상이 m2m의 to 모델(`remote_field_model`)이 아니라 through 모델(`field.remote_field.through`)이라는 의미적 판단이 핵심(S2). 이 의도는 코드만 봐선 모호하고 마이그레이션 의존성 그래프의 계약("적용 순서 보장")에서 역추론해야 하므로 S5가 보조로 붙는다. 후보를 마구 시도하는 G&V가 아니라 "생각으로" 푸는 결함이다.
- **K = K-Domain.** django migrations autodetector + m2m through + 앱간 의존성 그래프라는 프레임워크 내부 지식이 병목. `_get_dependencies_for_foreign_key`가 무슨 튜플을 뱉고 그게 어떻게 migration `dependencies`로 흘러 적용 순서를 결정하는지를 알아야 결함을 결함으로 인지한다. 일반 파이썬 추론(K-Gen)만으론 `_meta` AttributeError를 방어코드로 땜질하는 오답에 빠진다.

**primary type = T-DomainBound.** L2 diffuse가 있긴 하나 단일 사이트로 수렴 가능하고, 진짜 병목은 "어디"보다 "django 마이그레이션 의존성 의미를 알아야 결함을 인지·수정한다"는 도메인 지식이다. 따라서 T-DiffuseLoc보다 T-DomainBound이 dominant. repair가 S2 한 줄이라 T-ConstraintReason도 후보지만, 그 추론 자체가 migrations 도메인 계약 위에서만 성립하므로 K-Domain을 dominant로 본다.

왜 이 repair strategy인가(APR 관점): 결함은 "잘못된 변수를 resolve에 넘김"이라는 단일 표현식 오류다. GenProg식 G&V로 인접 코드를 재배열해 풀리지 않고(테스트가 의존성 *내용*을 단언하므로 special-case 통과가 어렵다), SemFix/Angelix식으로 "이 위치에서 어떤 식이 불변식을 만족하나"를 추론 합성하는 S2가 정확히 맞는다. 다만 그 불변식("through FK의 dependency 대상=through 모델")이 자명하지 않고 migrations 계약에서 와야 해서 S5가 보조로 결합한다.

## 난이도 티어

**T4 (약간 어려움).** 공식 라벨은 "15 min - 1 hour"(개발자 구현시간 기준, T2~T3 prior)지만 에이전트 난이도로 재조정하면 T4로 올린다.

이 티어로 미는 구조적 피처:
- **localize 직접성 낮음 (L2):** 증상 트레이스백(schema.py `_meta`)과 결함 사이트(autodetector `_get_dependencies_for_foreign_key`)가 다른 모듈이다. 시간라벨은 "고칠 줄을 아는 개발자"의 시간이라 이 localize 비용을 안 잡는다 — 에이전트는 여기서 51%류 localization 에러로 미끄러지기 쉽다.
- **도메인 지식 병목 (K-Domain):** 픽스 한 줄을 *옳다고* 판단하려면 migration dependency 그래프 의미를 알아야 한다. 표면 방어코드(스택트레이스 직격) 유혹이 강한 overfit-인접 함정.
- **넓은 P2P trap (regression-trap):** PASS_TO_PASS 157개가 전부 autodetector 동작(through 관련 다수: "Adding a m2m with a through model...", "Removing a ManyToManyField and the through model...", swappable_many_to_many, renamed_referenced_m2m 등). `resolve_relation` 인자를 바꾸는 한 줄이 이 인접 동작을 깨면 안 된다 — through 처리 분기가 다른 케이스와 공유되므로 변경 영향면이 넓다.

하향 압력(왜 T5는 아닌가): gold patch는 단일 파일·단일 라인이고 재현코드/네이티브 스택트레이스가 있다(has-repro, 가장 강한 easiness 신호). 멀티사이트 조율(L3)도, 구조 리팩터(S6)도, overfit 고위험(S4)도 아니다. ICLR 2024 컷에서 1파일·소규모는 solve가 높은 구간이라 T5/T6로 갈 근거가 없다. 결과적으로 "단일 라인이지만 localize 우회 + 도메인 추론 + 넓은 regression면"이 합쳐진 전형적 T4.

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/autodetector.py` : `MigrationAutodetector._get_dependencies_for_foreign_key`
- 근본 원인: `field.remote_field.through`가 설정된(=명시적 through를 쓰는 m2m) 분기에서 `resolve_relation`에 m2m의 **타깃 모델**(`remote_field_model`, 즉 `to=`가 가리키는 모델)을 넘기고 있었다. 이 분기의 의도는 *through 모델*에 대한 의존성을 계산하는 것인데, 엉뚱하게 to 모델을 resolve했으므로 through 모델이 속한 앱(`through_app_label`)이 잘못 계산되어 마이그레이션 `dependencies`에 through 앱이 누락된다. through가 같은 앱이면 우연히 앱 라벨이 일치해 안 터지지만, 별도 앱이면 적용 순서가 어긋나 through가 아직 문자열 참조인 상태로 `schema_editor.create_model`에 도달 → `'str'.._meta` AttributeError.
- 수정 요지: 한 줄 변경. `resolve_relation(remote_field_model, app_label, model_name)` → `resolve_relation(field.remote_field.through, app_label, model_name)`. through 분기 안에서 through 모델 자신을 resolve하여 올바른 `through_app_label`/`through_object_name`을 의존성으로 등록한다. 이로써 생성 마이그레이션이 through 앱에 정확히 의존하게 되고 적용 순서가 바로잡힌다.

## 검증 (test_patch)
- FAIL_TO_PASS(1개): `test_create_with_through_model_separate_apps (migrations.test_autodetector.AutodetectorTests)`. m2m 필드(`authors.Author.publishers`, `to="testapp.Publisher"`, `through="contract.Contract"`)와 through 모델(`contract.Contract`)을 서로 다른 앱에 두고 autodetector를 돌린다.
- 픽스 증명: 결정타 단언은
  `assertMigrationDependencies(changes, "authors", 1, {("authors","auto_1"), ("contract","auto_1"), ("testapp","auto_1")})`.
  픽스 전이면 authors의 AddField 마이그레이션 dependencies에 `("contract","auto_1")`가 빠진다(through 앱 누락). 픽스 후엔 through 모델 resolve가 contract 앱을 잡아 의존성에 포함된다. 추가로 마이그레이션 수(authors=2, contract=1, testapp=1)와 각 연산(testapp/contract의 CreateModel, authors의 CreateModel+AddField)을 검증해 through가 별도 앱이어도 그래프가 올바르게 구성됨을 확인한다.
- overfit 관점: 이 테스트는 `_meta` 예외를 잡는 게 아니라 *의존성 집합의 내용*을 직접 단언한다. 즉 schema.py에 try/except나 None-가드 같은 special-case 방어코드로는 통과시킬 수 없다(통과시키려면 실제로 contract 의존성이 그래프에 등록돼야 함). 따라서 표면 땜질 overfit 패치를 구별해내는 비교적 강한 oracle. 다만 F2P가 1개라 입력공간(여러 through 토폴로지)을 다 커버하진 않으므로 overfit-risk 자체는 낮지만 0은 아니다 — has-repro와 의존성-내용 단언이 이를 상쇄한다.
- regression 관점: P2P 157개 중 다수가 m2m/through/swappable/renamed-m2m autodetector 동작이다(regression-trap). through 분기의 resolve 인자를 바꾸는 변경이 이들을 깨지 않아야 통과한다. 같은-앱 through 케이스("Adding a m2m with a through model and the models that use it should be...")가 P2P에 있어, 픽스가 별도-앱 케이스만 고치고 같은-앱 케이스를 회귀시키지 않음을 함께 보장한다.

## 모범답안 (오라클 기반)

1. **localize 경로:** 트레이스백 표면(`schema.py: field.remote_field.through._meta`)에 낚이지 말 것. 핵심 신호는 이슈의 "같은 앱에 두면 동작하고, 별도 앱이면 안 됨" + "intermediary(through) 모델 때문" 진술이다. 이는 런타임 스키마 적용이 아니라 *마이그레이션 생성 시 앱간 의존성 계산* 문제임을 가리킨다. through가 문자열로 남았다는 건 적용 순서가 어긋났다는 뜻 → 마이그레이션 `dependencies`를 만드는 곳을 본다 → `autodetector.py`에서 FK/through 의존성을 계산하는 `_get_dependencies_for_foreign_key`로 수렴.

2. **픽스와 올바른 일반화:** `through` 분기에서 `resolve_relation`에 넘기는 대상을 `remote_field_model`(m2m의 to 모델)에서 `field.remote_field.through`(through 모델)로 교체. 이것이 올바른 일반화인 이유: 의존성 그래프의 불변식은 "각 FK/관계는 그것이 *실제로 참조하는 모델*의 앱에 의존해야 한다"이다. through 분기의 목적이 through 모델 의존성이므로 resolve 대상도 through 모델이어야 한다 — 앱이 같든 다르든 항상 성립하는 보편 규칙이다. 같은-앱일 때 기존 코드가 "우연히" 동작했던 것은 앱 라벨이 일치했기 때문일 뿐, 별도-앱은 그 우연이 깨질 뿐이다. schema.py에 가드를 넣는 식의 증상 억제는 의존성 누락이라는 근본을 안 고쳐 일반화가 아니다(다른 토폴로지에서 재발).

3. **regression 안전:** 같은-앱 through 케이스(P2P의 "Adding a m2m with a through model...", "Removing a ManyToManyField and the through model...")가 깨지면 안 된다. 픽스는 분기 *내부*의 resolve 인자만 바꾸고 분기 조건·반환 형식·다른 의존성 항목은 건드리지 않으므로, through 대상을 정확히 가리키게만 만들 뿐 같은-앱 경로의 결과는 동일하게 유지된다(같은-앱이면 through 모델의 앱 라벨 = m2m 앱 라벨이라 의존성 집합 불변). swappable/renamed-m2m P2P도 이 분기 밖이라 영향 없음.

4. **함정 회피:** 오라클 없는 에이전트의 전형적 오답 두 가지. (a) 스택트레이스 직격 — schema.py `create_model`에서 `through`가 str이면 resolve하거나 try/except로 방어. 이는 의존성 그래프를 안 고쳐 적용 순서 문제가 남고, 의존성-내용을 단언하는 F2P 테스트를 통과 못 한다. (b) 자연스러워 보이는 변수 재사용 — `remote_field_model`이 함수 상단에서 이미 계산돼 있어 through 분기에서도 그걸 쓰는 게 "DRY해 보인다". 하지만 through 분기는 의미상 다른 대상(through 모델)을 가리켜야 한다는 점을 놓치면 결함을 그대로 둔다. 회피법: "이 의존성은 *무엇을 가리키는 의존성인가*"를 분기 의도로 되물어, resolve 대상이 to 모델이 아니라 through 모델이어야 함을 확정한다.
