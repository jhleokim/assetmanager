# 다중 사용자 웹 서비스 전환 설계 (Cloudflare Workers)

목표: `workers.dev`에 배포해 여러 가족 구성원이 각자 아이디·비밀번호로 로그인하고,
가구(household) 단위로 자산을 공유해서 본다.

**결론부터: 기술적으로 가능하고, 오히려 지금 프로토타입의 P0 결함 4개가 이 전환으로 동시에 해결된다.**
단 비밀번호 인증에는 아래 CPU 한도 문제가 하나 걸린다.

---

## 0. 먼저 알아야 할 제약 — Workers 무료 플랜 CPU 10ms

Workers 무료 플랜은 **요청당 CPU 시간이 10ms**다 (유료 $5/월은 기본 30초).
안전한 비밀번호 해싱은 의도적으로 CPU를 많이 쓰므로 정면으로 충돌한다.

WebCrypto PBKDF2-SHA256 실측 (동일 API, 참고용 로컬 측정):

| 반복 횟수 | 소요 | 무료 플랜(10ms) |
|---:|---:|---|
| 10,000 | 6.2 ms | ✅ 가능 (단 **안전하지 않음**) |
| 50,000 | 23.9 ms | ❌ 초과 |
| 100,000 | 45.3 ms | ❌ 초과 |
| 210,000 | 95.3 ms | ❌ 초과 |
| **600,000** (OWASP 권장 최소) | **272.5 ms** | ❌ 27배 초과 |

즉 **"무료 플랜 + 자체 아이디/비밀번호 + 안전한 해싱"은 동시에 성립하지 않는다.**
가족 금융자산 데이터에 1만 회 반복 해시를 쓰는 것은 권할 수 없다.

선택지는 셋이다. 자세한 비교는 §5.

---

## 1. 전체 구조

```
브라우저 (정적 SPA — Workers Assets로 서빙)
    │  fetch("/api/...")  + HttpOnly 세션 쿠키
    ▼
Cloudflare Worker  (같은 오리진 → CORS 자체가 사라짐)
    ├── /api/auth/*        로그인·로그아웃·세션
    ├── /api/assets/*      자산 CRUD (household 스코프)
    ├── /api/trades/*      거래 기록
    ├── /api/snapshots/*   스냅샷
    ├── /api/quote/*   ←── 시세 중계 (서버가 네이버/야후 호출)
    └── /api/rtms/*    ←── 실거래가 중계 (serviceKey는 서버 secret)
    ▼
D1 (사용자·가구·자산·거래)   +   KV / Cache API (시세·실거래가 캐시, 전 사용자 공유)
```

### 이 구조가 공짜로 해결하는 기존 결함

| 기존 문제 | 해결 방식 |
|---|---|
| **P0-4** 인증키가 제3자 프록시로 유출 | 키가 Worker secret에 상주. 클라이언트는 키를 아예 모른다 |
| **P0-5** localStorage 초과 시 데이터 무단 유실 | D1에 저장. 용량·내구성 문제 소멸 |
| **P1-5** 프록시 다단 경유로 느림 | 서버가 직접 호출 → **홉 1회 고정**. 경로 탐색 개념 자체가 사라짐 |
| **P1-5b** 프록시 오작동이 세션 오염 | 외부 프록시를 안 쓰므로 해당 없음 |

서버에서 나가는 요청에는 CORS가 적용되지 않는다. `netFetch`의 4단 경로 탐색,
타임아웃, 경로 기억, 오염 방지 로직이 **전부 불필요해진다.**

그리고 캐시가 **전 사용자 공유**가 된다. 10명이 강남구 실거래가를 봐도 상류 호출은 1회다.

---

## 2. 데이터 모델 — 사용자 ≠ 소유자

여기가 설계의 핵심이다. 기존 앱의 `owner` 필드("본인/배우자/자녀/공동")는 **라벨**이지
로그인 계정이 아니다. 자산을 `user_id`로 바로 묶으면 **배우자가 공동 자산을 못 본다.**

따라서 스코프 단위는 사용자가 아니라 **가구(household)** 다.

