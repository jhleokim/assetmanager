# 배포 — Cloudflare Workers + D1 + Access

전부 무료 플랜에서 동작한다 (근거: `MULTIUSER.md` §6, `DATA-PRIVACY.md` §6).
비밀번호 해싱은 브라우저에서 하므로 Workers CPU 10ms 제약에 걸리지 않는다.

## 0. 준비
```bash
npm i -g wrangler
wrangler login
```

## 1. D1
```bash
wrangler d1 create assetmanager --location apac
# 출력된 database_id 를 wrangler.toml 의 [[d1_databases]] 에 기입
wrangler d1 execute assetmanager --remote --file=worker/schema.sql
```

## 2. 공공데이터포털 인증키 (서버 secret)
data.go.kr → "아파트 매매 실거래가 자료" 활용신청 → 일반 인증키(Decoding)
```bash
wrangler secret put RTMS_KEY
```
클라이언트 코드·백업 파일 어디에도 이 키는 들어가지 않는다.

## 3. Cloudflare Access
1. Zero Trust 대시보드 → **Access → Applications → Add an application → Self-hosted**
2. Application domain: 이 Worker의 도메인 (`assetmanager.<계정>.workers.dev` 또는 커스텀 도메인)
3. Policy: **Allow** — Include → Emails → 가족 이메일들
4. 저장 후 **Overview 탭의 Application Audience (AUD) Tag** 복사
5. `wrangler.toml` `[vars]`:
   - `ACCESS_TEAM_DOMAIN = "<팀이름>.cloudflareaccess.com"`
   - `ACCESS_AUD = "<복사한 AUD>"`

Access가 로그인을 처리하고, 통과한 요청에 `Cf-Access-Jwt-Assertion` 헤더를 붙인다.
Worker는 그 JWT를 팀 도메인 공개키로 검증한다 (`worker/access.js`).

> **커스텀 도메인을 권장한다.** `*.workers.dev`는 공용 접미사라 쿠키 격리·피싱 방어에서 자체 도메인이 낫다 (`DATA-PRIVACY.md` §7).

## 4. 배포
```bash
npm test          # 121개 단위 테스트
npm run smoke     # 실제 Chromium 종단 검증 (선택, playwright-core 필요)
npm run deploy    # core/ → app/core/ 복사 후 wrangler deploy
```

## 5. 첫 로그인
1. Access 로그인(Google/이메일 OTP) → 앱이 자동으로 사용자·가구를 만든다
2. **데이터 잠금 암호**를 정한다 — 서버는 이 암호를 모른다. 잃으면 복구 불가
3. 가족 초대: 설정 탭 → 이메일 입력 → [가구에 초대]. 상대가 첫 로그인하면 자동 합류
4. 잠금 암호는 **직접** 전달한다 (서버에 없으므로 앱이 전달해 줄 수 없다)

## 로컬 개발
```bash
wrangler d1 execute assetmanager --local --file=worker/schema.sql
npm run dev       # wrangler dev --env dev  (Access 우회: DEV_BYPASS_EMAIL)
```

## 프로토타입 데이터 이전
프로토타입의 localStorage(`familyAssets_v1`)가 같은 브라우저에 남아 있으면 첫 실행 때 자동으로 읽어 IndexedDB로 옮기고, 적금을 `INSTALLMENT`로 바꾸고, 인증키·프록시 설정을 제거한다 (`app/store.js migrate`).
다른 브라우저라면 프로토타입의 [JSON 백업 내보내기] → 새 앱의 [JSON 불러오기].
