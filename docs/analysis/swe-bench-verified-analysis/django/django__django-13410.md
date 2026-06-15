---
instance_id: django__django-13410
repo: django/django
base_commit: 580a4341cb0b4cbfc215a70afc004875a7e815f4
version: "3.2"
difficulty: <15 min fix
created_at: 2020-09-11T09:58:41Z
fail_to_pass: 2
pass_to_pass: 40
gold_files: [django/core/files/locks.py]
primary_type: T-DirectMap
tier: T1
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-API
flags: [has-repro]
---

# django__django-13410

## 문제 요약
posix(`fcntl` 사용) 환경의 `django/core/files/locks.py` 락 구현이 항상 `False`를 반환하는 버그다. cpython의 `fcntl.flock`은 성공 시 `None`을 반환하고 실패 시 `OSError`를 발생시키는데, 기존 코드는 반환값을 `ret == 0`으로 비교해서 성공해도 `None == 0`이 `False`가 되어 버린다. 비차단 락(`LOCK_NB`)을 쓰려는 사용자는 락 획득 성공/실패를 반환값으로 알아야 하는데, 항상 실패로 보여 무용지물이었다. 이슈 본문에 파일·함수·원인은 물론 수정 diff까지 첨부되어 있다.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed)** — problem_statement가 파일 경로(`django/core/files/locks.py`), 분기(posix `else`), 함수(`lock`/`unlock`), 원인(`fcntl.flock`은 `None` 반환·`OSError` raise), 심지어 제안 diff까지 직접 지목한다. 탐색 비용 사실상 0, grep 한 방.
- **S (Repair Strategy) = S1 (Direct-Map) +S2 (Constraint-Reasoning)** — 정형 결함클래스(예외기반 API를 정수 반환으로 오해 → "예외 가드 + 반환값 보정")에 템플릿 매칭되고, 이슈가 사실상 픽스를 받아쓰기로 명세한다(S1 dominant). 다만 `except` 절을 광범위 `OSError`로 둘지 더 좁은 `BlockingIOError`로 둘지는 "어떤 예외가 락 경합의 정당한 신호인가"를 추론해 합성해야 하는 미세한 의미 판단이라 S2를 보조로 단다.
- **K (Knowledge) = K-API (API-contract)** — 버그의 본질이 `fcntl.flock`의 공개 계약(성공=`None`, 실패=`raise`)을 정확히 이해하는 데 있다. 일반 파이썬 추론(K-Gen)만으론 `None == 0`이 왜 틀렸는지 못 짚고, django 내부 도메인(K-Domain)도 아니다 — 표준 라이브러리 API 계약 지식이 병목.
- **primary type = T-DirectMap** — 위치가 L0로 자명하고 픽스가 S1 기계적(예외 가드 추가 + 반환값 보정)이므로 "위치 명확 + 기계적 픽스" 정의에 정확히 들어맞는다. T-LocTrivial과의 경계가 있으나, 픽스가 단순 상수/체크 한 줄이 아니라 `return ret == 0` 라인을 try/except 구조로 치환하는 소규모 패턴 적용이라 DirectMap이 더 정확하다.

왜 S1인가(APR 관점): PAR/TBar 류 템플릿 수리가 다루는 전형 결함이다. "센티넬 반환 비교(`ret == 0`)를 예외기반 API의 실제 계약에 맞춰 try/except 반환으로 교체"는 정형 fix-pattern이며, 이슈가 그 패턴을 그대로 적어주어 후보 합성·검증 반복(S3/S4)이 불필요하다. overfit 위험이 거의 없는 이유도 같다 — 픽스가 테스트 피드백 루프가 아니라 API 계약에서 연역되기 때문.

## 난이도 티어
**티어 = T1 (존나쉬움).** 이 티어로 미는 구조적 피처:
- **파일수/줄수**: 1파일, 골드 패치 실질 변경 ~6줄(헌크 단일). 구조 컷의 "1파일·<10줄 ≈ 48% solve" 상단.
- **localize 직접성**: L0 — 이슈가 파일·함수·원인·diff를 전부 지목. localization 에러 가능성 0에 수렴(실패의 ~51% 원인인 localize가 여기선 제거됨).
- **repro**: `has-repro` — 이슈에 원인 설명 + 제안 패치 diff가 포함되어 "거의 정답을 적어줌"(가장 강한 easiness 신호).
- **도메인**: K-API지만 표준 stdlib 계약 1건이라 깊은 프레임워크 지식 불요.
- **P2P trap**: PASS_TO_PASS 40개가 모두 `files.tests`(파일/이미지/temp/move) 인접 동작이나, 락 분기는 이들과 데이터플로우가 분리돼 있어 회귀 결합이 약하다 — regression-trap 플래그 미부여.

공식 라벨(`<15 min fix`)과 일치 — 시간라벨이 가리키는 "사소한 단일 수정"이 에이전트 난이도(L0+S1+has-repro)와도 같은 방향이라 재조정 불필요.

