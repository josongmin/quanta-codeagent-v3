---
instance_id: django__django-11740
repo: django/django
base_commit: 003bb34b218adb23d1a7e67932a6ba9b3c4dcc81
version: "3.0"
difficulty: 15 min - 1 hour
created_at: 2019-09-03T10:44:38Z
fail_to_pass: 1
pass_to_pass: 109
gold_files: [django/db/migrations/autodetector.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L1
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-11740

## 문제 요약
비-relation 필드(이슈 예시는 `UUIDField`, 테스트는 `IntegerField`)를 **다른 앱**의 모델을 가리키는 `ForeignKey`로 바꾸면, `makemigrations`가 생성하는 `AlterField` 마이그레이션이 참조 대상 앱에 대한 `dependencies`를 만들지 않는다. 그 결과 마이그레이션을 적용할 때 `ValueError: Related model 'testapp2.App2' cannot be resolved.`가 발생한다. 즉 생성 단계는 silent-wrong(겉보기 정상)이고, 적용 단계에서 폭발한다. 사용자·hint 모두 "필드가 FK로 바뀌었으니 대상 앱에 대한 의존성이 자동 추가되어야 한다"고 결론짓는다.

## 유형 (정형화)
- **L = L1 (Traceable)**: problem_statement 자체는 "does not create any dependencies for App2"라는 동작 신호만 주지만, hints_text가 정확히 `django.db.migrations.autodetector.MigrationAutodetector.generate_altered_fields`의 `add_operation` 호출과 헬퍼 `self._get_dependencies_for_foreign_key(new_field)`까지 지목한다. 단일 파일·단일 함수로 수렴하나 grep "한 방"(L0)은 아니고, AddField 경로와 대조해야 누락 지점이 보이므로 약간의 탐색이 필요 → L1.
- **S = S1 (Direct-Map), 보조 S2**: 결함 클래스가 "조건부 분기에서 dependency 수집을 누락"이라는 정형 패턴이고, hints가 "`_get_dependencies_for_foreign_key`로 retrieve해서 넘겨라"고 거의 픽스를 명세한다 → 기계적 Direct-Map(S1). 다만 dependency를 **어느 분기 안에서** extend할지(FK일 때만), AlterField가 m2m/concrete 두 갈래로 나뉘는데 어느 호출에 넘길지를 따져야 하므로 약한 constraint-reasoning(S2)이 보조로 붙는다.
- **K = K-Domain**: 이 픽스는 일반 파이썬 추론이 아니라 django migrations autodetector의 내부 모델 — operation dependency 그래프, `__first__`/initial vs "최신 마이그레이션" 참조 규칙, relation 전환 시 어떤 헬퍼가 의존성을 계산하는지 — 를 알아야 정확히 풀린다. 도메인 지식이 병목이라 K-Domain.
- **primary type = T-DomainBound**: 위치는 hint로 사실상 주어졌고 코드 변경량도 4줄로 작다. 진짜 난점은 "find/edit"이 아니라 migrations autodetector의 dependency 의미론(왜 FK 분기에서만, 왜 latest를 가리켜야 하는지)을 정확히 이해하는 것이다. K-Domain이 dominant이므로 T-DomainBound.

왜 이 repair strategy인가(APR 관점): hints_text가 픽스 위치·사용할 헬퍼·올바른 동작("latest migration, not initial")을 모두 적어주므로 탐색적 Generate-&-Validate가 아니라 PAR/TBar류 **template/Direct-Map**으로 매핑된다(누락된 dependency-collection 패턴을 인접 AddField 경로에서 transplant). 단, 헬퍼 호출을 잘못된 분기(m2m/through, 또는 비-relation)에 넣으면 잘못된 의존성이 끼므로, 분기 불변식을 따지는 S2 추론이 정확성을 가른다.

## 난이도 티어
**T4 (약간 어려움).** 공식 difficulty 라벨은 "15 min - 1 hour"(T2~T3 prior)지만 다음 구조적 피처가 T4로 민다.
- **K-Domain이 dominant**: 루브릭상 K-Domain이 핵심 병목이면 T4가 전형이다. autodetector dependency 그래프는 django 내부지식이고, "왜 FK 분기에서만 extend하는가"를 모르면 과도/과소 의존성으로 회귀를 만든다.
- **넓은 regression-trap (P2P=109)**: PASS_TO_PASS 109개가 거의 전부 같은 `migrations.test_autodetector.AutodetectorTests` 안의 dependency/ordering 단언이다(`test_fk_dependency_other_app`, `test_circular_*`, `test_alter_many_to_many`, `test_concrete_field_changed_to_many_to_many` 등). dependency를 한 줄 더 끼우는 픽스라서, 위치를 살짝만 틀려도 인접 의존성 단언이 줄줄이 깨진다 → 회귀 표면이 촘촘.
- **생성 vs 적용 분리(오진 함정)**: 버그가 마이그레이션 "생성"이 아니라 "적용" 시점에 터진다. 생성 결과만 보면 정상으로 보여 localize/검증 모두 헛다리 위험.

반대로 T5로 안 가는 이유: 단일 파일·단일 함수·4줄·기존 헬퍼 재사용이고 multi-site 조율(L3)이 아니며, has-repro(이슈에 재현 프로젝트+네이티브 ValueError 스택)라 easiness 신호가 강하다. localize 직접성과 변경 규모가 작아 T4 하단에 위치한다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/migrations/autodetector.py` → `MigrationAutodetector.generate_altered_fields`
- **근본 원인**: `generate_altered_fields`는 필드 변경 시 `operations.AlterField`를 `add_operation`으로 추가하는데, AddField 경로(`_generate_added_field`)와 달리 새 필드가 relation으로 바뀐 경우에도 dependencies를 **전혀 계산해 넘기지 않았다**. 따라서 새로 생긴 FK의 대상 앱이 마이그레이션 의존성 그래프에 들어가지 못해, 적용 시 참조 모델 해석에 실패한다.
- **수정 요지**(3개 hunk):
  1. 루프 본문 시작에서 `dependencies = []` 초기화.
  2. `hasattr(new_field, "remote_field") and getattr(new_field.remote_field, "model", None)`이 참인 **FK/relation 분기 안**에서 `dependencies.extend(self._get_dependencies_for_foreign_key(new_field))`로 대상 앱의 의존성 수집. (이 헬퍼가 "initial이 아닌 latest 마이그레이션을 가리킨다"는 규칙을 이미 처리하므로 직접 손대지 않음.)
  3. 마지막 `self.add_operation(... operations.AlterField(...))` 호출(concrete-field 갈래)에 `dependencies=dependencies` 인자 전달.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_alter_field_to_fk_dependency_other_app`.
- **동작**: 새 픽스처 `book_with_no_author_fk`는 `otherapp.Book`의 `author`를 `IntegerField`(비-relation)로 정의한다. 테스트는 이 상태 → `book`(author가 `testapp.Author`를 가리키는 FK) 상태로의 변경을 감지시키고, ① `otherapp`에 마이그레이션 1개, ② 오퍼레이션 타입 `['AlterField']`, ③ 그 마이그레이션의 dependencies가 `[('testapp', '__first__')]`를 포함하는지 단언한다.
- **픽스 증명**: 픽스 전에는 `add_operation`에 dependencies가 비어 단언 ③이 실패한다. `_get_dependencies_for_foreign_key(new_field)`가 추가되면서 `('testapp', ...)` 의존성이 채워져 통과 — 즉 테스트가 정확히 누락된 데이터플로우(FK 전환 → 대상 앱 의존성)를 관통한다.
- **overfit 관점**: FAIL_TO_PASS가 1개뿐이라 표면적으로 얇지만(`overfit-risk` 후보), special-case 하드코딩(예: `dependencies = [('testapp','__first__')]`)으로 통과시키는 건 P2P 109개의 다른 dependency/ordering 단언과 충돌해 즉시 깨진다. 골드처럼 기존 헬퍼를 FK 분기에서 호출하는 일반화만이 회귀-안전하게 통과하므로, P2P가 사실상 overfit 방지 게이트로 작동한다.
- **regression 관점**: `regression-trap` — P2P가 동일 테스트 파일의 의존성/순서 단언으로 빽빽하다. 헬퍼를 m2m/through 분기나 비-relation 경로에까지 끼우면 `test_alter_many_to_many`, `test_concrete_field_changed_to_many_to_many`, `test_circular_*` 등이 잘못된 의존성으로 깨진다.

## 모범답안 (오라클 기반)
1. **Localize**: 이슈의 "does not create dependencies for App2" + 적용 시 `ValueError: Related model ... cannot be resolved`가 신호. 이 메시지는 마이그레이션 dependency 누락의 시그니처다 → 변경 감지기 `autodetector.py`. 그 안에서 "필드를 바꾸는" 경로 `generate_altered_fields`로 좁히고, 정상 동작하는 `AddField` 경로(`_generate_added_field`)와 대조하면 후자만 `_get_dependencies_for_foreign_key`로 의존성을 넘긴다는 비대칭이 즉시 드러난다.
2. **픽스와 일반화 근거**: FK/relation 분기(`new_field.remote_field.model` 존재) 안에서 `dependencies.extend(self._get_dependencies_for_foreign_key(new_field))`를 수집해 `AlterField`의 `add_operation`에 넘긴다. 이게 올바른 일반화인 이유 — (a) 특정 앱/필드 하드코딩이 아니라 임의의 비-relation→FK 전환 전반에 적용되고, (b) "latest migration vs initial" 규칙을 헬퍼에 위임해 향후 대상 모델이 변경돼도 올바른 의존성을 가리키며, (c) AddField가 이미 검증된 동일 헬퍼를 쓰므로 코드베이스의 기존 계약과 일치한다.
3. **Regression 안전**: dependency extend를 **반드시 FK 분기 안에서만** 수행한다. 그래야 `test_alter_many_to_many`(m2m through), `test_concrete_field_changed_to_many_to_many`, `test_circular_fk_dependency` 등 비-FK·m2m 경로의 의존성/순서 단언이 안 깨진다. `dependencies = []`를 루프마다 초기화해 필드 간 누수도 막는다. concrete-field 갈래의 `add_operation`에만 전달하고 m2m 갈래는 건드리지 않는 것이 핵심.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (i) 버그가 생성이 아니라 **적용** 단계에서 터지므로 생성 결과만 검사하면 정상으로 오진한다(반드시 의존성 그래프/적용 의미를 봐야 함). (ii) AlterField 호출이 m2m vs concrete 두 갈래라 dependencies를 엉뚱한 갈래에 넘기기 쉽다. (iii) hints의 `('testapp2','0001_initial')` 예시를 보고 initial을 하드코딩하면 "latest"가 아니라 잘못 — 헬퍼에 위임해야 한다. (iv) FAIL_TO_PASS가 1개라 얕은 special-case로 green을 노리면 P2P 109에서 폭발한다. 정답은 인접 AddField 경로의 검증된 패턴을 FK 분기에 그대로 transplant하는 것.
