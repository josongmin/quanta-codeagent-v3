---
instance_id: django__django-13925
repo: django/django
base_commit: 0c42cdf0d2422f4c080e93594d5d15381d6e955e
version: "4.0"
difficulty: 15 min - 1 hour
created_at: 2021-01-21T08:08:55Z
fail_to_pass: 2
pass_to_pass: 24
gold_files: [django/db/models/base.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-13925

## 문제 요약
Django 3.2 alpha부터 다른 모델을 상속받는 모델에서 `models.W042`(auto-created primary key 경고)가 잘못 발생한다. 사용자는 조상 모델(예: `Entity`)에서 이미 PK를 명시적으로 정의했고 자식(`User`)이 이를 상속받기를 기대했는데, 다중 테이블 상속(MTI)으로 묶인 자식 모델마다 W042 경고가 뜬다. 3.1에서는 정상이었고 3.2 alpha에서 `DEFAULT_AUTO_FIELD` 검사를 도입한 커밋(b5e12d4)이 들어오며 생긴 회귀(regression)다. 메인테이너(Simon Charette)가 재현·원인 커밋을 특정하고 회귀 테스트까지 요청한 상태.

## 유형 (정형화)

3축 점수:

- **L0 (Localization=Pinpointed)** — 경고 ID `models.W042`와 고유 메시지 문자열 "Auto-created primary key used when not defining a primary key type"가 코드의 단일 지점을 직접 지목한다. grep 한 방으로 `django/db/models/base.py`의 `Model._check_default_pk` classmethod로 즉시 수렴. 탐색 비용 사실상 0.
- **S2 (Constraint-Reasoning, +S1)** — 고칠 *지점*은 자명하지만(L0), 추가할 *조건식*을 도메인 불변식으로 합성해야 한다. "auto_created PK"를 "사용자가 PK 타입을 미지정함"으로 등치한 게 오류인데, MTI 자식의 parent_link PK도 `auto_created=True`라는 비자명한 사실을 추론에 끌어와야 정확한 가드(`isinstance(pk, OneToOneField) and pk.remote_field.parent_link`)를 도출할 수 있다. 단순 가드 추가라는 점에서 S1 골격이지만, 가드의 *술어*가 도메인 불변식 추론(S2)이라 dominant는 S2.
- **K-Domain** — Django MTI 내부 메커니즘 지식 필수: 자식 모델의 PK가 부모를 가리키는 `OneToOneField(parent_link=True)`로 자동 생성된다는 것, 그래서 그 PK가 `auto_created=True`로 표시된다는 것. 이 도메인 사실 없이는 정확한 조건을 만들 수 없고 과잉 억제로 빠진다.

**primary type = T-ConstraintReason** 근거: 위치는 명확(L0)하나 난점이 "올바른 조건식을 추론으로 합성"하는 데 있다. 후보 패치를 테스트로 골라내는 G&V(S3/S4)가 아니라, 부모는 경고 유지 / 자식만 제외라는 *비대칭 불변식*을 한 번에 정확히 표현해야 하는 SemFix류 의미 추론 문제. 이슈가 픽스를 적어주지 않으므로 T-DirectMap도 아니다.

## 난이도 티어

**T4 (약간 어려움).** 공식 difficulty 라벨은 "15 min - 1 hour"(≈T3 prior)인데, 한 단계 올려 T4로 둔다.

이 티어로 미는 구조적 피처:
- **K-Domain이 진짜 병목** — 파일/줄수는 작지만(1파일, +5줄, 단일 헌크), 정확한 술어를 만들려면 MTI parent_link PK가 왜 `auto_created`인지를 알아야 한다. 루브릭상 K-Domain 단독으로 T4 진입 조건을 충족.
- **강한 P2P trap (regression-trap)** — PASS_TO_PASS 24개 중 `test_auto_created_pk`, `test_auto_created_inherited_pk`(실제로는 F2P지만 같은 클러스터), `test_auto_created_inherited_parent_link`가 "진짜 auto-created 부모는 여전히 경고가 떠야 한다"를 고정한다. "auto_created면 스킵"이라는 자연스러운 과잉 수정은 이 테스트들을 깬다. 비대칭 조건을 못 맞추면 한 테스트 통과시키고 다른 테스트를 깨는 전형적 함정.

T5로 안 가는 이유: localize가 L0로 자명하고, 멀티파일/멀티헌크 조율(L3)이나 overfit 고위험(S4)이 없다. has-repro(메인테이너가 재현 커밋 명시 + 회귀테스트 요청)는 강한 easiness 신호로 작용한다.

공식 라벨(<1시간)과의 괴리: 라벨은 *개발자 구현시간*이라 이미 MTI를 아는 코어 개발자 기준이면 1시간 미만이 맞다. 하지만 도메인 지식이 없는 에이전트에게는 정확한 술어 합성과 P2P trap 회피가 비자명하므로 에이전트 난이도는 T4가 타당하다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/base.py` : `Model._check_default_pk` (classmethod)
- **근본 원인**: MTI에서 자식 모델의 PK는 부모를 가리키는 `OneToOneField(parent_link=True)`로 자동 생성되며 이 PK는 `auto_created=True`다. 3.2의 `_check_default_pk`가 경고 조건을 `cls._meta.pk.auto_created`만으로 판정했기 때문에, 부모가 명시적 PK를 정의했어도 자식의 parent_link PK가 `auto_created`라는 이유로 W042를 띄웠다. 즉 "auto_created PK"와 "사용자가 PK 타입 미지정"을 잘못 등치한 게 회귀의 핵심.
- **수정 요지**: 경고 발생 조건에 예외 절을 AND로 추가 — PK가 `OneToOneField`이면서 `remote_field.parent_link`가 True이면(= 상속으로 생성된 parent link PK) 경고 대상에서 제외. 주석 "Inherited PKs are checked in parents models"로 의도 명시: 상속 PK는 부모 모델에서 이미 검사되므로 자식에서 중복/오탐 경고를 내지 않는다.

```python
if (
    cls._meta.pk.auto_created and
    # Inherited PKs are checked in parents models.
    not (
        isinstance(cls._meta.pk, OneToOneField) and
        cls._meta.pk.remote_field.parent_link
    ) and
    not settings.is_overridden('DEFAULT_AUTO_FIELD') and
    not cls._meta.app_config._is_default_auto_field_overridden
):
```

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**:
  - `test_explicit_inherited_pk`: `Parent`가 `id = AutoField(primary_key=True)`로 명시 PK, `Child(Parent): pass`. 기대 결과는 경고 0개(`[]`). 픽스 전엔 Child의 parent_link PK에 W042가 떴다.
  - `test_auto_created_inherited_pk`: `Parent`/`Child` 둘 다 PK 미지정. 부모 PK는 진짜 auto_created이므로 `Parent`에 대해서만 W042 1개가 떠야 함(`obj=Parent`), 자식 parent_link PK는 제외.
- **픽스 증명**: 두 테스트가 함께 "false-positive 제거 + 진짜 경고 보존"의 양 방향을 고정한다. `test_explicit_inherited_pk`는 명시 상속 PK에서 경고가 사라짐을, `test_auto_created_inherited_pk`는 진짜 auto-created 부모는 정확히 1개 경고가 부모 객체로 남음을 검증 — 과잉 억제가 아님을 증명.
- **overfit 관점**: F2P가 2개뿐이라 얇아 보이지만 P2P가 두꺼워 special-case 패치로는 통과 못 한다. 특히 `test_auto_created_inherited_parent_link`/`test_explicit_inherited_parent_link`(P2P)는 명시적 `parent_ptr = OneToOneField(..., parent_link=True)` 케이스까지 커버해 술어가 `parent_link` 속성에 정확히 걸려야 함을 강제. 따라서 overfit-risk는 낮음(플래그 미부여).
- **regression 관점**: regression-trap 플래그. P2P 24개에 W042의 정상 발화 경로(`test_auto_created_pk`, `test_explicit_pk`, `test_app_default_auto_field`, `test_default_auto_field_setting`)와 인접한 IndexName/ConstraintName/DuplicateDBTable 체크들이 들어 있어, 가드를 잘못 넓히면 정상 경고나 인접 체크를 깰 수 있다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈 본문의 경고 ID `models.W042`와 고유 메시지 문자열을 코드베이스에서 grep → `django/db/models/base.py`의 `_check_default_pk`로 단번에 수렴(L0). 이슈가 "inherited"/"parent key"를 반복 강조하므로 검색어에 상속 맥락을 얹는다.

2. **픽스와 올바른 일반화 근거**: `_check_default_pk`의 경고 조건에 `not (isinstance(cls._meta.pk, OneToOneField) and cls._meta.pk.remote_field.parent_link)`를 AND로 추가. 이게 올바른 일반화인 이유 — 버그의 본질은 "auto_created"의 의미 오버로딩이다. PK가 auto_created인 경우는 (a) 사용자가 아무 PK도 안 줘서 진짜 자동 생성된 `AutoField`, (b) MTI에서 상속 때문에 자동 생성된 parent_link `OneToOneField` 두 가지다. W042는 (a)만 겨냥해야 하므로, 정확히 (b)를 식별하는 술어(`OneToOneField` AND `parent_link`)로 제외하는 것이 special-casing이 아닌 의미적으로 정확한 구분이다. 부모에서 이미 검사되므로 자식 제외가 정보 손실도 아니다.

3. **regression 안전**: P2P의 `test_auto_created_pk`(상속 없는 진짜 auto-created → 경고 유지), `test_explicit_pk`(명시 PK → 경고 없음), `test_auto_created_inherited_parent_link`(부모 auto-created + 명시 parent_ptr → 부모만 경고)를 깨면 안 된다. 가드가 `auto_created` 절 *안에* AND로 들어가므로 비상속/일반 경로의 판정은 바이트 단위로 불변 — 이 점이 회귀 안전의 핵심. 인접 IndexName/ConstraintName/DuplicateDBTable 체크는 다른 함수라 영향 없음.

4. **함정 회피**: 오라클 없는 에이전트의 최빈 오답은 "`auto_created`면 스킵" 또는 "부모가 있으면 스킵"으로 가드를 과하게 넓히는 것. 그러면 `test_auto_created_inherited_pk`(부모는 경고가 떠야 함)와 `test_auto_created_pk`가 깨진다. 회피법 — 부모는 경고 유지 / 자식만 제외라는 *비대칭*을 인식하고, 자식의 parent_link PK만 정확히 좁혀 식별하는 술어를 쓸 것. 또한 `OneToOneField`가 `base.py`에 import되어 있는지(이름 해석 가능성) 확인하고, `remote_field.parent_link` 접근 경로를 정확히 쓸 것. F2P 2개 중 하나만 보고 멈추면 비대칭을 놓치므로 두 테스트를 동시에 만족시키는지 검증이 필수.
