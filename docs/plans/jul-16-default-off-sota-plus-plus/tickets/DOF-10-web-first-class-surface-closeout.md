# DOF-10 - web operator flow closeout

**Priority:** P1  
**Depends on:** DOF-05  
**Owner:** `src/apps/web-daemon/**`, `apps/web-frontend/src/**`, protocol consumers

Prove one authenticated operator flow across session create/use, turn streaming, approval response, observability frames, and artifact/canvas render. This ticket does not change unrelated feature defaults and does not use Tauri as evidence.

## DoD

- browser/daemon path runs on one revision with non-zero tests
- bind/auth policy from DOF-05 is exercised, not bypassed by injected loopback-only test config
- each frame/verb is marked live, partial, or absent with a real consumer
- disconnect/backpressure, stale approval id, unauthorized reconnect, and dropped canvas event have explicit behavior

## Focus rails

Use the existing web-daemon unit and integration paths listed in this directory's previous plan, plus one real frontend consumer flow. Source-only protocol drift tests are supporting proof, not end-to-end closure.
