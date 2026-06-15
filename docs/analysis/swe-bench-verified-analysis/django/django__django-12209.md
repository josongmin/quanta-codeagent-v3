---
instance_id: django__django-12209
repo: django/django
base_commit: 5a68f024987e6d16c2626a31bf653a2edddea579
version: 3.1
difficulty: <15 min fix
created_at: 2019-12-12T04:11:05Z
fail_to_pass: 1
pass_to_pass: 0
gold_files: [django/db/models/base.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L0
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [has-repro, regression-trap, cross-file-dep]
---

# django__django-12209

## 문제 요약
PK 필드에 `default`(예: `UUIDField(primary_key=True, default=uuid4)`)가 걸린 모델에서, 명시적 pk 값을 주고 저장할 때 동작이 바뀌었다. Django 2.2까지는 `Sample(pk=existing_pk).save()`가 INSERT 시도 후 UPDATE로 fallback 됐는데, 3.0부터는 두 번 INSERT를 하게 되어 두 번째가 IntegrityError로 실패한다. 이 회귀는 ticket #29260의 "PK-default면 UPDATE 건너뛰고 INSERT 강제" 최적화(커밋 85458e94)가 도입했다. 특히 동일 fixture를 여러 번 로드하는 `loaddata`(serialization raw 저장) 경로를 깨뜨려서, 이미 존재하는 객체를 갱신하지 못한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** 근거: problem_statement가 ticket #29260을 직접 가리키고, hints_text가 회귀 커밋 85458e94를 bisect로 짚으면서 "`_save_table`이 explicit pk일 때 INSERT를 강제하면 안 된다", "fixture loading은 serialization이 넘기는 `raw` 플래그로 분기하자"까지 못박는다. grep 한 방으로 `_save_table`의 정확한 조건문에 도달한다.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S5 Spec-Inference).** 근거: 고칠 지점(`_save_table` UPDATE-skip 조건)은 자명하지만, 올바른 조건식을 *추론으로 합성*해야 한다. 후보가 셋이다 — (a) `pk_set`을 조건에 추가, (b) 최적화 자체를 revert, (c) `not raw`로 raw 경로만 제외. (a)는 `Model.__init__`이 default 생성 여부를 추적하지 않아 `Sample()`과 `Sample(pk=...)`가 둘 다 pk_set=True가 되는 도메인 사실 때문에 막다른 길이고, (b)는 #29260 최적화 가치를 버린다. 정답 (c)는 "일반 explicit-pk는 force_update로 우회 문서화, fixture만 raw 분기로 복구"라는 **설계 의도를 hints/ticket에서 재구성(S5)**해야 비로소 선택된다. 기계적 None-가드/상수변경(S1)이 아니라 불변식·도메인 제약을 따져 한 줄을 합성하는 전형적 semantic repair.
- **K (Knowledge) = K-Domain.** 근거: `raw` 인자가 무엇인지(serialization 프레임워크가 deserialize 시 넘기는 플래그), `_state.adding`·`_meta.pk.default`·`NOT_PROVIDED` 의미, loaddata가 raw 경로를 탄다는 사실 — 전부 django ORM/serialization 내부지식이다. 일반 파이썬 추론만으로는 "왜 하필 raw인가"에 도달 못 한다.
- **Primary type = T-DomainBound.** L0라 localize는 공짜이고 픽스도 1라인이지만, 병목이 "왜 raw로 분기하는 게 올바른 일반화인가"라는 django serialization 도메인지식에 있다. S2의 추론이 K-Domain 사실 위에서만 수렴하므로 K-Domain dominant.

## 난이도 티어
**T3 (중간).** 이 티어로 미는 구조적 피처:
- **수정 범위**: 프로덕션 코드는 단일 파일(`base.py`) 단일 라인(`not raw and`) → scope 자체는 T1~T2급.
- **localize 직접성**: L0(이슈가 파일·함수·조건문을 다 지목) → easiness 신호.
- **has-repro**: problem_statement에 정확한 재현 시퀀스(`create()` → `Sample(pk=...)` → `save()`)와 bisect 커밋이 있음 → 강한 easiness 신호.

하지만 위 easiness를 상쇄해 T2가 아니라 T3로 미는 것:
- **S2 추론 + 3개 후보의 함정**: minimal-fix(`not raw`)는 자명하지 않다. 가장 "자연스러운" 수정(`pk_set` 추적)이 오히려 도메인 제약 때문에 틀린다는 걸 알아야 한다. 위치가 명확해도 *올바른 식의 합성*에 실질 추론이 든다(T3 정의: "L1+S2/S5, 단일파일이나 실질 추론").
- **cross-file-dep**: 픽스의 정당성이 serialization 경로(`raw=True`를 넘기는 호출자)에 대한 암묵적 의미 의존을 동반.

**공식 라벨(`<15 min fix`)과 비교**: 공식은 "개발자 구현시간"이라 한 줄 diff에 정당하게 T1급이다. 우리 tier는 한 단계 위인 T3 — 오라클(hints/ticket) 없이 증상만 본 에이전트 입장에서는 `pk_set` 과확장 또는 revert로 빠지기 쉽고(reasoning-deficiency), 도메인지식(raw 플래그 의미)이 병목이라 에이전트 난이도는 구현시간보다 높다. 시간라벨이 못 잡는 "추론 함정 + 도메인 의존"을 반영해 의도적으로 상향.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/base.py` : `Model._save_table`
- **근본 원인**: ticket #29260 최적화는 "instance 추가 중(`self._state.adding`)이고 PK에 default(`self._meta.pk.default and ... is not NOT_PROVIDED`)가 있으면 UPDATE를 건너뛰고 INSERT를 강제(`force_insert`)"한다. 그런데 이 조건이 `raw` 저장(serialization/loaddata 경로)까지 포함했다. raw 저장은 명시적 pk를 가진 기존 객체를 다시 적재하는 경로라 INSERT-then-UPDATE fallback이 필요한데, 최적화가 그 fallback을 죽여 같은 pk로 두 번째 INSERT → IntegrityError.
- **수정 요지**: UPDATE-skip 조건문의 맨 앞에 `not raw and` 한 줄을 추가:
  ```python
  if (
      not raw and
      not force_insert and
      self._state.adding and
      self._meta.pk.default and
      ...
  ):
      force_insert = True
  ```
  즉 `raw=True`(serializer가 넘김)이면 더 이상 UPDATE를 건너뛰지 않고 기존의 INSERT-then-UPDATE fallback으로 복귀한다. hints에서 논의된 "explicit pk 추적 불가" 한계 때문에 일반 사용자 코드는 force_update로 우회하도록 문서화하되, fixture 로딩만은 `raw` 분기로 안전하게 복구한 minimal-fix.

## 검증 (test_patch)
- **FAIL_TO_PASS 동작**(배열 길이 1): serialization 데이터 라운드트립 테스트. `tests/serializers/models/data.py`에 `UUIDDefaultData(data = models.UUIDField(primary_key=True, default=uuid.uuid4))` 모델을 신설하고(+`import uuid`), `tests/serializers/test_data.py`의 import와 테스트 매트릭스에 `(pk_obj, 793, UUIDDefaultData, uuid_obj)` 케이스를 추가. (FAIL_TO_PASS 라벨이 `partial(func, *args, **keywords) - new function...`로 보이는 건 SWE-bench가 parametrize/동적 생성된 테스트 id의 docstring을 캡처하면서 생긴 표기 아티팩트이지, 실제로는 위 라운드트립 케이스다.)
- **픽스 증명**: serializer는 객체를 덤프했다가 `raw=True`로 역직렬화/저장한다. PK-default가 있는 모델을 명시적 pk로 raw 저장할 때, 패치 전이면 UPDATE-skip이 발동해 같은 pk로 두 번째 INSERT를 시도 → IntegrityError로 실패. `not raw and` 추가 후엔 raw 경로가 UPDATE fallback을 타서 라운드트립이 성공. 즉 테스트는 `raw=True` 분기를 직접 관통해 픽스의 wiring을 증명한다.
- **overfit 관점**: 테스트가 raw 경로만 검증하므로 일반 사용자 `Sample(pk=...).save()`(non-raw)는 여전히 회귀 상태로 남는다 — 하지만 이건 overfit이 아니라 **의도된 스펙**(non-raw는 force_update로 우회하도록 문서화한다는 설계 결정). 골드패치 자체가 raw에만 한정한 minimal-fix이므로 테스트 범위와 픽스 범위가 일치, special-case overfit 아님.
- **regression 관점**: PASS_TO_PASS 배열 길이 0이라 명시적 인접 회귀가드는 없지만, `not raw`는 #29260 최적화의 non-raw 경로(일반 INSERT 강제)를 **보존**한다 — raw일 때만 끄므로 최적화의 query-절감 이득을 일반 경로에서 유지. flags의 regression-trap은 "잘못 고치면(revert/pk_set) #29260 최적화를 깨거나 다른 raw-아닌 동작을 바꾼다"는 의미.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement의 "Django 2.2→3.0에서 두 번 INSERT" + ticket #29260 링크 + hints의 bisect 커밋 85458e94 → 회귀 커밋이 건드린 `_save_table`의 "Skip an UPDATE when adding an instance and primary key has a default" 조건 블록으로 직행(L0). grep `_state.adding`/`force_insert`/`pk.default`로 한 방.
2. **픽스와 올바른 일반화 이유**: 조건문 앞에 `not raw and` 추가. 왜 이게 올바른 일반화인가 — 문제의 본질은 "explicit pk vs default-generated pk"를 구분하고 싶지만 `Model.__init__`이 그걸 추적 안 해서 `pk_set`으로는 둘을 못 가른다(hints의 Simon Charette가 막다른 길임을 명시). 대신 **serialization/loaddata만이 진짜로 "기존 객체 재적재"를 의도하고 그 경로는 `raw=True`로 신뢰성 있게 식별된다**. 따라서 raw 경로만 최적화에서 제외하면, 일반 코드의 query-절감은 유지하면서 fixture 재로딩을 정확히 복구한다 → 특정 테스트가 아니라 raw 호출자 전체에 일반화되는 수정.
3. **regression 안전**: 안 깨야 할 것 — #29260 최적화의 non-raw INSERT-강제 동작(query 절감). `not raw`는 raw일 때만 분기를 끄므로 일반 모델 생성·저장 경로는 byte-identical. revert(b)나 `pk_set` 조건(a)을 골랐다면 최적화 전체 또는 더 넓은 동작을 바꿔 회귀를 유발했을 것.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (i) hints의 `pk_set`-기반 "더 일반적인 수정"으로 과확장(reasoning-deficiency); `Model.__init__`이 default 생성 여부를 추적 안 한다는 도메인 사실을 모르면 그게 안 되는 걸 못 깨닫는다. (ii) 증상(serializer가 깨짐)만 보고 `_save_table` 대신 serializer/deserializer 쪽을 의심해 시간 낭비. (iii) `raw` 인자의 존재·의미를 몰라 raw 분기라는 정답을 후보로도 못 올림(K-Domain 결핍). 회피법: problem_statement의 "loaddata/fixture 재로딩" + hints의 "branch off `raw` which is passed by the serialization framework" 신호를 신뢰하고 `_save_table` 시그니처의 `raw` 파라미터로 곧장 수렴.
