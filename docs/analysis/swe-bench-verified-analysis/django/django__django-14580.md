---
instance_id: django__django-14580
repo: django/django
base_commit: 36fa071d6ebd18a61c4d7f1b5c9d17106134bd44
version: "4.0"
difficulty: <15 min fix
created_at: 2021-07-01T07:38:03Z
fail_to_pass: 1
pass_to_pass: 49
gold_files: [django/db/migrations/serializer.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-14580

## 문제 요약
커스텀 base 클래스를 가지면서 `django.db.models`에서 온 필드가 없는 모델로 `makemigrations`를 돌리면, 생성된 마이그레이션 파일의 `bases=(app.models.MyMixin, models.Model)`에서 `models` 심볼을 참조하지만 `from django.db import models` import가 누락된다. 그 결과 마이그레이션 파일을 로드할 때 `NameError: name 'models' is not defined`로 import 시점에 크래시한다. 사용자는 항상 유효한 Python 마이그레이션 파일이 생성되길 기대했다. problem_statement에 완전한 재현 모델 정의 + 네이티브 스택트레이스가 포함되어 있고, hints_text가 사실상 골드 위치(`special casing of models.Model in TypeSerializer`)와 패치까지 적어준다.

## 유형 (정형화)

- **L0 (Localization)** — 이슈 본문이 "missing an import statement" + `models.Model` 참조를 직접 지목하고, hints가 `TypeSerializer`를 명시한다. `models.Model` grep 한 방이면 `serializer.py`의 `special_cases` 튜플로 수렴한다. cross-module 데이터플로우 추적 불필요 → L0.
- **S1 Direct-Map (+S2)** — 결함은 정형 클래스: 특수 케이스 직렬화 항목이 동반 import 메타데이터를 빈 리스트로 누락한 "누락 가드" 결함. 픽스는 `[]` → `['from django.db import models']`로 상수 데이터를 채우는 기계적 변경(S1). 다만 "왜 빈 리스트가 틀렸는가"를 직렬화 결과 페어 `(string, imports)`의 불변식 — 즉 `models.Model`이라는 표현식을 쓰면 그 import도 반드시 동반돼야 한다 — 으로 추론해야 정확한 import 문자열을 합성할 수 있어 약한 S2가 보조로 붙는다. CEGIS(S4)나 G&V(S3) 아님: 테스트 반복 없이 단일 정답이 결정된다.
- **K-Domain** — django migrations serializer가 (직렬화 문자열, 필요 import) 페어를 모아 writer가 import 블록을 조립한다는 내부 계약을 알아야 한다. `special_cases` 튜플의 3번째 요소가 import 리스트라는 구조 지식이 병목. 일반 파이썬 추론(K-Gen)만으론 "왜 보통은 안 터지는데 이 모델에선 터지나"를 설명 못 한다.
- **primary type = T-DirectMap** — 위치가 L0로 명확하고 픽스가 S1 기계적(상수 데이터 채우기)이라 T-DirectMap이 dominant. T-LocTrivial이 아닌 이유: 픽스 자체는 자명하나 K-Domain(serializer/writer import 계약)이 끼어 "찾으면 끝" 수준은 넘는다. T-DomainBound도 아님: 도메인지식이 *병목*이 아니라 픽스를 정당화하는 배경일 뿐, 위치·픽스 모두 직접적이다.

## 난이도 티어
**T2 (쉬움).** 공식 라벨도 `<15 min fix`로 일치한다. 이 티어로 미는 구조적 피처: 단일 파일(`serializer.py`) 1줄 변경, L0 직접 localize, has-repro(완전 재현 모델 + 네이티브 스택트레이스 → 가장 강한 easiness 신호), K-Domain이지만 얕음(튜플 3번째 요소가 import 리스트라는 구조만 파악하면 됨). T1로 더 내리지 않는 이유: (1) 증상이 writer에서 터지지만 결함은 serializer에 있어 책임 경계 혼동 함정이 있고, (2) 대부분 모델에선 다른 필드가 import를 가려 재현이 안 되는 미묘함(가짜 "수정됨" 오판 위험), (3) PASS_TO_PASS 49개 중 `django.db.models shouldn't be imported if unused.`라는 정반대 방향 회귀 가드가 있어 무지성으로 항상 import 추가하면 깨질 수 있는 regression-trap. 공식 시간라벨이 못 잡는 이 trap 때문에 T1이 아닌 T2가 정확하다.

## 골드패치 분석
- **건드린 파일/함수:** `django/db/migrations/serializer.py` : `TypeSerializer.serialize` 의 `special_cases` 리스트.
- **근본 원인:** `TypeSerializer`는 `models.Model`을 특수 케이스로 처리해 문자열 `"models.Model"`로 직렬화하지만, 동반 import 목록을 빈 리스트(`[]`)로 둬서 `from django.db import models`를 함께 등록하지 않았다. writer는 각 직렬화 항목이 돌려준 import 집합을 합쳐 파일 상단 import 블록을 만드는데, 이 항목이 빈 import를 반환하니 `models` 심볼이 정의되지 않는다. 보통은 같은 마이그레이션 안의 필드(`models.TextField` 등)가 `from django.db import models`를 끌어와 우연히 가려졌지만, models에서 온 필드가 없고 커스텀 base만 있는 모델에선 그 import를 끌어올 다른 출처가 없어 누락이 드러난다.
- **수정 요지:** `special_cases`의 `models.Model` 항목 import를 `[]` → `['from django.db import models']`로 바꿔, 이 타입을 직렬화할 때 항상 해당 import가 writer의 import 집합에 포함되도록 한다. `for case, string, imports in special_cases:` 루프가 이 imports를 그대로 소비하므로, 데이터만 채우면 기존 배선이 자동으로 import를 등록한다. 단 한 줄 변경.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_serialize_type_model` — `models.Model` 타입 직렬화 시 (1) `assertSerializedEqual(models.Model)`로 round-trip 동치 검증, (2) `assertSerializedResultEqual(MigrationWriter.serialize(models.Model), ("('models.Model', {'from django.db import models'})", set()))`로 직렬화 결과 문자열이 `'models.Model'`이고 동반 import 집합이 정확히 `{'from django.db import models'}`임을 직접 단언한다. 픽스 전엔 import 집합이 빈 set이라 두 번째 단언이 실패한다.
- **픽스 증명:** 테스트가 직렬화 결과의 `(string, imports)` 페어를 둘 다 박아 단언하므로, 빈 import → 정확한 import 문자열로의 변화를 정밀하게 포착한다. import 문자열의 오타·다른 형태(`import django.db.models` 등)면 단언이 깨져 약한 S2(정확한 import 표현식 합성)까지 강제한다.
- **overfit 관점:** FAIL_TO_PASS는 1개로 얇지만, 단언이 결과 문자열 + import 집합을 *정확히* 고정하므로 special-case 우회로 통과하기 어렵다. overfit 위험 낮음(`overfit-risk` 미부여).
- **regression 관점:** PASS_TO_PASS 49개에 `"django.db.models shouldn't be imported if unused."`(미사용 시 import 금지) 가드가 있어, 항상 무조건 import를 뿌리는 식의 과잉 수정은 깨진다. 골드는 `models.Model` *타입을 실제로 직렬화할 때만* import를 동반하므로 이 가드와 충돌하지 않는다. `regression-trap` 부여 근거.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈의 "missing an import statement" + 스택트레이스의 `bases=(app.models.MyMixin, models.Model)` → `models.Model`이 import 없이 출력된다는 신호. hints의 `TypeSerializer` 언급(혹은 `models.Model` grep)으로 `django/db/migrations/serializer.py`의 `TypeSerializer.serialize` `special_cases`로 직행. 증상이 터지는 `writer.py`가 아니라, 직렬화 항목의 import 메타데이터를 만드는 serializer가 진짜 발원지임을 책임 경계로 구분.
2. **픽스와 일반화 근거:** `special_cases`의 `models.Model` 튜플 3번째 요소(import 리스트)를 `[]` → `['from django.db import models']`로 채운다. 이것이 overfit이 아닌 올바른 일반화인 이유: `models.Model`을 `"models.Model"`이라는 *표현식*으로 직렬화하기로 한 이상, 그 표현식이 유효하려면 `models`가 항상 정의돼 있어야 한다 — 이는 입력 모델 구성과 무관한 직렬화 항목 자체의 불변식이다. 동반 필드가 import를 끌어오느냐는 우연일 뿐, 자기 import는 자기가 책임져야 한다.
3. **regression 안전:** PASS_TO_PASS의 `"django.db.models shouldn't be imported if unused."` + `"#24155 - Tests ordering of imports."` + `test_serialize_type_none`을 안 깨야 한다. 골드는 `models.Model`이 *실제로 직렬화에 등장할 때만* import를 동반하므로 "미사용 시 import 금지" 가드와 모순 없다. `type(None)` 케이스 import는 `[]` 그대로 유지(그건 stdlib도 아니고 import 불필요) → special_cases 다른 항목을 건드리지 않는 게 안전.
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (a) 증상이 `writer.py`에서 NameError로 터지니 writer의 import 수집 로직을 고치려 들기 쉬움(사용자도 writer를 의심). 실제 결함은 serializer의 데이터에 있다. (b) 일반 모델(`models.TextField` 필드 있는)로 테스트하면 다른 필드가 import를 가려 버그가 재현 안 돼 "고쳐졌다"고 오판. "models 필드 없는 모델 + 커스텀 base"라는 정확한 재현 조건을 잡아야 한다. (c) writer 쪽에서 항상 `from django.db import models`를 추가하는 식으로 막으면 `"unused import 금지"` regression 가드를 깬다 — 픽스는 반드시 직렬화 항목 단위 import 메타데이터에서 해결해야 한다.
