---
instance_id: django__django-10914
repo: django/django
base_commit: e7fd69d051eaa67cb17f172a39b57253e9cb831a
version: "3.0"
difficulty: <15 min fix
created_at: 2019-01-30T13:13:20Z
fail_to_pass: 1
pass_to_pass: 98
gold_files: [django/conf/global_settings.py]
---

# django__django-10914

## 문제 요약
업로드된 파일이 `FileSystemStorage`에 저장될 때, 명시적으로 `FILE_UPLOAD_PERMISSIONS`를 설정하지 않으면 파일 권한이 일관되지 않는 문제다. 작은 파일은 `MemoryUploadedFile`로 처리되어 umask 기반 권한을 받고, 큰 파일은 `TemporaryUploadedFile`(`tempfile.NamedTemporaryFile` + `os.rename`) 경로를 타면서 일부 OS(CentOS 7.4, Python 3.6.5 등)에서 `0o600`이 되어버린다. 즉 업로드 파일 크기에 따라 최종 미디어 폴더 파일 권한이 달라진다. 사용자는 기본값을 `0o644`로 정해 이 비결정성을 제거하길 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 / API-contract (안전하지 않은 기본값)
- 서브시스템: django core files / 전역 설정 (file storage 기본 설정)
- 증상 타입: silent-wrong (예외 없이 OS·파일크기 의존적으로 권한이 달라짐)
- 로컬라이제이션 신호: problem_statement 제목 자체가 "Set default FILE_UPLOAD_PERMISSION to 0o644" — 설정 이름이 그대로 골드 파일(`global_settings.py`)을 가리킨다. hints_text도 "Adjust the default"를 명시.

## 골드패치 분석
- 건드린 파일/함수: `django/conf/global_settings.py` (모듈 레벨 상수 `FILE_UPLOAD_PERMISSIONS`)
- 근본 원인: 기본값이 `None`이라 권한 결정을 OS umask와 업로드 핸들러 경로에 위임했고, 그 결과 파일 크기에 따라 `0o600` vs umask 권한으로 갈렸다.
- 수정 요지: 단 한 줄 — `FILE_UPLOAD_PERMISSIONS = None`을 `FILE_UPLOAD_PERMISSIONS = 0o644`로 변경. 이 값은 `FileSystemStorage`의 `file_permissions_mode`로 전파되어 모든 업로드 파일에 일관된 `0o644`를 강제한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_override_file_upload_permissions (test_utils.tests.OverrideSettingsTests)`
- 테스트가 어떻게 픽스를 증명하는지: 기존 단언 `assertIsNone(default_storage.file_permissions_mode)`을 `assertEqual(default_storage.file_permissions_mode, 0o644)`로 변경. 즉 아무 override 없이 `default_storage`(= `FileSystemStorage`)의 `file_permissions_mode`가 기본 `0o644`로 나오는지 확인하고, 이어서 `with self.settings(FILE_UPLOAD_PERMISSIONS=0o777)` 블록 안에서는 `0o777`로 override되는지를 재확인해 설정 전파 경로가 정상임을 보장한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: 설정 이름 `FILE_UPLOAD_PERMISSIONS`를 코드베이스에서 grep → `django/conf/global_settings.py` 정의가 SSOT. 한 줄 상수만 바꾸면 끝.
- 함정/난이도 메모: (1) 함정은 "코드 로직을 고쳐야 한다"는 오해 — 실제 수정은 storage/upload handler 구현이 아니라 기본 상수값 한 줄이다. (2) hints_text는 docs(`releases/2.2.txt`, settings/deployment-checklist 문서)와 `FILE_UPLOAD_DIRECTORY_PERMISSIONS`까지 손대라 언급하지만, FAIL_TO_PASS 통과에는 디렉토리 설정 변경이 불필요(Carlton Gibson이 디렉토리는 별도 티켓이라 명시). 골드도 디렉토리 기본값은 건드리지 않음 — 과잉 수정 주의.
- 우리 에이전트 관점: 막힐 지점은 거의 없는 trivial fix지만, problem_statement가 "문서에 경고를 추가해달라"는 톤으로 시작해 에이전트가 docs 수정에만 매달리거나 storage 구현부에서 헤맬 위험이 있다. 핵심은 제목의 직접 지시("default를 0o644로")를 신뢰해 설정 상수만 바꾸는 것.
