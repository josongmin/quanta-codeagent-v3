---
instance_id: django__django-15380
repo: django/django
base_commit: 71e7c8e73712419626f1c2b6ec036e8559a2d667
version: 4.1
difficulty: <15 min fix
created_at: 2022-01-31T19:44:44Z
fail_to_pass: 1
pass_to_pass: 133
gold_files: [django/db/migrations/autodetector.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-15380

## 문제 요약
한 번의 `makemigrations`에서 모델 rename과 그 모델의 필드 rename을 동시에 하면 autodetector가 `KeyError`로 크래시한다. 모델 rename 질문에 `y`로 답하면 `generate_renamed_fields()`에서 `self.to_state.models[app_label, old_model_name]` 조회가 옛 모델명으로 들어가는데, to_state는 이미 새 모델명으로 키가 바뀐 상태라 `KeyError: ('test_one', 'mymodel')`이 난다. problem_statement에 네이티브 traceback과 회귀 커밋(`aa4acc164d1247c0de515c959f7b09648b57dc42`)까지 명시되어 있다. 기대 동작은 `RenameModel` + `RenameField` 두 오퍼레이션의 정상 생성.

## 유형 (정형화)

**L (Localization) = L0 — Pinpointed.** problem_statement의 traceback이 파일·함수·라인을 직접 지목한다: `django/db/migrations/autodetector.py`, `generate_renamed_fields`, line 823, 그리고 실패 표현식 `new_model_state = self.to_state.models[app_label, old_model_name]`까지. grep 한 방. "Regression in <sha>"로 회귀 출처도 박혀 있어 디핑까지 가능하다.

**S (Repair Strategy) = S1 (+S2) — Direct-Map + 경량 Constraint-Reasoning.** 픽스 자체는 `old_model_name` → `model_name` 한 심볼 치환의 기계적 수정(S1)이다. 다만 "왜 to_state만 새 이름이고 from_state는 옛 이름인가"라는 상태별 키 불변식을 한 번 따져야 올바른 한쪽만 고친다는 점에서 가벼운 S2가 보조로 붙는다. GenProg식 다회 시도(S3)나 테스트 너머 일반화(S4)는 불필요 — 결함 클래스가 "비대칭 키 조회"로 정형화된다.

**K (Knowledge) = K-Domain.** django migrations autodetector의 `from_state`/`to_state` 모델 레지스트리 의미와 `renamed_models` 매핑 규칙(rename되면 to_state는 새 키, from_state는 옛 키)을 알아야 어느 쪽이 옳은지 판정된다. 일반 파이썬 추론만으로는 "둘 다 같은 변수를 쓰는 게 자연스러워 보이는" 함정에 빠진다.

**Primary type = T-DirectMap.** 위치가 L0로 자명하고 픽스가 단일 심볼 교체의 기계적 매핑이므로 T-DirectMap. T-LocTrivial(S1+자명)에 근접하나, 어느 쪽 조회를 고칠지 결정하는 데 도메인 키-불변식 한 단계가 끼어 완전 자명은 아니라 DirectMap이 정확하다. T-DomainBound로 끌릴 수 있으나 도메인 지식은 "판정 게이트" 1회일 뿐 병목이 아니다.

## 난이도 티어
**Tier = T2 (쉬움).** 구조적 피처: 소스 1파일 / 1라인 / 단일 헌크, L0(traceback이 라인까지 지목), has-repro(네이티브 스택트레이스). 이 셋은 모두 강한 easiness 신호다. 픽스는 S1 한 심볼 교체. T1(존나쉬움)이 아닌 이유는 K-Gen이 아니라 K-Domain이고, "두 줄 다 old_model_name이 자연스러워 보이는" 비대칭 판정(경량 S2)이 한 번 필요해 픽스가 완전 자명하진 않기 때문이다. T3 이상으로 올리지 않는 이유는 localize 노력이 사실상 0이고 실질 추론량이 1스텝에 그치기 때문.

공식 라벨(`<15 min fix`)과 일치한다 — 개발자 구현시간 기준에서도 한 줄 픽스다. 다만 라벨이 안 잡는 리스크가 하나 있다: 133개의 광범위한 PASS_TO_PASS(`regression-trap`). autodetector의 rename/proxy/m2m/order 검출 동작 전반을 안 깨야 한다. 비대칭 판정을 잘못해 from_state 쪽까지 손대면 무관한 rename 테스트군이 무더기로 깨질 수 있어, 시간라벨보다 약간의 주의가 더 든다 — 그래도 T2 상한 내.

## 골드패치 분석
- **건드린 파일·함수:** `django/db/migrations/autodetector.py` 의 `generate_renamed_fields(self)`.
- **근본 원인:** 같은 루프 안에서 `old_model_name = self.renamed_models.get((app_label, model_name), model_name)`로 옛 모델명을 푼 뒤, `from_state`(옛 상태)와 `to_state`(새 상태)를 **둘 다 `old_model_name`으로** 조회했다. 회귀 커밋 `aa4acc164d`이 `new_model_state` 조회의 키를 `old_model_name`으로 바꿔버린 것이 원인. 모델이 동시에 rename되면 `old_model_name != model_name`이 되고, to_state에는 이미 새 이름만 존재하므로 `self.to_state.models[app_label, old_model_name]`에서 `KeyError`. rename이 없을 때는 old==new라 버그가 잠복했다(그래서 회귀가 통과해 머지됨).
- **수정 요지:** 단 한 줄 — `new_model_state = self.to_state.models[app_label, old_model_name]` → `self.to_state.models[app_label, model_name]`. from_state는 옛 키(`old_model_name`)로, to_state는 새 키(`model_name`)로 조회하는 상태별 비대칭을 복원한다. old_model_state 줄은 그대로 둔다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_rename_field_with_renamed_model (migrations.test_autodetector.AutodetectorTests)`. `Author(name)` 모델을 `RenamedAuthor(renamed_name)`으로 모델·필드 **동시** rename하는 시나리오.
- **픽스 증명:** `MigrationQuestioner({'ask_rename_model': True, 'ask_rename': True})`로 두 rename 질문 모두 yes 응답 → 정확히 버그 트리거 경로(old≠new). 픽스 전에는 `generate_renamed_fields`에서 `KeyError` 크래시. 픽스 후에는 testapp에 마이그레이션 1개, 오퍼레이션 타입 `['RenameModel', 'RenameField']` 순서, 그리고 `old_name='Author'→new_name='RenamedAuthor'`, `old_name='name'→new_name='renamed_name'` 속성을 단언한다. 단순 no-crash가 아니라 두 오퍼레이션의 생성·순서·속성까지 검증해 픽스가 "올바른 결과"를 내는지 확인한다.
- **overfit 관점:** FAIL_TO_PASS 1개로 얇지만, 골드 픽스가 1심볼 교체라 special-case로 통과시킬 표면이 없다(테스트만 만족시키는 가짜 분기를 끼울 자리가 없음). overfit 위험은 낮다 — `overfit-risk` 플래그 미부여.
- **regression 관점:** 133개 PASS_TO_PASS가 autodetector 전반(기존 rename_field/rename_model/proxy/m2m/swappable/order_with_respect_to 등)을 커버. `regression-trap` 부여. to_state만 고치는 비대칭이 정답이며, from_state까지 동시 변경하면 이 광범위 회귀군이 무너진다.

## 모범답안 (오라클 기반)

1. **Localize 경로:** problem_statement의 traceback을 그대로 따라간다 — `autodetector.py:823 generate_renamed_fields`, 실패 표현식 `self.to_state.models[app_label, old_model_name]`, `KeyError: ('test_one','mymodel')`. "Regression in aa4acc164d"를 보고 해당 커밋 diff를 확인하면 `new_model_state` 키가 `model_name`→`old_model_name`으로 바뀐 것이 바로 보인다. 탐색 비용 ≈ 0.

2. **픽스와 일반화 근거:** to_state 조회 키를 `old_model_name`→`model_name`으로 되돌린다. 이게 overfit이 아닌 올바른 일반화인 이유: `from_state`는 마이그레이션 이전 모델셋이라 **옛** 이름으로 키가 잡히고, `to_state`는 이후 모델셋이라 **새** 이름으로 잡힌다 — `renamed_models` 매핑이 이 비대칭을 표현한다. 따라서 from_state=`old_model_name`, to_state=`model_name`은 특정 테스트가 아니라 "rename 여부와 무관하게 항상 성립하는" 구조적 불변식이다(rename 없을 땐 두 이름이 같아 자동 일치). 회귀 전 코드와 의미적으로 동일.

3. **Regression 안전:** 133개 P2P 중 특히 `test_rename_field`/`test_rename_model`/`Tests autodetection of renamed models...`/case-insensitive rename 계열을 안 깨야 한다. to_state만 고치고 old_model_state 줄을 건드리지 않으면, rename 없는 경로(old==new)에서는 동작이 비트 단위로 동일하고 rename 경로만 정상화되므로 이들이 전부 보존된다.

4. **함정 회피:** 오라클 없는 에이전트의 최대 실수는 "두 줄이 똑같이 `old_model_name`을 쓰는 게 일관돼 보여서" 양쪽을 같은 변수로 맞추거나, from_state 쪽을 `model_name`으로 바꾸는 과교정이다. 회피법: from_state/to_state가 각각 어느 시점 모델셋인지, `renamed_models.get(...)`가 무엇을 푸는지 한 번만 확인하면 "to_state만 새 이름"이라는 비대칭이 곧장 드러난다. 또 단순히 `try/except KeyError`로 크래시를 삼키는 미봉책은 RenameField 오퍼레이션 자체를 누락시켜 FAIL_TO_PASS의 오퍼레이션 단언에서 탈락한다 — 키를 올바르게 고치는 것만이 정답.
