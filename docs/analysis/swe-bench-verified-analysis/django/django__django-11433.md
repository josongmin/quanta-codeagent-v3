---
instance_id: django__django-11433
repo: django/django
base_commit: 21b1d239125f1228e579b1ce8d94d4d5feadd2a6
version: "3.0"
difficulty: <15 min fix
created_at: 2019-05-31T17:06:20Z
fail_to_pass: 1
pass_to_pass: 142
gold_files: [django/forms/models.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap]
---

# django__django-11433

## 문제 요약
ModelForm 제출 시, 어떤 필드가 data payload에 없고(예: 폼에 포함 안 됨, 다른 필드에서 파생되는 값) 그 필드가 모델에 default가 있으면, `clean()`에서 `self.cleaned_data['some_field'] = ...`로 값을 채워 넣어도 그 값이 무시되고 모델 default가 들어간다. 사용자는 `cleaned_data`를 수정하면 그게 인스턴스에 반영되길 기대하지만(이게 `cleaned_data` 패러다임), 현재는 raw data를 복사·덮어써야만 했다. 즉 `cleaned_data`로 모델 default를 오버라이드할 수 없는 게 증상. 예외 없이 조용히 잘못된 값(default)이 저장되는 silent-wrong 결함.

## 유형 (정형화)

**3축 점수**

- **L0 (Localization = Pinpointed)** — 이슈 본문이 "has a default value on the model, it cannot be overwritten with `self.cleaned_data`" + ModelForm save 맥락을 직접 지목한다. "model default + cleaned_data + ModelForm 인스턴스 구성"이라는 세 키워드는 `django/forms/models.py`의 `construct_instance()`로 grep 한 방에 수렴한다. 후보 분기는 `if f.has_default() and ... value_omitted_from_data(...)` 단 하나라 탐색 노력이 사실상 0. → L0.

- **S2 (Constraint-Reasoning)** — 고칠 위치(continue 분기)는 명확하지만, **올바른 추가 조건을 추론으로 합성**해야 한다. 결함은 "data에 값 없음"만 보고 default를 유지하는 over-broad guard이고, 픽스는 "그리고 cleaned_data 값도 여전히 빈 값일 때만"이라는 누락된 conjunct를 채우는 것이다. 핵심은 "빈 값"의 정의를 `not x` truthy나 `x in ('', None)` 하드코딩이 아니라 **`field.empty_values` 멤버십**으로 정확히 표현해야 한다는 점 — 이게 불변식·엣지케이스(`0`/`False`는 빈 값 아님)를 따져 식을 합성하는 SemFix/Angelix류 semantic repair다. G&V로 "이것저것 시도"하는 문제가 아니라 한 번에 올바른 술어를 써야 한다. → S2.

- **K-Domain** — django forms 내부 지식이 병목. `construct_instance`가 `cleaned_data`/`form.data`/`value_omitted_from_data`/`empty_values`를 어떻게 쓰는지, 그리고 default-vs-cleaned_data 우선순위라는 forms 계약을 알아야 한다. 일반 파이썬 추론만으론 `empty_values` API의 존재 자체를 모른다. → K-Domain.

**primary type = T-ConstraintReason** — 위치는 자명(L0)하나 난점이 "올바른 조건식을 추론으로 합성"(S2)하는 데 있고, 그 합성이 django의 `empty_values` 도메인 계약(K-Domain)에 의존한다. localize가 어렵지도(T-DiffuseLoc 아님), 기계적 가드/기본값 치환도(T-DirectMap 아님 — 단순 None가드가 아니라 멤버십 술어를 추론해야 함) 아니다. 스펙은 이슈가 충분히 제공하므로 T-SpecInference도 아니다. dominant 축은 S2 constraint-reasoning.

## 난이도 티어

**T4 (약간 어려움)**

