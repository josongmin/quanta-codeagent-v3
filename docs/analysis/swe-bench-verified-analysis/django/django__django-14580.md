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
---

# django__django-14580

## 문제 요약
커스텀 base 클래스를 가지면서 `django.db.models`에서 온 필드가 없는 모델로 `makemigrations`를 돌리면, 생성된 마이그레이션 파일의 `bases=(app.models.MyMixin, models.Model)`에서 `models` 심볼을 참조하지만 `from django.db import models` import가 누락된다. 그 결과 마이그레이션 파일을 로드할 때 `NameError: name 'models' is not defined`로 실패한다. 사용자는 항상 유효한 Python 마이그레이션 파일이 생성되길 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 (직렬화 시 필요한 import 누락) / edge-case
- 서브시스템: django migrations serializer / writer
- 증상 타입: 생성 코드가 invalid Python → import 시 `NameError` 크래시
- 로컬라이제이션 신호: problem_statement에서 "Django generates a migration file that is missing an import statement"와 `models.Model` 참조가 직접 단서. hints_text가 "special casing of models.Model in TypeSerializer"라고 거의 골드 위치를 지목한다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/serializer.py` : `TypeSerializer.serialize` (의 `special_cases` 리스트)
- 근본 원인: `TypeSerializer`는 `models.Model`을 특수 케이스로 처리해 문자열 `"models.Model"`로 직렬화하지만, 그에 동반되는 import 목록을 빈 리스트(`[]`)로 둬서 `from django.db import models`를 함께 기록하지 않았다. 보통은 같은 마이그레이션 안의 필드(`models.TextField` 등)가 그 import를 끌어와 우연히 가려졌지만, models에서 온 필드가 없는 모델에선 import가 전혀 추가되지 않아 누락이 드러난다.
- 수정 요지: special_cases의 `models.Model` 항목 import를 `[]`에서 `['from django.db import models']`로 바꿔, 이 타입을 직렬화할 때 항상 해당 import가 writer의 import 집합에 포함되도록 한다. 단 한 줄 변경.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_serialize_type_model` — `models.Model` 타입을 직렬화하면 결과 문자열이 `'models.Model'`이고 그에 딸린 import 집합이 `{'from django.db import models'}`임을 확인.
- 테스트가 픽스를 증명하는 방식: `assertSerializedEqual(models.Model)`로 round-trip을 검증하고, 추가로 `assertSerializedResultEqual(MigrationWriter.serialize(models.Model), ("('models.Model', {'from django.db import models'})", set()))`로 직렬화 결과 문자열과 import 집합을 직접 단언한다. 픽스 전엔 import 집합이 빈 set이라 두 번째 단언이 실패한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: 마이그레이션 직렬화는 `django/db/migrations/serializer.py`에 모여 있다. `models.Model`을 grep하면 `TypeSerializer.serialize`의 special_cases 튜플이 바로 나온다. import가 누락된다는 증상은 직렬화 결과의 (문자열, imports) 페어를 추적하면 된다.
- 함정/난이도 메모: 증상이 writer(`writer.py`)에서 터지지만 실제 결함은 serializer의 import 메타데이터에 있다. 사용자도 writer를 의심했듯 잘못된 파일을 파고들기 쉽다. 또 대부분 케이스에선 다른 필드가 import를 가려 재현이 안 되므로, "models 필드 없는 모델 + 커스텀 base"라는 정확한 조건을 잡아야 한다. 멀티파일 아님(단일 파일 1줄).
- 우리 에이전트 관점: 막힐 지점은 (1) writer vs serializer 책임 경계 혼동, (2) 재현 조건의 미묘함 — 일반 모델로 테스트하면 버그가 안 나타나 "고쳐졌다"고 오판할 수 있다. special_cases의 세 번째 튜플 요소가 import 리스트라는 구조만 파악하면 수정은 자명하다.