```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,          -- uuid
  login_id     TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  pw_hash      TEXT,                      -- Access 방식이면 NULL
  pw_salt      TEXT,
  pw_iter      INTEGER,
  created_at   INTEGER NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER                    -- 무차별 대입 방어
);

CREATE TABLE households (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE household_members (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  role         TEXT NOT NULL,             -- owner | editor | viewer
  PRIMARY KEY (household_id, user_id)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,            -- 토큰 원문은 저장하지 않는다
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE assets (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_label  TEXT,                      -- 기존 owner: 본인/배우자/자녀/공동
  cls TEXT, cat TEXT, name TEXT NOT NULL,
  code TEXT, market TEXT, inst TEXT, acct TEXT,
  qty REAL, avg REAL, principal REAL, value REAL,
  mode TEXT, cur TEXT, rate REAL,
  start_date TEXT, end_date TEXT,         -- ← P0-1 만기: 이제 실제로 쓴다
  addr TEXT, complex TEXT, lawd TEXT, area REAL, floor TEXT,
  deposit REAL, rent REAL, memo TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER                      -- 소프트 삭제
);
CREATE INDEX idx_assets_hh ON assets(household_id);
```

`role`로 권한을 나누면 "자녀 계정은 자기 자산만 조회" 같은 개인화도 가능하다.

### 시세 이력은 사용자별로 두면 안 된다

삼성전자 종가는 누구에게나 같다. 지금은 브라우저마다 중복 저장하고 있다.

D1 무료 쓰기 한도는 **일 100,000행**인데, 40종목 × 3년 일봉 = 30,000행이다.
사용자 3명이 초기 백필하면 90,000행으로 한도에 근접한다.

→ **시세 이력은 `household_id` 없이 전역 공유 테이블(또는 KV)에 한 벌만 둔다.**
   사용자가 늘어도 쓰기량이 늘지 않는다.

---

## 3. 인증 설계 (자체 아이디/비밀번호 방식)

```js
// 로그인
const enc = new TextEncoder();
async function pbkdf2(pw, salt, iter){
  const k = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    {name:"PBKDF2", hash:"SHA-256", salt, iterations: iter}, k, 256));
}
function timingSafeEqual(a, b){          // 길이·내용 모두 상수 시간 비교
  if(a.length !== b.length) return false;
  let d = 0;
  for(let i=0;i<a.length;i++) d |= a[i] ^ b[i];
  return d === 0;
}

// 세션 발급 — 토큰 원문은 DB에 남기지 않는다
const token = crypto.randomUUID() + crypto.randomUUID();
const tokenHash = [...new Uint8Array(
  await crypto.subtle.digest("SHA-256", enc.encode(token)))]
  .map(b=>b.toString(16).padStart(2,"0")).join("");
await env.DB.prepare(
  "INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)"
).bind(tokenHash, user.id, now, now + 14*86400).run();

headers.set("Set-Cookie",
  `sid=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${14*86400}`);
```

- **토큰 해시만 저장** → D1 덤프가 유출돼도 세션을 탈취당하지 않는다.
- **HttpOnly** → JS가 쿠키를 읽지 못한다.
- **SameSite=Lax + JSON Content-Type 요구** → CSRF 실질 차단.
- **로그인 실패 카운트 + `locked_until`** → 무차별 대입 방어.
  추가로 Cloudflare Rate Limiting 규칙을 `/api/auth/login`에 건다.
- 아이디 존재 여부를 응답으로 구분하지 않는다(사용자 열거 방지).

---

## 4. ⚠️ 다중 사용자가 되는 순간 XSS는 계정 탈취가 된다

지금은 단일 사용자 로컬 앱이라 XSS의 실질 피해가 작았다. 서버·세션이 생기면 등급이 올라간다.
**이건 전환 전에 반드시 처리해야 한다.**

기존 분석의 P2-7이 **P0으로 승격**된다:

```js
const esc = s => String(s==null?"":s).replace(/[&<>"]/g, ...);   // ← ' 가 빠져 있다
```

현재도 표·차트를 전부 `innerHTML` 문자열 조립으로 그린다. 자산명·메모는 사용자 입력이다.
다른 가족 구성원이 입력한 자산명이 내 브라우저에서 실행되는 구조가 된다(저장형 XSS).

