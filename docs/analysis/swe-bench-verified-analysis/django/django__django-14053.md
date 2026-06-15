---
instance_id: django__django-14053
repo: django/django
base_commit: 179ee13eb37348cd87169a198aec18fedccc8668
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-02-25T23:57:27Z
fail_to_pass: 1
pass_to_pass: 31
gold_files: [django/contrib/staticfiles/storage.py]
---

# django__django-14053

## 문제 요약
`HashedFilesMixin.post_process()`(ManifestStaticFilesStorage / CachedStaticFilesStorage가 사용)는 #24452 수정 이후 중첩 참조를 올바르게 처리하려고 여러 번 패스를 돌린다. 그런데 매 패스마다 동일한 원본 파일명을 `collectstatic`의 `collect()`로 다시 yield한다. 그 결과 같은 파일(`admin/css/base.css`)이 서로 다른 해시로 여러 번 "Post-processed"로 보고되어 통계가 틀리고, WhiteNoise/S3 같은 서브클래스가 같은 파일을 중복 압축·업로드하는 낭비가 생긴다. 사용자는 파일당 단 한 번, 최종 해시로만 yield되기를 기대한다.

## 유형 분류
- 버그 카테고리: regression (다중 패스 도입의 부작용) + API-contract (yield 1회/파일 계약 위반)
- 서브시스템: django.contrib.staticfiles storage (collectstatic post-processing)
- 증상 타입: 잘못된 출력 (중복 yield → 통계 오류 + 서브클래스 중복 작업)
- 로컬라이제이션 신호: problem_statement가 클래스명 `HashedFilesMixin`, 메서드 `post_process()`, 상수 `max_post_process_passes`를 직접 언급 → `django/contrib/staticfiles/storage.py`로 바로 연결

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/staticfiles/storage.py` : `HashedFilesMixin.post_process()`
- 근본 원인: 첫 단일 패스와 이후 `max_post_process_passes` 반복 패스 모두 `_post_process()`가 내놓는 결과를 그대로 `yield`했다. adjustable 파일(CSS 등 참조 재작성 대상)은 패스마다 다시 등장하므로 같은 원본명이 중간 해시들과 함께 여러 번 흘러나갔다.
- 수정 요지: `processed_adjustable_paths = {}` 딕셔너리를 도입해 원본 path를 키로 결과를 집계한다. 첫 패스에서는 `name not in adjustable_paths` 이거나 `isinstance(processed, Exception)`인 경우에만 즉시 yield하고, adjustable 파일은 dict에 저장한다. 이후 반복 패스에서는 yield 없이 dict 값을 덮어쓴다(주석: "hashed_name may be newer"). 모든 패스가 끝난 뒤 `yield from processed_adjustable_paths.values()`로 파일당 최종 해시 한 번만 내보낸다.

## 검증 (test_patch)
- FAIL_TO_PASS: `post_processing behaves correctly.` (`test_post_processing`)
- `tests/staticfiles_tests/test_storage.py`의 `test_post_processing`에 한 줄 추가: `self.assertCountEqual(stats['post_processed'], set(stats['post_processed']))`. `set()`으로 중복을 제거한 것과 원본 리스트가 같은 개수여야 함을 단언 → `post_processed` 목록에 동일 파일이 두 번 이상 없음을 증명한다. 버그 상태에서는 adjustable CSS가 여러 번 들어가 리스트 길이 > set 길이가 되어 실패하고, 픽스 후 파일당 1회만 yield되어 통과한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement의 `HashedFilesMixin.post_process` 키워드로 단일 파일 `storage.py`에 즉시 진입. 멀티파일 아님, 변경 범위는 메서드 1개.
- 함정/난이도 메모: (1) 단순히 "중복 제거"만 하면 안 되고, 첫 패스에서 non-adjustable 파일과 **예외(Exception)** 는 즉시 yield해야 한다(`isinstance(processed, Exception)` 분기 누락 시 `post_processing indicates the origin of the error` PASS_TO_PASS 테스트가 깨짐). (2) adjustable 파일은 가장 마지막 패스의 해시가 정답이므로 dict 덮어쓰기로 "최신 우선"을 보장해야 한다. (3) `paths` 변수가 중간에 adjustable만으로 재바인딩되는 흐름을 정확히 읽어야 한다.
- 우리 에이전트 관점: 에이전트가 "yield를 set으로 감싸 dedup"하는 얕은 패치로 갈 위험이 큼 — 그러면 중간 해시가 최종으로 남거나 예외 yield 순서가 깨질 수 있다. 핵심은 generator 흐름을 deferred-collect(딕셔너리 누적 후 마지막에 일괄 yield)로 재구조화하는 것이며, non-adjustable/exception 즉시 yield와 adjustable 지연 yield의 두 경로를 분리하는 통찰이 필요하다.
