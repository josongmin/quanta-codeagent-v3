---
instance_id: django__django-12754
repo: django/django
base_commit: 18759b2209ff556aed7f20d83cbf23e3d234e41c
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-04-19T10:59:30Z
fail_to_pass: 1
pass_to_pass: 112
gold_files: [django/db/migrations/autodetector.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-12754

## 문제 요약
모델 서브클래스를 새로 만들면서 같은 스텝에서 필드를 베이스 모델로부터 서브클래스로 옮기면, `makemigrations`는 성공하지만 `migrate` 실행 시 `FieldError: Local field 'title' in class 'Book' clashes with field of the same name from base class 'Readable'`로 죽는다. 자동 감지기가 `CreateModel(Book)` → `RemoveField(Readable.title)` 순서로 마이그레이션을 생성하는데, Book이 만들어지는 시점엔 아직 Readable.title이 남아 있어 MTI(multi-table inheritance) 필드 충돌이 난다. 사용자는 자동 감지기가 두 연산 순서를 뒤집어(RemoveField 먼저, CreateModel 나중) 적용 가능한 마이그레이션을 생성해 주길 기대했다. 이슈 본문에 재현 모델 코드가 그대로 들어있다.

## 유형 (정형화)

**3축 점수**

- **L (Localization) = L1 (Traceable).** problem_statement이 "the auto-detector should be able to use this order"로 자동 감지기를 직접 지목하고, hints에서 Simon Charette가 `generate_created_models`와 정확한 의존성 표현 `(base_app_label, base_model_name, field_name, False)`, 심지어 소스 라인(L561-565)까지 짚어준다. 다만 이슈는 "충돌"이라는 증상을 말할 뿐 픽스 위치가 본문만으로 자명하진 않고(에이전트는 hints 없이는 operations 실행기/MTI 검증으로 샐 수 있음), 단일 파일·단일 함수 안에서 수렴하므로 L0가 아니라 L1.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S6 Design-Refactor 보조).** 고칠 지점(베이스 처리 루프)은 좁지만, 픽스는 한 줄 가드가 아니라 **올바른 집합식을 추론으로 합성**해야 한다: "베이스에서 제거됐고(`from`−`to`) AND 새 서브클래스로 들어온(`∩ model_state.fields`) 필드"라는 2단계 difference→intersection 불변식을 직접 도출해야 정확한 false-positive 없는 의존성이 나온다. 또 이 픽스는 단순 값 변경이 아니라 의존성 그래프에 새 엣지(필드-레벨 의존)를 도입해 토폴로지 정렬 순서를 재배치하는 **소규모 구조 변경**이라 S6를 보조로 단다. G&V(S3)가 아닌 이유: 테스트를 여러 번 돌려 후보를 추리는 게 아니라 상태 모델(`from_state`/`to_state`)의 의미를 따져 "생각으로" 식을 맞춰야 한다.
- **K (Knowledge) = K-Domain.** django migrations autodetector 내부의 의존성 4-튜플 시맨틱(`(app, model, name_or_field, is_model_create)`의 4번째 bool이 "모델 생성 vs 필드 변경" 구분), `from_state`(이전)와 `to_state`(현재) 상태 분리, MTI 베이스 문자열 표현 등 프레임워크 내부 지식이 병목이다. 일반 파이썬 추론(K-Gen)으로는 풀 수 없다.

**Primary type = T-DomainBound.** L1으로 위치는 좁고 S2 추론도 있지만, 이 문제의 진짜 병목은 "autodetector의 의존성 그래프가 어떻게 연산 순서를 결정하는가"라는 django 마이그레이션 도메인 지식이다. K-Domain이 dominant라 T-ConstraintReason보다 T-DomainBound가 정확하다(루브릭: K-Domain이 dominant이면 T-DomainBound).

## 난이도 티어
**Tier = T4 (약간 어려움).** 공식 difficulty 라벨은 "15 min - 1 hour"(≈T3).

