---
instance_id: django__django-11815
repo: django/django
base_commit: e02f67ef2d03d48128e7a118bf75f0418e24e8ac
version: "3.1"
difficulty: 15 min - 1 hour
created_at: 2019-09-24T21:45:36Z
fail_to_pass: 2
pass_to_pass: 44
gold_files: [django/db/migrations/serializer.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-11815

## 문제 요약
Enum 객체를 CharField의 default 값으로 쓰면, 생성된 마이그레이션 파일이 Enum의 이름(name)이 아니라 값(value)을 사용해 직렬화한다(`Status('Good')`). Enum 값이 `gettext_lazy`로 번역 가능한 문자열이면, 언어를 바꿔 번역이 적용된 순간 그 값은 더 이상 Enum 멤버가 아니게 되어 기존 마이그레이션이 `ValueError: 'Good' is not a valid Status`로 깨진다. 사용자는 번역에 불변인 멤버 이름을 써서 `Status['GOOD']` 형태로 직렬화되길 기대한다. 이슈 본문에 재현 코드와 기대 출력(`Status['GOOD']`)이 모두 명시되어 있다.

## 유형 (정형화)
- **L0 (Pinpointed)** — problem_statement가 "generated migration file" + "Enum" + "default value" + 기대 출력 `Status['GOOD']`를 직접 적어준다. `grep EnumSerializer` 또는 `grep serializer_factory(self.value.value)` 한 방이면 `django/db/migrations/serializer.py`의 단일 함수 `EnumSerializer.serialize`에 즉시 도달. 탐색 노력이 거의 0.
- **S2 (Constraint-Reasoning)** — 위치는 자명하나 "올바른 직렬화 식"을 추론으로 합성해야 한다. 후보 패치를 막 던져서 통과시키는 G&V가 아니라, "value는 번역에 가변 → 불변 식별자는 멤버 name → 따라서 `EnumClass[name]` 인덱싱 형태"라는 불변식 추론이 픽스를 결정한다. 실제로 hints의 1차 다이프(`'%s' % self.value` → `EnumClass.GOOD` 문자열)가 틀렸고, `self.value.name`+`%r`이라는 정확한 식으로 좁혀지는 과정 자체가 constraint reasoning이다. overfit 위험은 낮음(올바른 식이 결정적이라 special-case로 통과할 여지가 적다).
- **K-Domain (Domain-bound)** — django migrations serializer 서브시스템의 계약 지식이 병목. "마이그레이션 직렬화 결과는 import 가능하고 시간이 지나도 재구성 가능한 코드여야 한다"는 도메인 불변식, 그리고 `EnumSerializer`/`serializer_factory` dispatch 구조를 알아야 `re.RegexFlag`도 같은 경로를 탄다는 점까지 본다. 순수 파이썬 추론(K-Gen)만으론 "왜 name이 정답인지"를 도메인 계약 없이는 못 정당화.
- **primary type: T-ConstraintReason** — 위치는 L0로 명확하지만 진짜 난점은 "값 직렬화 → 이름 인덱싱"으로의 올바른 식 합성에 있다. T-DirectMap(기계적 가드/상수 변경)이 아니라, 직렬화 표현의 의미적 불변식을 따져 식을 바꾸는 S2 추론이 dominant.

## 난이도 티어
**T3 (중간).** 구조적 피처:
- 파일 1개(`serializer.py`) / 함수 1개(`EnumSerializer.serialize`) / 실질 3줄 변경 → scope는 매우 작다(T1~T2 방향).
- localize 직접성 L0 + has-repro(이슈에 재현 코드와 기대 출력 존재) → easiness 신호 강함.
- 그러나 **S2 식 합성의 함정**이 티어를 위로 민다: `self.value`(→ `EnumClass.GOOD`) vs `self.value.name`(→ `GOOD`) 혼동, `%s` vs `%r` 따옴표 처리(`['GOOD']` 정확 일치), 그리고 값 직렬화 제거에 따른 `serializer_factory`/`v_imports` 정리까지 정확히 맞춰야 한다.
- **P2P trap(regression-trap)**: PASS_TO_PASS 44개가 거의 전부 같은 `test_writer.py`의 다른 직렬화 케이스 → 직렬화 출력 포맷을 잘못 바꾸면 인접 테스트가 줄줄이 깨진다. 또한 2번째 FAIL_TO_PASS(`re.RegexFlag`)가 동일 직렬화기를 공유한다는 점을 놓치면 부분 실패.
- 공식 라벨 "15 min - 1 hour"와 일치하는 방향(중간). 공식 라벨을 prior로 받되, scope만 보면 T2로 내려갈 수 있으나 식 합성의 정밀성 요구 + 넓은 P2P 인접 위험 때문에 T3로 둔다. T4까지 가지 않는 이유는 cross-file 조율이나 깊은 도메인 call-chain이 없고 단일 헌크라서.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/migrations/serializer.py` : `EnumSerializer.serialize`
- **근본 원인**: 기존 코드는 `v_string, v_imports = serializer_factory(self.value.value).serialize()`로 Enum의 **값**을 직렬화하고 `"%s.%s(%s)" % (module, enum_class.__name__, v_string)` 즉 `EnumClass(value)` 호출 형태를 만들었다. 값이 `gettext_lazy` 번역 가능 문자열이면 다른 언어 로케일에서 그 값으로 멤버를 못 찾아 `ValueError: 'x' is not a valid EnumClass`로 깨진다. 직렬화 표현이 시간/로케일에 불변이어야 한다는 마이그레이션 계약 위반.
- **수정 요지**: 값 대신 멤버 **이름**으로 인덱싱하도록 변경.
  - `'%s.%s[%r]' % (module, enum_class.__name__, self.value.name)`을 반환 → `EnumClass['GOOD']` 생성. `%r`로 이름 문자열을 따옴표 안전하게 감싼다(`['GOOD']`).
  - imports를 `{'import %s' % module}`만 남긴다. 값 자체를 직렬화하지 않으므로 `serializer_factory(self.value.value)` 호출과 `v_imports` 병합이 통째로 제거됨.
  - 이름은 번역·언어와 무관한 멤버 식별자이므로 `EnumClass['NAME']`은 모든 로케일에서 항상 동일 멤버로 재구성된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**:
  - `test_serialize_enums` — `TextEnum`/`BinaryEnum`/`IntEnum` 및 신규 추가된 `TextTranslatedEnum`(값이 `_()` lazy)을 직렬화해 결과가 `migrations.test_writer.TextEnum['A']` 형태(이름 인덱싱)인지 확인. CharField/IntegerField의 `choices`+`default` 직렬화 문자열도 `TextEnum['A']`, `IntEnum['B']` 형태를 기대.
  - `test_serialize_class_based_validators` — `RegexValidator(..., flags=re.S)`가 `re.RegexFlag(16)`이 아니라 `re.RegexFlag['DOTALL']`로 직렬화되는지 확인. `re.RegexFlag`도 `enum.IntFlag`라 동일 `EnumSerializer` 경로를 타기 때문.
- **픽스 증명**: 새로 추가된 번역 가능 `TextTranslatedEnum.A`가 `['A']`(이름)로 직렬화되는지 직접 검증한다. 이름 기반이면 값이 어떻게 번역되든 멤버 조회가 항상 성공하므로 근본 원인(value 의존)이 제거됨을 증명. 재현 입력 `Status.GOOD` → 기대 출력 `...Status['GOOD']`.
- **overfit 관점**: FAIL_TO_PASS가 4종 enum(Text/Translated/Binary/Int) + RegexFlag을 커버해 입력공간이 넓다. `IntEnum['B']`까지 요구하므로 "번역 문자열만 special-case"로 우회하는 overfit 패치는 통과 불가 → overfit-risk 낮음(플래그 미부여).
- **regression 관점**: PASS_TO_PASS 44개가 동일 `test_writer.py`의 인접 직렬화 케이스(strings/numbers/datetime/collections/functions 등). 직렬화기 dispatch나 import 집합을 잘못 건드리면 광범위 회귀 → regression-trap 부여.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 "generated migration file uses value instead of name" + 기대 출력 `Status['GOOD']` 신호 → `django/db/migrations/`에서 직렬화 담당을 찾는다. `grep -r "EnumSerializer\|enum" django/db/migrations/serializer.py`로 `EnumSerializer.serialize` 단일 함수에 즉시 수렴(L0). 이슈가 `EnumClass(value)` vs `EnumClass['NAME']`을 명시하므로 후보 탐색 불필요.
2. **픽스(올바른 일반화인 이유)**: 반환식을 `'%s.%s[%r]' % (module, enum_class.__name__, self.value.name)`으로 교체. 핵심은 "직렬화 결과가 시간/로케일에 불변이어야 한다"는 불변식 → 멤버 **name**은 소스 코드의 식별자라 번역·언어 변경에 절대 불변이고, value는 가변. 따라서 모든 Enum(IntEnum 포함)에 name 인덱싱을 적용하는 게 special-case 패치가 아닌 올바른 일반화다. `%r`을 쓰는 이유는 name을 따옴표로 감싸 유효한 인덱싱 리터럴(`['GOOD']`)을 만들기 위함.
3. **regression 안전**: 값을 더 이상 직렬화하지 않으므로 `serializer_factory(self.value.value)` 호출과 `v_imports`를 함께 제거하고 imports를 `{'import %s' % module}`로 정리해야 한다 — 이걸 안 하면 import 비교 테스트가 깨진다. `re.RegexFlag`가 같은 경로를 공유하므로 두 FAIL_TO_PASS가 한 수정으로 동시 통과. PASS_TO_PASS 44개(다른 타입 직렬화)는 `EnumSerializer`만 건드리므로 영향받지 않음을 확인.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) `self.value`를 그대로 `%s`로 포맷하면 `EnumClass.GOOD` 문자열이 나와 인덱싱 리터럴이 아님(hints의 폐기된 1차 다이프) → 반드시 `self.value.name`. (b) `%s` vs `%r` 혼동으로 따옴표 누락 시 테스트의 정확 문자열(`['A']`) 불일치. (c) `re.RegexFlag` 케이스가 동일 직렬화기를 공유한다는 점을 못 보고 enum 전용 분기만 손대면 2번째 FAIL_TO_PASS를 놓침. (d) value 직렬화 제거를 잊고 `serializer_factory` 호출을 남기면 dead computation + import 집합 불일치로 회귀.