필수 조치:
1. `esc()`에 `'` 추가 — 최소한의 응급조치
2. **표 렌더링을 `innerHTML` 조립에서 DOM 생성(`textContent`)으로 전환** — 근본 해결
3. 응답에 CSP 헤더 부착: `script-src 'self'` — 단 **인라인 `onclick` 제거가 선행**되어야 한다
   (현재 `showTab`, `delTrade`가 인라인 핸들러다)

---

## 5. 세 가지 선택지

| | A. Cloudflare Access | B. 자체 인증 + 유료 | C. 자체 인증 + 클라이언트 해싱 |
|---|---|---|---|
| 로그인 방식 | Google/GitHub/이메일 OTP | **아이디·비밀번호** | **아이디·비밀번호** |
| 월 비용 | **0원** (50명까지) | **$5** (Workers Paid) | **0원** |
| 비밀번호 코드 | **0줄** — 직접 저장 안 함 | 필요 | 필요 + 클라이언트 파생 |
| 해싱 안전성 | 해당 없음 | ✅ 60만 회 여유 | ✅ 클라이언트 60만 + 서버 1만 |
| 구현 난이도 | 낮음 (대시보드 설정) | 중간 | 높음 |
| 비밀번호 유출 책임 | Cloudflare | 직접 | 직접 |

**C 방식**은 Bitwarden 등이 쓰는 정공법이다. 클라이언트가 PBKDF2 60만 회를 돌린 결과를
서버로 보내고, 서버는 그 값에 낮은 반복(1만 회)을 한 번 더 건다. 서버 CPU는 6ms로 무료
한도에 들어가면서, DB가 유출돼도 공격자는 여전히 60만 회 반복을 뚫어야 한다.
대신 사전 로그인 단계에서 salt를 내려줘야 해서 사용자 열거 방지 설계가 까다롭다
(→ `login_id`에서 salt를 결정적으로 파생시켜 회피).

**권장**: 가족 단위(5~10명)라면 **A**가 합리적이다. 비밀번호를 직접 보관하지 않는 것이
금융 데이터에서는 가장 큰 이점이다. 다만 구성원 전원이 Google/이메일 인증을 써야 한다.
"앱 자체 아이디"가 요건이면 **B**($5/월)를 권한다. C는 비용 0원을 꼭 지켜야 할 때만.

---

## 6. 비용·한도 요약 (2026년 9월 기준)

| 리소스 | 무료 한도 | 이 앱 기준 평가 |
|---|---|---|
| Workers 요청 | 100,000/일 | 가족 단위면 충분 |
| Workers CPU | **10ms/요청** | **비밀번호 해싱에 부족** (§0) |
| D1 저장 | 5GB / DB당 500MB | 충분 |
| D1 읽기 | 500만 행/일 | 충분 (페이지 로드당 ~50행) |
| D1 쓰기 | **10만 행/일** | 시세 이력을 사용자별로 두면 위험 (§2) |
| Access | 50명 | 가족 단위면 충분 |

> ⚠️ **2026년 9월 1일부터** D1 무료 플랜은 일일 행 한도 초과 시 쿼리가 **실패**한다
> (이전에는 초과해도 동작). 시세 이력 쓰기 설계가 실제로 중요해졌다.

---

## 7. 이전 단계

1. **스키마·API 확정** + 기존 `evaluate/accrued/totals`를 순수 함수로 분리(테스트 동반)
2. **Worker 골격** — 라우터, D1 바인딩, 세션 미들웨어
3. **인증** — §5에서 고른 방식
4. **시세·실거래가 중계 + 서버 캐시** — 여기서 P0-4·P1-5가 함께 해결된다
5. **XSS 정리** (§4) — 인증 붙이기 **전에** 끝내는 것이 안전하다
6. **프런트를 API 연동으로 전환** — `Store.load/save`를 fetch로 교체
7. **마이그레이션** — 기존 JSON 백업 내보내기가 그대로 이전 도구가 된다.
   `POST /api/import` 하나로 localStorage 사용자를 받아들인다.

`prototype/index.html`의 UI·차트 코드는 대부분 재사용할 수 있다. 바뀌는 것은
저장 계층(`Store`)과 네트워크 계층(`netFetch`)이며, 이 둘은 이미 분리 가능한 형태다.