이 티어로 미는 구조적 피처:
- **파일/줄수**: 단일 파일·단일 함수·gold +10줄로 scope는 작다(T2~T3 신호). 이것만 보면 쉬움.
- **localize 직접성**: L1이지만 hints 없이는 "충돌을 고친다"는 오판으로 operations 실행기나 MTI 검증으로 샐 수 있음(약한 misdirection).
- **K-Domain + S2**: 루브릭상 "constraint추론·소규모 refactor·도메인지식 중 하나"는 T4. 본 건은 셋 다 약하게 걸린다(S2+S6+K-Domain). 의존성 4-튜플 시맨틱과 `from_state`/`to_state` 구분을 모르면 식 자체를 못 짠다.
- **P2P trap (regression-trap)**: PASS_TO_PASS가 112개로 autodetector 전 동작(circular dependency, swappable, proxy, MTI removal, foo_together ordering 등)을 안 깨야 한다. 의존성 엣지를 잘못 넓히면 무관한 연산 순서까지 흔들려 회귀가 터질 광범위 표면이다. 이 넓은 P2P가 시간라벨엔 안 잡히는 위험.

**공식 라벨과의 차이**: 공식은 "개발자 구현시간"(픽스가 +10줄이라 1시간 내) 기준이라 T3 수준. 우리는 (a) K-Domain 병목 (b) 112개 P2P regression 표면 (c) 잘못 좁히면 false 의존성을 만드는 S2 추론 난이도를 반영해 T4로 한 단계 올린다. has-repro가 easiness를 당기긴 하지만(재현 모델 코드 있음), 그것이 픽스 위치를 직접 주지는 않아 상쇄가 제한적이다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/migrations/autodetector.py` : `generate_created_models()` (베이스 처리 루프, 약 L563).
- **근본 원인**: 생성될 모델이 MTI 베이스(`bases`에 `"app.readable"` 같은 문자열)를 가질 때, 기존 코드는 베이스 모델 자체에 대한 의존성 `(base_app_label, base_name, None, True)`만 추가했다. 베이스에서 제거되는 필드와 서브클래스에서 새로 추가되는 필드가 이름이 겹치는 경우(필드 이동), "그 필드의 RemoveField가 이 CreateModel보다 먼저 실행돼야 한다"는 의존성이 없어 자동 감지기가 토폴로지 정렬에서 임의(생성 먼저) 순서로 배치 → 런타임에 베이스·서브클래스 양쪽에 같은 필드가 공존 → FieldError.
- **수정 요지**: 베이스 의존성을 추가한 직후
  - `old_base_model_state = self.from_state.models.get((base_app_label, base_name))`, `new_base_model_state = self.to_state.models.get((base_app_label, base_name))`로 이전/현재 베이스 상태를 가져오고,
  - `removed_base_fields = set(old_base_model_state.fields).difference(new_base_model_state.fields).intersection(model_state.fields)`로 "베이스에서 제거됐고(difference) AND 새 서브클래스에 들어온(intersection)" 필드 집합을 구한 뒤,
  - 각 `removed_base_field`에 대해 `dependencies.append((base_app_label, base_name, removed_base_field, False))`로 필드-레벨 의존성을 추가한다.
  - 4번째 인자 `False`(필드 변경/제거에 의존, 모델 생성 아님)가 RemoveField를 가리켜 그 연산이 이 CreateModel보다 먼저 오도록 강제한다. `from_state`를 써야 제거 전 필드를 볼 수 있는 점이 핵심(`to_state`엔 이미 사라짐) — hints에서도 Nan Liu가 정확히 이 함정에 막혔다. `get()` 사용으로 베이스 상태가 없을 때 None 안전.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_add_model_with_field_removed_from_base_model (migrations.test_autodetector.AutodetectorTests)`. Readable(title 보유) → Readable(필드 없음) + Book(`bases=('app.readable',)`, title 보유)로 바뀔 때 연산 순서를 검증.
- **픽스 증명**: before/after `ModelState`를 `get_changes()`에 넣고 — `assertNumberMigrations(changes, 'app', 1)`(단일 마이그레이션), `assertOperationTypes(... ['RemoveField', 'CreateModel'])`(정확한 순서), `assertOperationAttributes(... 0, 0, name='title', model_name='readable')`(첫 연산이 readable.title 제거), `assertOperationAttributes(... 0, 1, name='book')`(둘째가 book 생성). 픽스 전이면 의존성이 없어 순서가 `['CreateModel', 'RemoveField']`로 뒤집혀 `assertOperationTypes`에서 fail.
- **overfit 관점**: FAIL_TO_PASS가 1개라 얇아 보이지만, 픽스는 special-case(예: 필드명 `title` 하드코딩, Book만 처리)가 아니라 `from`−`to`−`∩` 일반식이라 임의 필드 이동에 일반화된다. CEGIS(S4) 위험은 낮다 — 골드가 집합 연산으로 입력공간을 정칙하게 덮기 때문. 단, 단일 테스트만으론 "두 서브클래스가 같은 필드를 동시에 옮길 때 RemoveField 1개로 수렴"하는 경로(hints가 명시한 Magazine 케이스)는 직접 커버되지 않는다 — overfit-risk를 달지 않은 이유는 픽스 형태가 그 케이스도 자연히 단일 의존 타깃으로 수렴시키기 때문(중복 dependency가 같은 노드를 가리킴).
- **regression 관점**: PASS_TO_PASS 112개가 autodetector의 인접 동작 전반(circular dependency, swappable, proxy, MTI inheritance removal, foreign-key ordering, foo_together ordering 등)을 지켜본다. 새 의존성이 `removed_base_fields`(difference∩서브클래스 필드)로 엄격히 좁혀져 있어 필드 이동이 없는 일반 생성/삭제 경로는 빈 집합 → 추가 엣지 0 → 기존 순서 불변. 이 좁힘이 regression-trap을 막는 핵심.

