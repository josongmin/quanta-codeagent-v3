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
primary_type: T-DirectMap
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-10914

## 문제 요약
업로드된 파일이 `FileSystemStorage`에 저장될 때, 명시적으로 `FILE_UPLOAD_PERMISSIONS`를 설정하지 않으면 파일 권한이 일관되지 않는 문제다. 작은 파일은 `MemoryUploadedFile`로 처리되어 system umask 기반 권한을 받고, 큰 파일은 `TemporaryUploadedFile`(`tempfile.NamedTemporaryFile` + `os.rename`) 경로를 타면서 일부 OS(CentOS 7.4.1708, Python 3.6.5 등)에서 `0o600`이 되어버린다. 즉 업로드 파일 크기에 따라 최종 미디어 폴더 파일 권한이 비결정적으로 갈린다. 메일링리스트 논의(Carlton Gibson) 끝에 기본값을 `0o644`로 못박아 이 비일관성을 제거하기로 합의되었다.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed)**: problem_statement 제목이 "Set default FILE_UPLOAD_PERMISSION to 0o644"로 고칠 심볼명을 그대로 적어준다. 설정 상수 `FILE_UPLOAD_PERMISSIONS`를 grep하면 정의 지점은 `django/conf/global_settings.py` 단 한 곳(SSOT)으로 즉시 수렴한다. 탐색 노력 0.
- **S (Repair Strategy) = S1 (Direct-Map / template)**: 이슈가 픽스를 사실상 명세한다 — "기본값을 0o644로". 기계적 상수 변경(`None` → `0o644`)이며 식·조건을 추론으로 합성할 필요가 없다. 정형 결함클래스 "안전하지 않은/비결정적 기본값 → 명시 상수 강제"에 템플릿 매칭. 추론 합성(S2)도 후보생성-검증(S3)도 불필요.
- **K (Knowledge) = K-Domain**: 한 줄이지만 *왜 0o644이고 0o600이 아닌지*를 정당화하려면 django의 업로드 파이프라인(`FILE_UPLOAD_HANDLERS` → `MemoryUploadedFile` vs `TemporaryUploadedFile`, `FileSystemStorage.file_permissions_mode`로의 전파, tempfile의 0o600 강제)을 알아야 한다. 일반 파이썬 추론만으론 "왜 이 값이 옳은가"가 안 나온다. 단 하위호환 시그니처/리턴형 계약(K-API)이 핵심은 아니라 K-API 아님(릴리스 노트는 골드 테스트 범위 밖).

**primary type = T-DirectMap**: 위치가 명확(L0)하고 픽스가 S1 기계적 상수 변경이다. 픽스 자체는 자명하지만 이슈 톤이 "문서 경고를 추가해달라"로 시작해 픽스가 완전 자명한 T-LocTrivial보다 한 칸 위 — 무엇을 바꿀지(상수)와 무엇을 바꾸지 말지(docs/디렉토리 설정)의 판단이 들어가므로 T-DirectMap이 더 정확하다.

왜 이 repair strategy인가 (APR 관점): PAR/TBar류 template-based repair가 정확히 노리는 결함이다. "설정 기본값 = None(operating-system dependent)"이 결함 패턴이고, fix template은 "deterministic literal로 치환". 후보 패치 공간이 단일점이라 generate-&-validate 반복도, semantic constraint solving도 불필요. 유일한 비자명 요소는 *어떤 리터럴이냐*인데, 그건 이슈 본문이 `0o644`로 고정해줬다.

## 난이도 티어 — **T1 (존나쉬움)**

티어로 미는 구조적 피처:
- **파일수 1 / 줄수 1**: 골드는 `global_settings.py` 한 파일, 한 줄(`-FILE_UPLOAD_PERMISSIONS = None` / `+FILE_UPLOAD_PERMISSIONS = 0o644`). 1파일·<5줄 ≈ 48% solve 구간의 최좋은 쪽.
- **localize 직접성 L0**: 이슈 제목 = 심볼명. 탐색 노력 사실상 없음.
- **has-repro**: 네이티브 환경(CentOS 7.4, Python 3.6.5)에서 0o600이 재현되는 구체적 시나리오 + tempfile 메커니즘 설명. repro 존재는 가장 강한 easiness 신호(~87% 해결률).
- **S1 자명 픽스 + 이슈가 정답 리터럴 명시**.

공식 라벨(`<15 min fix`)과 **일치**한다. K-Domain이 한 단계 끌어올릴 후보였으나, 도메인 지식은 "왜 옳은가" 해석에만 필요하고 *FAIL_TO_PASS 통과에는 불필요*(테스트가 단순히 기본값이 0o644인지만 확인)하므로 티어를 올리지 않는다. 유일한 위험요소는 P2P trap(아래 검증 참조)인데, 이 역시 골드를 한 줄로 유지하면 자동으로 안전해 T1을 유지한다.

## 골드패치 분석

