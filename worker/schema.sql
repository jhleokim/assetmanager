-- 가족 통합 자산관리 — D1 스키마
-- 설계: docs/MULTIUSER.md §2 + docs/DATA-PRIVACY.md §8
-- 자산 원본은 여기 없다. 가구별 암호문 봉투(vaults.envelope)만 보관한다.

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,      -- Cloudflare Access가 확인한 이메일
  display_name TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS households (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kdf_salt   TEXT NOT NULL,               -- 잠금 암호 KDF salt (공개 정보, 비밀 아님)
  verifier   TEXT,                        -- 잠금 암호 검증용 봉투 (core/crypto makeVerifier)
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS household_members (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (household_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON household_members(user_id);

-- 초대: 아직 가입하지 않은 이메일을 가구에 미리 붙여둔다
CREATE TABLE IF NOT EXISTS invites (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('editor','viewer')),
  invited_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (household_id, email)
);
CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);

-- 가구당 암호문 봉투 1개. version으로 낙관적 동시성 제어.
CREATE TABLE IF NOT EXISTS vaults (
  household_id TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL DEFAULT 0,
  envelope     TEXT,                      -- JSON {v,kdf,iv,ct} — 서버는 내용을 모른다
  bytes        INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER,
  updated_by   TEXT
);

-- 실거래가 월별 캐시 — 개인정보 아님, 전 사용자 공유.
-- closed=1 (지난달 이전)은 불변이므로 영구, closed=0 (이번 달)은 TTL.
CREATE TABLE IF NOT EXISTS rtms_cache (
  cache_key  TEXT PRIMARY KEY,            -- lawd:ym:kind
  lawd       TEXT NOT NULL,
  ym         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  deals      TEXT NOT NULL,               -- JSON 배열 (정규화된 거래)
  n          INTEGER NOT NULL,
  closed     INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rtms_open ON rtms_cache(closed, fetched_at);