## 모범답안 (오라클 기반)
오라클(골드+테스트)을 본 입장에서 이상적 풀이 궤적:

1. **localize 경로**: 이슈 신호 "makemigrations는 OK인데 migrate가 FieldError" + "CreateModel(Book) → RemoveField(Readable.title) 순서" + "auto-detector should be able to use this order" → 증상은 런타임이지만 원인은 **연산 순서를 정하는 자동 감지기**임을 추론. `FieldError ... clashes with field of the same name from base class`를 grep하면 모델 메타 검증부로 가지만, 그건 정당한 검증이고 고칠 곳이 아니다. 올바른 경로는 마이그레이션 **연산 순서 = 의존성 그래프**라는 도메인 이해로 `autodetector.py`의 `generate_created_models`에서 `bases` 문자열을 분해해 `dependencies`에 append하는 루프로 수렴.

2. **픽스와 일반화 정당성**: 필드 충돌 자체를 회피(예: 생성 시 베이스 필드 무시)하지 말고, "이동되는 필드의 RemoveField가 CreateModel보다 선행"하도록 의존성 엣지를 추가한다. "이동되는 필드"의 정확한 정의가 핵심: `from_state` 베이스 필드 − `to_state` 베이스 필드(= 베이스에서 빠진 것) ∩ 새 서브클래스 필드(= 거기로 들어온 것). 이 2단계 집합 교차가 올바른 일반화인 이유 — (a) 필드명/모델명에 비의존적, (b) 베이스에서 빠졌지만 서브클래스로 안 간 필드(순수 삭제)는 ∩에서 걸러져 불필요한 엣지를 안 만듦, (c) 순수 생성(이동 없음)은 difference가 비어 빈 집합 → no-op. special-case가 아니라 불변식이다.

3. **regression 안전**: 112개 P2P가 안 깨져야 한다. 특히 `Bases of other models come first`, `test_circular_dependency_*`, `test_proxy_*`, `test_mti_inheritance_model_removal`, `test_foreign_key_removed_before_target_model` 같은 순서/의존 민감 테스트. 새 엣지가 `removed_base_fields`(빈 집합이 디폴트)로 좁혀져 있어 필드 이동이 없는 모든 경로에서 추가 의존이 0이라 토폴로지 정렬 결과 불변 — 이게 안전의 근거. `get()`로 베이스 상태 None을 흡수해 베이스가 같은 run에 없을 때 크래시 안 함.

4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (1) **`to_state`에서 베이스 필드를 찾기**: 이미 제거돼 비어 있어 difference가 항상 공집합 → 픽스가 아무 효과 없음(hints에서 실제로 막힌 함정). 반드시 `from_state`로 제거 전 상태를 봐야 함. (2) **키 튜플 대소문자**: `(app_label, name)`이 소문자여야 `self.from_state.models`에서 조회됨(hints 명시). (3) **증상을 고치려는 오판**: FieldError를 던지는 모델 검증부나 operations 실행기를 건드리면 정당한 안전장치를 깨고 회귀 양산. (4) **의존성을 너무 넓게**: difference만 쓰고 `∩ model_state.fields`를 빼먹으면 순수 삭제 필드까지 의존에 들어가 무관한 순서를 흔들어 P2P 회귀. (5) **중복 RemoveField 걱정으로 과도한 dedup 추가**: 두 서브클래스가 같은 필드를 옮겨도 의존성이 동일 `(base, base, field, False)` 노드를 가리켜 자연히 단일 RemoveField로 수렴하므로 별도 dedup 불필요(hints 확인).