- **건드린 파일/함수**: `django/conf/global_settings.py` — 모듈 레벨 상수 `FILE_UPLOAD_PERMISSIONS` (line ~307, `gettext_noop` 정의 아래).
- **근본 원인**: 기본값이 `None`이라 권한 결정을 OS umask와 업로드 핸들러 경로에 위임했다. `MemoryUploadedFile`(작은 파일)은 umask 권한을, `TemporaryUploadedFile`(큰 파일, `tempfile.NamedTemporaryFile`)은 tempfile이 보안상 강제하는 `0o600`을 받아 `os.rename` 후에도 0o600으로 남는다 → 파일 크기에 따라 최종 권한이 갈리는 비결정성.
- **수정 요지**: 단 한 줄, `FILE_UPLOAD_PERMISSIONS = None` → `FILE_UPLOAD_PERMISSIONS = 0o644`. 이 값은 `FileSystemStorage`의 `file_permissions_mode` 속성으로 전파되어 업로드 경로(memory/temporary)와 무관하게 모든 저장 파일에 일관된 `0o644`를 강제한다.

## 검증 (test_patch)

- **FAIL_TO_PASS (1개)**: `test_override_file_upload_permissions (test_utils.tests.OverrideSettingsTests)`.
- **픽스 증명 방식**: test_patch는 기존 단언 `self.assertIsNone(default_storage.file_permissions_mode)`를 `self.assertEqual(default_storage.file_permissions_mode, 0o644)`로 바꾼다. 즉 (1) 아무 override 없이 `default_storage`(= `FileSystemStorage`)의 `file_permissions_mode`가 새 기본값 `0o644`로 나오는지 확인하고, (2) 이어지는 `with self.settings(FILE_UPLOAD_PERMISSIONS=0o777):` 블록에서 `0o777`로 정상 override되는지 재확인해 *설정 → storage 전파 경로*가 살아있음을 보장한다. (2)가 있어 단순히 상수만 0o644로 박고 전파를 깨는 류의 거짓 픽스는 통과 못 한다.
- **overfit 관점**: overfit-risk 플래그 미부여. 픽스가 단일 상수라 special-case 회피 여지가 없고, FAIL_TO_PASS가 1개로 얇긴 하나 검증 대상(상수 1개) 자체가 점이라 미검증 입력공간이 없다. CEGIS적 일반화 부담 없음.
- **regression 관점**: regression-trap 플래그 부여. PASS_TO_PASS 98개 중 다수가 같은 `OverrideSettingsTests` 클래스(`test_override_media_root`, `test_override_static_root`, `test_override_file_upload_directory_permissions`, `test_override_database_routers` 등)와 인접 `test_utils` 스위트다. 전역 설정을 건드리므로 settings override 메커니즘 전반을 안 깨야 하고, 특히 `FILE_UPLOAD_DIRECTORY_PERMISSIONS` 관련 테스트가 같이 도는 상황에서 디렉토리 기본값까지 건드리면 회귀가 난다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈 제목 "Set default FILE_UPLOAD_PERMISSION to 0o644" → 설정 상수명 `FILE_UPLOAD_PERMISSIONS`를 그대로 키워드로 `grep -rn FILE_UPLOAD_PERMISSIONS django/conf/global_settings.py`. 정의 지점은 `global_settings.py`의 모듈 상수 한 곳뿐이며 이것이 SSOT. storage/upload-handler 구현부는 *읽어서 메커니즘만 이해*하고 수정 대상은 아니다.
2. **픽스 & 올바른 일반화인 이유**: `FILE_UPLOAD_PERMISSIONS = None` → `0o644`. None은 "OS·파일크기 의존" 비결정성의 근원이고, 명시 모드는 `FileSystemStorage.file_permissions_mode`를 통해 memory/temporary 두 경로 모두에 동일 권한을 강제한다. 이건 테스트 한 개에 맞춘 special-case가 아니라 *모든 업로드 파일의 권한 결정 정책*을 결정론화하는 정책 변경이라 올바른 일반화다. 값 `0o644`는 임의가 아니라 메일링리스트 합의(소유자 읽기/쓰기 + 그룹/기타 읽기)에서 도출.
3. **regression 안전**: 같은 `OverrideSettingsTests`의 `test_override_file_upload_directory_permissions`, `test_override_media_root/url`, `test_override_static_*`, `test_override_database_routers`와 `test_utils` 전 스위트(JSONEqual/HTMLEqual/AssertNumQueries 등 98개)를 안 깨야 한다. 한 줄 상수 변경으로 한정하면 settings override 전파 경로는 그대로라 이 P2P들은 자동 보존된다.
4. **함정 회피**: (a) **로직을 고쳐야 한다는 오해** — 진짜 수정은 storage/upload-handler 구현이 아니라 기본 상수 한 줄. 구현부에서 헤매면 안 됨. (b) **과잉 수정** — hints_text가 `releases/2.2.txt` 브레이킹체인지 노트, settings/deployment-checklist 문서, 그리고 `FILE_UPLOAD_DIRECTORY_PERMISSIONS`까지 손대라 언급하지만, Carlton Gibson이 디렉토리 권한은 *비일관성이 없으므로 별도 티켓*이라 명시했고 골드도 디렉토리 기본값을 건드리지 않는다. 디렉토리 설정까지 0o644로 바꾸면 `test_override_file_upload_directory_permissions` 회귀 위험. (c) **docs-only 함정** — problem_statement가 "문서에 경고를 추가해달라" 톤으로 시작해 docs만 고치고 끝낼 위험. 핵심은 제목의 직접 지시를 신뢰해 *설정 상수값*을 바꾸는 것이며, docs 수정은 FAIL_TO_PASS와 무관하다.
