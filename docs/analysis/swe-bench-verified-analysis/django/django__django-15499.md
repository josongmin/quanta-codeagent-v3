---
instance_id: django__django-15499
repo: django/django
base_commit: d90e34c61b27fba2527834806639eebbcfab9631
version: 4.1
difficulty: <15 min fix
created_at: 2022-03-10T22:32:35Z
fail_to_pass: 1
pass_to_pass: 35
gold_files: [django/db/migrations/operations/models.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L0
repair_strategy: S1 (+S6)
knowledge: K-Domain
flags: [regression-trap]
---

# django__django-15499

## 문제 요약
마이그레이션 최적화(optimizer) 단계에서 `CreateModel` + `AlterModelOptions`는 옵션이 합쳐진 단일 `CreateModel`로 축약된다. 같은 패턴으로 `CreateModel` + `AlterModelManagers`도 managers가 합쳐진 단일 `CreateModel`로 축약될 수 있는데, 이 reduce 케이스가 누락되어 있다. 결과적으로 잘못된 결과는 아니지만 최적화가 안 되어 불필요하게 두 operation이 마이그레이션에 남는 silent-suboptimal 상태다. 이슈 본문 자체가 `AlterModelOptions` 선례를 명시하며 "similarly ... can become just CreateModel"이라고 픽스 방향을 거의 적어준다.

## 유형 (정형화)

**L (Localization) = L0 (Pinpointed).** 이슈가 `AlterModelOptions` 흡수 선례를 직접 호명하므로 `grep AlterModelOptions django/db/migrations/operations/models.py` → `CreateModel.reduce()`의 `elif` 사다리로 grep 한 방에 도착한다. 직접 포인터가 본문에 박혀 있어 탐색 노력 0.

**S (Repair Strategy) = S1 Direct-Map (+S6 Design-Refactor 약).** dominant는 S1: 기존 `AlterModelOptions` 분기를 템플릿 삼아 `options`→`managers`로 치환한 새 `elif`를 추가하는, 사실상 결함클래스("누락된 흡수 케이스")에 대한 템플릿 매칭이다. 보조 S6는 reduce 사다리에 분기를 끼워넣는 작은 구조 변경 성격(병합 후 새 `CreateModel`을 collect-then-return) 때문이지만, 한 줄 식 합성이 아니라 이미 존재하는 패턴의 미러링이라 S2(추론합성)는 아니다. APR 관점에서 PAR/TBar식 fix-pattern 적용(인접 분기를 fix template로 재사용)이 정확히 들어맞는다 — 올바른 식을 "생각으로 합성"할 필요 없이 선례를 변형 복제한다.

**K (Knowledge) = K-Domain.** django migration optimizer의 reduce 프로토콜(operation 흡수 규칙, `name_lower` 동일성으로 같은 모델 판정, `CreateModel`이 `fields`/`options`/`bases`/`managers`를 모두 보유한다는 모델), 그리고 `AlterModelManagers`가 managers를 누적이 아니라 전체 치환한다는 의미론을 알아야 한다. 일반 파이썬 추론만으로는 "왜 managers만 갈아끼우고 나머지는 self에서 가져오는가"를 정당화할 수 없다.

**Primary type = T-DomainBound.** 위치는 명확(L0)하고 픽스도 기계적(S1)이지만, 정답을 올바르게 만드는 병목은 django 옵티마이저 내부지식(K-Domain)에 있다. T-DirectMap 후보였으나, 반환 `CreateModel`의 인자 매핑(`managers`=operation 측, 나머지=self 측)이 프레임워크 의미론에 의존해 결정되므로 K-Domain이 dominant한 T-DomainBound로 분류한다.

## 난이도 티어
**T3 (중간).**

이 티어로 미는 구조적 피처:
- 단일 파일(`django/db/migrations/operations/models.py`) · 단일 함수(`CreateModel.reduce()`) · 13줄 추가. patch scope는 T1/T2급으로 작다.
- localize 직접성 L0 — 이슈가 선례를 호명해 탐색 비용 거의 0.
- 그러나 **regression-trap**: PASS_TO_PASS 35개가 전부 동일 `OptimizerTests`/reduce 경로(`test_create_alter_model_options`, `test_alter_alter_*_model`, `test_create_alter_*_field` 등)에 몰려 있어, reduce 사다리에 분기를 잘못 끼워넣으면(순서·조건) 인접 흡수 케이스를 깨기 쉽다. 광범위·동일서브시스템 P2P가 난이도를 끌어올린다.
- K-Domain 병목 — 반환 인자 매핑이 프레임워크 의미론에 의존.

공식 라벨은 `<15 min fix`(T1~T2 prior). 다르게 매긴 이유: 시간라벨은 "선례 복붙"이라는 구현 용이성만 반영하고, (a) 35개 동일경로 P2P regression-trap과 (b) 옵티마이저 의미론 K-Domain 의존을 잡지 못한다. 루브릭상 "약한 P2P trap 또는 K-Domain 중 하나"는 T4로도 밀 수 있으나, localize가 L0로 거의 자명하고 픽스가 선례 미러링이라 추론·overfit 위험이 낮아 T3으로 고정한다.

## 골드패치 분석
- **건드린 파일/함수:** `django/db/migrations/operations/models.py` : `CreateModel.reduce(self, operation, app_label)`
- **근본 원인:** `CreateModel.reduce()`에 `AlterModelOptions`, `AlterTogetherOptionOperation`, `AlterModelTable` 등 같은 모델(`self.name_lower == operation.name_lower`)을 대상으로 한 operation을 `CreateModel`로 흡수하는 `elif` 분기들은 있었지만 `AlterModelManagers`를 흡수하는 분기가 빠져 있었다. 그래서 옵티마이저가 `CreateModel`+`AlterModelManagers` 조합을 병합하지 못하고 두 operation을 그대로 남긴다.
- **수정 요지:** `AlterModelOptions` 분기 바로 뒤(`AlterTogetherOptionOperation` 분기 앞)에 다음 `elif`를 추가 —
  `isinstance(operation, AlterModelManagers) and self.name_lower == operation.name_lower` 매칭 시, `CreateModel(self.name, fields=self.fields, options=self.options, bases=self.bases, managers=operation.managers)` 하나를 반환. 즉 `name`/`fields`/`options`/`bases`는 기존 `self`에서 보존하고 `managers`만 `operation.managers`로 전체 치환한 새 `CreateModel`을 돌려준다. `AlterModelOptions` 분기를 managers 버전으로 미러링한 것.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_create_alter_model_managers (migrations.test_optimizer.OptimizerTests)`
- **동작/픽스 증명:** `assertOptimizesTo()`로 입력 `[CreateModel("Foo", fields=[]), AlterModelManagers(name="Foo", managers=[("objects", Manager()), ("things", Manager())])]`를 주면 기대 출력은 managers가 합쳐진 단일 `CreateModel("Foo", fields=[], managers=[("objects", ...), ("things", ...)])` 하나뿐임을 단언한다. 픽스 전엔 reduce가 두 operation을 그대로 남겨 길이/내용 불일치로 실패, 픽스 후 한 operation으로 축약되어 통과.
- **overfit 관점:** FAIL_TO_PASS가 1개로 얇지만, 픽스가 선례(`AlterModelOptions`) 패턴의 직접 미러라 special-case 하드코딩 여지가 거의 없다(`name_lower` 동일성 검사로 일반 모델에 일반화됨). overfit-risk 플래그를 달지 않는다 — special-case로만 통과시키는 변종 패치는 PASS_TO_PASS 인접 케이스와 충돌해 걸러진다.
- **regression 관점:** PASS_TO_PASS 35개가 모두 동일 `OptimizerTests`/reduce 경로다. 추가한 `elif`가 기존 `AlterModelOptions`/`AlterTogetherOptionOperation`/`AlterModelTable` 분기와 조건이 배타적(서로 다른 `isinstance`)이라 인접 흡수 케이스를 건드리지 않음을 이 P2P 묶음이 보증한다. → regression-trap 플래그.

## 모범답안 (오라클 기반)

1. **Localize 경로:** 이슈 본문의 "CreateModel + AlterModelOptions is reduced to just CreateModel ... Similarly, CreateModel + AlterModelManagers"가 결정적 신호. `grep -n AlterModelOptions django/db/migrations/operations/models.py`로 `CreateModel.reduce()` 내부 `elif isinstance(operation, AlterModelOptions) ...` 분기를 즉시 찾는다(L0). 이 분기가 정확히 따라 쓸 템플릿.

2. **픽스와 올바른 일반화 이유:** `AlterModelOptions` 분기를 복제해 `isinstance` 타깃을 `AlterModelManagers`로, 반환 `CreateModel`에서 바뀌는 키만 `options`→`managers`로 바꾼다. 핵심은 인자 출처: `managers=operation.managers`(Alter가 들고 온 새 managers 전체 치환), 나머지 `name/fields/options/bases`는 `self.*`(원래 CreateModel 보존). 이것이 올바른 일반화인 이유 — `AlterModelManagers`는 managers를 누적이 아니라 전체 재정의하므로 `operation.managers`가 곧 최종값이고, `self.name_lower == operation.name_lower` 가드가 "같은 모델"에만 적용되도록 임의 입력으로 일반화한다(특정 테스트값에 묶이지 않음).

3. **Regression 안전:** 새 `elif`는 기존 분기들과 `isinstance` 타입이 겹치지 않아 배타적이고, `AlterModelOptions`(options 흡수)/`AlterTogetherOptionOperation`(unique·index together)/`AlterModelTable`(db_table) 흡수 경로를 변경하지 않는다. PASS_TO_PASS의 `test_create_alter_model_options`, `test_alter_alter_*_model`, `test_create_alter_*_field` 등 35개가 모두 통과 유지됨을 확인해야 한다. 분기를 사다리 어디에 넣든 배타적이지만, 가독성·선례 일관성을 위해 `AlterModelOptions` 바로 뒤에 배치.

4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (a) 반환 `CreateModel`에서 `options`나 `bases`를 실수로 `operation.*`에서 가져오기(`AlterModelManagers`엔 options/bases가 없거나 무관 → AttributeError 또는 잘못된 병합). 항상 "Alter가 바꾸는 축만 operation, 나머지는 self" 규칙으로 매핑. (b) `name`을 `operation.name`(소문자화 가능성)으로 쓰면 케이스 손상 — `self.name` 유지. (c) managers를 기존 self.managers와 합치려는 누적 시도 — `AlterModelManagers`는 전체 치환이므로 `operation.managers` 단순 대입이 정답. (d) `name_lower` 동일성 가드를 빠뜨려 다른 모델까지 흡수 — 반드시 조건에 포함. 가장 안전한 전략은 인접 `AlterModelOptions` 분기를 그대로 복제 후 `options`→`managers` 한 축만 치환하는 패턴 모방.