공식 라벨은 `<15 min fix`(T1~T2 prior)이고, 패치 자체는 1파일·1헌크·실질 3줄 추가라 scope만 보면 작다. 그러나 루브릭은 scope가 아니라 구조적·인과적 피처로 재조정한다:

- **localize 직접성**: L0로 매우 쉬움 → 아래로 미는 힘.
- **repair 난이도**: S2 + K-Domain. 올바른 픽스가 `field.empty_values` 멤버십이라는 비자명한 술어이고, 이를 모르면 truthy 검사(`not cleaned_data.get(f.name)`)로 overfit하기 쉽다 → 위로 미는 힘.
- **P2P trap**: PASS_TO_PASS 142개로 매우 넓다. `construct_instance`는 모든 ModelForm save 경로의 핵심 함수라, default 보존 동작(`test_default_populated_on_optional_field`, `test_default_not_populated_on_optional_checkbox_input`, `test_default_not_populated_on_selectmultiple`, `test_prefixed_form_with_default_field` 등)과 m2m/file/unique 등 인접 동작을 하나라도 깨면 대량 회귀 → `regression-trap`. 이 넓은 P2P가 티어를 끌어올리는 결정적 피처.

종합: localize는 T2급으로 쉽지만 "올바른 술어 합성(도메인 API 의존) × 142-wide regression trap"이 결합해 T4로 본다. 공식 시간라벨(`<15 min`)과 어긋나는 이유는, 그 라벨이 "코드를 아는 django 코어 개발자의 구현시간"이라 localize·도메인지식·overfit 술어 선택의 난점을 반영하지 못하기 때문(루브릭 §6, §74-75). 단 멀티파일/멀티헌크/깊은 데이터플로우가 없어 T5까지는 가지 않는다.

## 골드패치 분석

- **건드린 파일/함수**: `django/forms/models.py` → `construct_instance()`
- **근본 원인**: data에 값이 없으면 모델 default를 유지하려고
  ```python
  if (f.has_default() and
          form[f.name].field.widget.value_omitted_from_data(form.data, form.files, form.add_prefix(f.name))):
      continue
  ```
  로 필드 세팅을 건너뛴다. 그런데 이 guard는 **raw data(`form.data`/`form.files`)만** 검사하고, `clean()`이 `cleaned_data`에 채워 넣은 값은 전혀 보지 않는다. 그래서 cleaned_data에 비-빈 값이 있어도 분기가 통째로 skip되어 모델 default가 들어가고 cleaned_data가 조용히 버려진다(over-broad guard).
- **수정 요지**: continue 조건에 세 번째 conjunct를 AND로 추가 —
  ```python
  cleaned_data.get(f.name) in form[f.name].field.empty_values
  ```
  즉 "data에 값 없음(default 후보) **그리고** cleaned_data 값도 여전히 빈 값일 때만" default를 유지하고 skip한다. cleaned_data에 비-빈 값이 들어 있으면 더 이상 skip하지 않고 그 값을 인스턴스에 세팅 → cleaned_data가 default를 오버라이드. `empty_values`(필드별로 정의된 빈값 집합: `[None, '', [], (), {}]` 등)를 써서 "빈 값" 판정을 필드 의미에 맞게 정확히 함.

## 검증 (test_patch)

- **FAIL_TO_PASS (1개)**: `test_default_not_populated_on_non_empty_value_in_cleaned_data` (`model_forms.tests.ModelFormBaseTest`)
- **동작/픽스 증명**: `PublicationDefaults`(mode에 `default='di'`) 기반 `PubForm`을 빈 data `{}`로 생성하고, `clean()`이 `cleaned_data['mode']`를 `mocked_mode`로 덮어쓴다.
  1. `mocked_mode='de'` → `save(commit=False)` 인스턴스의 `mode == 'de'` (비-빈 cleaned_data가 default를 오버라이드 — 새 버그픽스 동작).
  2. 이어서 `pub_form.fields['mode'].empty_values`의 **각 빈 값**에 대해 `subTest`로 `mocked_mode=empty_value`를 넣어 돌리면 인스턴스 `mode == 'di'`(default 유지) — cleaned_data가 빈 값이면 종전대로 default 보존.
  두 방향(비-빈→오버라이드, 빈→default 유지)을 모두 회귀로 고정.
