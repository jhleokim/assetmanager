/** 사용자·가구 부트스트랩과 암호문 봉투 동기화.
 *  서버는 봉투 내용을 열 수 없다. 여기서 하는 일은 "누가 어느 가구의 봉투를 읽고 쓸 수 있는가" 뿐이다. */

const now = () => Math.floor(Date.now() / 1000);
const uid = () => crypto.randomUUID();
const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;     // D1 행 한도(약 1MB×N)보다 앞서 앱 차원에서 제한

export async function ensureUser(db, email){
  const e = String(email).toLowerCase();
  let u = await db.prepare("SELECT * FROM users WHERE email = ?").bind(e).first();
  if(!u){
    u = { id: uid(), email: e, display_name: e.split("@")[0], created_at: now(), last_seen_at: now() };
    await db.prepare("INSERT INTO users (id,email,display_name,created_at,last_seen_at) VALUES (?,?,?,?,?)")
            .bind(u.id, u.email, u.display_name, u.created_at, u.last_seen_at).run();
    // 대기 중인 초대가 있으면 그 가구에 합류시킨다
    const inv = await db.prepare("SELECT * FROM invites WHERE email = ?").bind(e).all();
    for(const i of inv.results){
      await db.prepare("INSERT OR IGNORE INTO household_members (household_id,user_id,role,joined_at) VALUES (?,?,?,?)")
              .bind(i.household_id, u.id, i.role, now()).run();
    }
    if(inv.results.length) await db.prepare("DELETE FROM invites WHERE email = ?").bind(e).run();
  }else{
    await db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").bind(now(), u.id).run();
  }
  return u;
}

/** 사용자의 가구 목록. 없으면 하나 만들어 owner로 넣는다. */
export async function householdsFor(db, user, { createIfNone = true, saltB64 } = {}){
  const rows = await db.prepare(
    `SELECT h.id, h.name, h.kdf_salt, h.verifier, m.role
       FROM household_members m JOIN households h ON h.id = m.household_id
      WHERE m.user_id = ? ORDER BY m.joined_at`).bind(user.id).all();
  if(rows.results.length || !createIfNone) return rows.results;

  const h = { id: uid(), name: (user.display_name || "우리") + " 가족", kdf_salt: saltB64, created_at: now() };
  await db.batch([
    db.prepare("INSERT INTO households (id,name,kdf_salt,created_at) VALUES (?,?,?,?)")
      .bind(h.id, h.name, h.kdf_salt, h.created_at),
    db.prepare("INSERT INTO household_members (household_id,user_id,role,joined_at) VALUES (?,?,'owner',?)")
      .bind(h.id, user.id, now()),
    db.prepare("INSERT INTO vaults (household_id, version) VALUES (?, 0)").bind(h.id)
  ]);
  return [{ ...h, verifier: null, role: "owner" }];
}

export async function memberRole(db, householdId, userId){
  const r = await db.prepare("SELECT role FROM household_members WHERE household_id = ? AND user_id = ?")
                    .bind(householdId, userId).first();
  return r ? r.role : null;
}

export async function getVault(db, householdId){
  const v = await db.prepare("SELECT version, envelope, updated_at, updated_by FROM vaults WHERE household_id = ?")
                    .bind(householdId).first();
  if(!v) return { version: 0, envelope: null };
  return { version: v.version, envelope: v.envelope ? JSON.parse(v.envelope) : null,
           updatedAt: v.updated_at, updatedBy: v.updated_by };
}

/**
 * 낙관적 동시성: baseVersion이 현재와 다르면 409 — 다른 기기가 먼저 썼다는 뜻.
 * 클라이언트는 최신 봉투를 받아 병합한 뒤 다시 시도한다.
 */
export async function putVault(db, householdId, userId, { baseVersion, envelope }){
  if(!envelope || typeof envelope !== "object" || !envelope.ct || !envelope.iv || !envelope.kdf)
    return { status: 400, error: "봉투 형식 오류" };
  const s = JSON.stringify(envelope);
  if(s.length > MAX_ENVELOPE_BYTES) return { status: 413, error: "봉투가 너무 큽니다" };

  const cur = await db.prepare("SELECT version FROM vaults WHERE household_id = ?").bind(householdId).first();
  const curV = cur ? cur.version : 0;
  if(Number(baseVersion) !== curV)
    return { status: 409, error: "다른 기기에서 먼저 저장했습니다", version: curV };

  const next = curV + 1;
  const r = await db.prepare(
    `UPDATE vaults SET version = ?, envelope = ?, bytes = ?, updated_at = ?, updated_by = ?
      WHERE household_id = ? AND version = ?`)
    .bind(next, s, s.length, now(), userId, householdId, curV).run();
  if(!r.meta || r.meta.changes !== 1)          // 경합에서 졌다
    return { status: 409, error: "다른 기기에서 먼저 저장했습니다", version: curV + 1 };
  return { status: 200, version: next };
}

export async function setVerifier(db, householdId, verifier){
  await db.prepare("UPDATE households SET verifier = ? WHERE id = ?")
          .bind(JSON.stringify(verifier), householdId).run();
}

export async function invite(db, householdId, byUserId, email, role = "editor"){
  if(!["editor", "viewer"].includes(role)) return { status: 400, error: "역할 오류" };
  const e = String(email).toLowerCase();
  const existing = await db.prepare("SELECT id FROM users WHERE email = ?").bind(e).first();
  if(existing){
    await db.prepare("INSERT OR IGNORE INTO household_members (household_id,user_id,role,joined_at) VALUES (?,?,?,?)")
            .bind(householdId, existing.id, role, now()).run();
    return { status: 200, joined: true };
  }
  await db.prepare(`INSERT INTO invites (household_id,email,role,invited_by,created_at) VALUES (?,?,?,?,?)
                    ON CONFLICT(household_id,email) DO UPDATE SET role=excluded.role`)
          .bind(householdId, e, role, byUserId, now()).run();
  return { status: 200, joined: false };
}