## 골드패치 분석
- **건드린 파일/함수**: `django/core/files/locks.py` 의 posix 분기(`else:` 가지) `lock(f, flags)`, `unlock(f)`.
- **근본 원인**: `fcntl.flock`은 성공 시 `None` 반환·실패 시 `OSError`(비차단 경합 시 그 서브클래스 `BlockingIOError`) raise인데, 코드가 `ret = fcntl.flock(...)` 후 `return ret == 0`로 처리. `None == 0`은 항상 `False`라 성공도 실패로 보고됨.
- **수정 요지**:
  - `lock`: `try: fcntl.flock(_fd(f), flags); return True` / `except BlockingIOError: return False`. 예외 없으면 획득 성공(`True`), 비차단 락 경합 시 발생하는 `BlockingIOError`만 잡아 `False`.
  - `unlock`: 예외 처리 없이 `fcntl.flock(_fd(f), fcntl.LOCK_UN)` 후 무조건 `return True`.
  - 주목: 사용자 제안 diff는 양쪽 모두 `except OSError`였으나, 골드는 더 좁은 `BlockingIOError`로 좁히고 `unlock`에서는 예외 가드를 아예 제거했다. 즉 "락 경합이라는 정당한 실패"만 `False`로 흡수하고 그 외 진짜 I/O 에러는 전파하도록 의미를 정밀화했다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**: `test_exclusive_lock`, `test_shared_lock` (둘 다 `files.tests.FileTests`). `tests/files/tests.py`가 `from django.core.files import File, locks`로 락 모듈을 직접 임포트하도록 추가.
- **픽스 증명**:
  - `test_exclusive_lock`: 같은 파일을 `f1`,`f2` 두 핸들로 연다. `lock(f1, LOCK_EX)` → `True`(획득), 이어 `lock(f2, LOCK_EX|LOCK_NB)`·`lock(f2, LOCK_SH|LOCK_NB)`는 이미 배타락이 잡혀 있어 `False`여야 함. `unlock(f1)` → `True`. 버그 상태(`return ret == 0`)면 첫 락부터 `False`라 `assertIs(..., True)`에서 즉시 실패.
  - `test_shared_lock`: `f1`에 `LOCK_SH`(공유락) → `True`, `f2`에 `LOCK_SH|LOCK_NB`도 공유락이라 동시 획득 가능 → `True`, 양쪽 `unlock` → `True`. `assertIs`로 정수/None이 아닌 정확한 불리언 동일성을 확인해 항상-`False` 버그를 잡아낸다.
- **overfit 관점**: 테스트가 성공·실패·해제 세 경로와 배타/공유 두 모드를 모두 커버해 `assertIs(..., True/False)` 불리언 동일성으로 핀다 — special-case로 우회 통과하기 어렵다. 다만 테스트는 `except OSError`로 풀어도 그린이라(경합은 `BlockingIOError`로만 들어옴) 골드의 `BlockingIOError` 좁힘을 강제하지는 못한다(약한 underspecification, 단 overfit-risk 플래그를 줄 정도는 아님).
- **regression 관점**: 윈도우(`msvcrt`) 분기와 no-op(`fcntl` 미존재) 분기는 손대지 않아 비-posix 동작 불변. PASS_TO_PASS 40개(파일 IO/이미지 차원/temp/move)는 락 경로를 거치지 않아 영향 없음 — 회귀면이 좁다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `django/core/files/locks.py`와 `lock`/`unlock`을 직접 지목하고 "성공 시 `None`, 실패 시 `OSError`"라는 원인까지 적어줌 → 파일 열어 `else:`(posix, `import fcntl` 성공 분기)의 `return ret == 0` 두 줄로 즉시 수렴. 윈도우/no-op 분기는 건드리지 않음을 확정.
2. **픽스와 왜 올바른 일반화인가**: `return ret == 0`을 `try: flock(...); return True except BlockingIOError: return False`로 치환. 이는 테스트에 맞춘 임시방편이 아니라 `fcntl.flock`의 **공개 계약(예외=실패, 무예외=성공)** 에서 연역된 보정이라 모든 입력에 대해 옳다. `except`를 `BlockingIOError`로 좁히는 것이 핵심 일반화 — 비차단 경합만 "정상적 실패(`False`)"로 흡수하고, 권한·디스크립터 오류 같은 다른 `OSError`는 삼키지 않고 전파해야 호출자가 진짜 장애를 구별할 수 있다.
3. **regression 안전**: 비-posix 분기(`msvcrt`, no-op) 미접촉으로 윈도우/미지원 환경 동작 보존. `unlock`을 무조건 `True`로 두는 골드 선택은 LOCK_UN 실패를 예외로 노출시키지 않으려는 의도이며, 인접 파일-IO P2P 40개는 락 경로와 분리돼 안전.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) 윈도우 분기에 같은 패치를 잘못 미러링(두 구현 공존 파일이라 헷갈리기 쉬움), (b) `except OSError`로 광범위하게 잡아 진짜 에러를 은닉(테스트는 그린이라 grading/LLM-judge로 차이를 못 잡음 — 변별점은 "어떤 예외가 락 경합의 정당한 신호인가"를 따지는 판단력), (c) `unlock`에도 불필요한 try/except를 추가해 골드와 의미 차이. 회피법: stdlib 문서의 `fcntl.flock` 계약을 근거로 비차단 경합 신호인 `BlockingIOError`로 좁히고, posix 분기만 정확히 수정한다.
