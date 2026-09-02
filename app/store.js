/** 로컬 우선 저장소 + 종단간 암호화 동기화 (docs/DATA-PRIVACY.md §8).
 *
 *  - 원본은 IndexedDB. 서버 없이도 전부 동작한다 (프로토타입의 localStorage 대체 — 용량 한도 해소).
 *  - 잠금 암호에서 파생한 CryptoKey(추출 불가)를 IndexedDB에 보관해 기기당 한 번만 묻는다.
 *  - 동기화는 가구당 봉투 하나. 낙관적 버전 + id·updatedAt 기준 병합. */
import { deriveKey, deriveKeyFor, seal, open, makeVerifier, checkPassphrase } from "./core/crypto.js";

const DB_NAME = "assetmanager", DB_VER = 1;
export const EMPTY = () => ({ v: 2, seq: 1, assets: [], trades: [], hist: {}, snaps: [], set: {}, tomb: {} });

function idb(){
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if(!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      if(!d.objectStoreNames.contains("keys")) d.createObjectStore("keys");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kvGet(store, k){
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction(store).objectStore(store).get(k);
    t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error);
  });
}
async function kvSet(store, k, v){
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction(store, "readwrite").objectStore(store).put(v, k);
    t.onsuccess = () => res(); t.onerror = () => rej(t.error);
  });
}
async function kvDel(store, k){
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction(store, "readwrite").objectStore(store).delete(k);
    t.onsuccess = () => res(); t.onerror = () => rej(t.error);
  });
}

/* ── 로컬 ─────────────────────────────────────────────────────────────── */
export async function loadLocal(householdId){
  const d = await kvGet("kv", "db:" + householdId);
  if(d) return migrate(d);
  // 프로토타입(localStorage) 데이터가 있으면 1회 이전
  try{
    const legacy = localStorage.getItem("familyAssets_v1");
    if(legacy){ const m = migrate(JSON.parse(legacy)); await saveLocal(householdId, m); return m; }
  }catch{}
  return null;
}
export async function saveLocal(householdId, db){
  await kvSet("kv", "db:" + householdId, db);
  await kvSet("kv", "meta:" + householdId, { savedAt: Date.now() });
}
export async function getMeta(householdId){ return (await kvGet("kv", "meta:" + householdId)) || {}; }
export async function setMeta(householdId, patch){
  await kvSet("kv", "meta:" + householdId, { ...(await getMeta(householdId)), ...patch });
}

/** v1(프로토타입) → v2: 적금을 INSTALLMENT로, updatedAt 부여, 인증키 제거 */
export function migrate(d){
  const out = { ...EMPTY(), ...d };
  if(!out.tomb) out.tomb = {};
  if((d.v || 1) < 2){
    const t = Date.now();
    out.assets.forEach(a => { if(a.cat === "적금" && a.mode === "RATE"){ a.mode = "INSTALLMENT"; a.monthly = a.monthly || 0; } if(!a.updatedAt) a.updatedAt = t; });
    out.trades.forEach(x => { if(!x.updatedAt) x.updatedAt = t; });
    delete out.set.rtmsKey;          // 인증키는 이제 서버 secret. 클라이언트에 남기지 않는다.
    delete out.set.proxies;
    out.v = 2;
  }
  return out;
}

/* ── 키 ───────────────────────────────────────────────────────────────── */
export async function storedKey(householdId){ return kvGet("keys", householdId); }
export async function forgetKey(householdId){ return kvDel("keys", householdId); }

/** 잠금 암호로 키를 만들어 기기에 보관. 검증기가 있으면 먼저 대조한다. */
export async function unlock(householdId, passphrase, { kdfSalt, verifier }){
  if(verifier && !(await checkPassphrase(passphrase, verifier)))
    throw new Error("잠금 암호가 다릅니다");
  const key = verifier ? await deriveKeyFor(passphrase, verifier) : await deriveKey(passphrase, kdfSalt);
  await kvSet("keys", householdId, key);
  return key;
}
export async function newVerifier(key, kdfSalt){ return makeVerifier(key, kdfSalt); }

/* ── 동기화 ───────────────────────────────────────────────────────────── */
const newer = (a, b) => (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b;

/** 두 DB를 병합. id 기준, updatedAt이 최신인 쪽. 삭제는 tomb(묘비)로 전파. */
export function merge(local, remote){
  const out = EMPTY();
  const tomb = { ...(remote.tomb || {}), ...(local.tomb || {}) };
  for(const coll of ["assets", "trades"]){
    const m = new Map();
    for(const x of (remote[coll] || [])) m.set(x.id, x);
    for(const x of (local[coll] || [])) m.set(x.id, m.has(x.id) ? newer(x, m.get(x.id)) : x);
    out[coll] = [...m.values()].filter(x => !tomb[coll + ":" + x.id] || (x.updatedAt || 0) > tomb[coll + ":" + x.id]);
  }
  // 시세 이력·스냅샷은 합집합
  out.hist = { ...(remote.hist || {}) };
  for(const k in (local.hist || {})) out.hist[k] = { ...(out.hist[k] || {}), ...local.hist[k] };
  const snapKey = s => s.ts;
  const sm = new Map((remote.snaps || []).map(s => [snapKey(s), s]));
  (local.snaps || []).forEach(s => sm.set(snapKey(s), s));
  out.snaps = [...sm.values()].sort((a, b) => a.ts < b.ts ? -1 : 1);
  out.set = { ...(remote.set || {}), ...(local.set || {}) };
  out.tomb = tomb;
  out.seq = Math.max(local.seq || 1, remote.seq || 1,
    ...out.assets.map(a => a.id || 0), ...out.trades.map(t => t.id || 0)) + 1;
  out.v = 2;
  return out;
}

/**
 * 서버와 동기화. 반환: {db, version, pushed, pulled}
 *  1) 서버 봉투 가져와 복호화
 *  2) 로컬과 병합
 *  3) 병합 결과가 서버와 다르면 암호화해 올림 (409면 한 번 더 시도)
 */
export async function sync({ api, householdId, key, kdfSalt, local }){
  const remote = await api.vault.get(householdId);
  let base = remote.version, remoteDb = null;
  if(remote.envelope){
    remoteDb = migrate(await open(key, remote.envelope));
  }
  const merged = remoteDb ? merge(local, remoteDb) : local;
  const changed = !remoteDb || JSON.stringify(strip(merged)) !== JSON.stringify(strip(remoteDb));
  let pushed = false;
  if(changed){
    for(let attempt = 0; attempt < 2; attempt++){
      const env = await seal(key, merged, { salt: kdfSalt });
      const r = await api.vault.put(householdId, base, env);
      if(r.status === 200){ base = r.version; pushed = true; break; }
      if(r.status === 409){
        const again = await api.vault.get(householdId);
        base = again.version;
        if(again.envelope){ const rd = migrate(await open(key, again.envelope)); Object.assign(merged, merge(merged, rd)); }
        continue;
      }
      throw new Error(r.error || "동기화 실패");
    }
  }
  await setMeta(householdId, { syncedAt: Date.now(), version: base });
  return { db: merged, version: base, pushed, pulled: !!remoteDb };
}
const strip = d => ({ a: d.assets, t: d.trades, h: d.hist, s: d.snaps, set: d.set, tomb: d.tomb });