- **overfit 관점**: 테스트가 단일 `'de'` 값이 아니라 `empty_values` **전체를 순회**하므로, `''`/`None`만 하드코딩한 픽스는 다른 빈 값(`[]` 등)에서 깨져 통과 못 한다. 즉 테스트가 골드의 멤버십 검사를 어느 정도 강제 → overfit 여지가 작아 `overfit-risk` 플래그 미부여. 다만 비-빈 값 케이스는 `'de'` 하나뿐이라 FAIL_TO_PASS가 두꺼운 편은 아니다.
- **regression 관점**: PASS_TO_PASS 142개가 `construct_instance`의 기존 default 동작 전체(optional 필드 default populate, checkbox/SelectMultiple/CheckboxSelectMultiple default 미populate, prefixed form, file/m2m/unique save 등)를 커버한다. 추가 conjunct가 AND라 raw-data 기반 default 보존 경로는 cleaned_data가 빈 값인 한 byte-identical로 유지되어 회귀가 막힌다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 "default value on the model … cannot be overwritten with `self.cleaned_data`" + "submitting a form" 신호로 ModelForm save 파이프라인을 본다. `cleaned_data` → instance 매핑을 담당하는 `django/forms/models.py:construct_instance()`로 grep. 그 안에서 default를 다루는 유일 분기 `if f.has_default() and ... value_omitted_from_data(...): continue`를 후보로 확정(L0, 한 방).

2. **픽스와 일반화 근거**: 결함은 guard가 raw data만 보는 over-broad 조건. cleaned_data가 비-빈 값을 가지면 default를 유지하면 안 되므로 `and cleaned_data.get(f.name) in form[f.name].field.empty_values` conjunct를 추가. 이게 올바른 일반화인 이유: "빈 값"을 필드 의미 기준(`empty_values`)으로 정의해 `0`/`False`/`Decimal('0')` 같은 falsy-but-meaningful 값을 빈 값으로 오판하지 않는다. truthy 검사(`not cleaned_data.get(f.name)`)는 이 케이스에서 잘못된 일반화다.

3. **regression 안전**: AND 추가라 cleaned_data가 빈 값인 기존 경로는 불변 — `test_default_populated_on_optional_field`, `test_default_not_populated_on_optional_checkbox_input`, `test_default_not_populated_on_selectmultiple`, `test_default_not_populated_on_checkboxselectmultiple`, `test_prefixed_form_with_default_field` 등이 안 깨져야 하고, conjunct가 부정 분기가 아니라 추가 제약이라 이들은 그대로 통과한다. 넓은 142 P2P 중 file/m2m/unique 경로도 default 분기를 거치므로 동작 보존이 핵심.

4. **함정 회피 (오라클 없는 에이전트)**:
   - (a) cleaned_data를 안 보고 widget/`value_omitted_from_data` 쪽만 손대 default 우선순위를 바꾸려는 오진 → 인접 checkbox/SelectMultiple 동작을 깨뜨림. 정답은 cleaned_data 값 검사 추가.
   - (b) "빈 값"을 `not cleaned_data.get(f.name)`이나 `in ('', None)`로 처리해 `0`/`False`를 빈 값으로 오판 → FAIL_TO_PASS의 `empty_values` 순회 subTest에서 깨짐. 반드시 `in form[f.name].field.empty_values` 멤버십이어야 함.
   - (c) `cleaned_data` 변수 출처(`form.cleaned_data`)와 `f.name` 키를 정확히 잡지 못해 KeyError/엉뚱한 키 참조 → `cleaned_data.get(f.name)`로 안전하게 조회.
