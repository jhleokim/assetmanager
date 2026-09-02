/** 종단간 암호화 — 자산 데이터는 브라우저를 벗어나기 전에 여기서 암호화된다.
 *
 *  설계 근거는 docs/DATA-PRIVACY.md.
 *  키는 사용자의 "데이터 잠금 암호"에서만 파생되며 서버로 전송되지 않는다.
 *  PBKDF2가 브라우저에서 돌기 때문에 Workers의 CPU 10ms 제약과 무관하게
 *  OWASP 권장치(600,000회)를 그대로 쓸 수 있다. */
import { toB64, fromB64, utf8, utf8d } from "./bytes.js";

export const KDF = { alg: "PBKDF2-SHA256", iterations: 600_000, hash: "SHA-256" };
export const ENVELOPE_VERSION = 1;

export function randomSalt(len = 16){
  return crypto.getRandomValues(new Uint8Array(len));
}

/**
 * 잠금 암호 → AES-GCM 256비트 키.
 * @param {string} passphrase
 * @param {Uint8Array|string} salt  가구별 salt (base64 문자열도 허용)
 * @param {number} iterations
 * @returns {Promise<CryptoKey>} extractable:false — JS로 키를 꺼낼 수 없다
 */
export async function deriveKey(passphrase, salt, iterations = KDF.iterations){
  if(!passphrase) throw new Error("잠금 암호가 비어 있습니다");
  const s = typeof salt === "string" ? fromB64(salt) : salt;
  const material = await crypto.subtle.importKey(
    "raw", utf8.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: KDF.hash, salt: s, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,                                  // 키를 추출 불가능하게 잠근다
    ["encrypt", "decrypt"]);
}

/**
 * 객체를 암호화해 서버에 올릴 봉투로 만든다.
 * 봉투에는 복호화에 필요한 공개 정보(salt·iv·반복횟수)만 들어가고 키는 없다.
 */
export async function seal(key, data, { salt, iterations = KDF.iterations } = {}){
  const iv = crypto.getRandomValues(new Uint8Array(12));   // GCM 권장 96비트
  const plaintext = utf8.encode(JSON.stringify(data));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    v: ENVELOPE_VERSION,
    kdf: { alg: KDF.alg, iterations, salt: typeof salt === "string" ? salt : toB64(salt) },
    iv: toB64(iv),
    ct: toB64(new Uint8Array(ct))
  };
}

/** 봉투를 열어 원래 객체로. 암호가 틀리면 예외를 던진다(GCM 인증 태그 검증). */
export async function open(key, envelope){
  if(!envelope || envelope.v !== ENVELOPE_VERSION)
    throw new Error("알 수 없는 봉투 형식입니다 (v=" + (envelope && envelope.v) + ")");
  let plain;
  try{
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(envelope.iv) }, key, fromB64(envelope.ct));
  }catch{
    throw new Error("복호화 실패 — 잠금 암호가 다르거나 데이터가 손상되었습니다");
  }
  return JSON.parse(utf8d.decode(plain));
}

/** 봉투에 기록된 파라미터로 키를 다시 파생한다 (다른 기기에서 열 때) */
export async function deriveKeyFor(passphrase, envelope){
  const kdf = (envelope && envelope.kdf) || {};
  if(kdf.alg && kdf.alg !== KDF.alg) throw new Error("지원하지 않는 KDF: " + kdf.alg);
  return deriveKey(passphrase, kdf.salt, kdf.iterations || KDF.iterations);
}

/** 잠금 암호 확인용 — 실제 데이터를 열어보지 않고 검증한다 */
export async function makeVerifier(key, salt){
  return seal(key, { check: "assetmanager" }, { salt });
}
export async function checkPassphrase(passphrase, verifier){
  try{
    const key = await deriveKeyFor(passphrase, verifier);
    const v = await open(key, verifier);
    return v && v.check === "assetmanager";
  }catch{ return false; }
}
