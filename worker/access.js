/** Cloudflare Access JWT 검증.
 *  Access가 앱 앞에서 로그인을 처리하고, 통과한 요청에 Cf-Access-Jwt-Assertion 헤더를 붙인다.
 *  Worker는 그 JWT를 팀 도메인의 공개키로 검증해 이메일을 얻는다. 비밀번호는 어디에도 없다. */

const b64url = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); return atob(s + "=".repeat((4 - s.length % 4) % 4)); };
const b64urlBytes = s => Uint8Array.from(b64url(s), c => c.charCodeAt(0));
const json = s => JSON.parse(b64url(s));

let jwksCache = { url: null, keys: null, at: 0 };

export async function fetchJwks(teamDomain, fetchImpl = fetch, ttlMs = 3600_000){
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  if(jwksCache.url === url && Date.now() - jwksCache.at < ttlMs) return jwksCache.keys;
  const res = await fetchImpl(url);
  if(!res.ok) throw new Error("Access 공개키 조회 실패 " + res.status);
  const { keys } = await res.json();
  jwksCache = { url, keys, at: Date.now() };
  return keys;
}

export function resetJwksCache(){ jwksCache = { url: null, keys: null, at: 0 }; }

/**
 * @returns {Promise<{email:string, sub:string, exp:number}>}
 * @throws 서명·만료·발급자·대상 중 하나라도 어긋나면
 */
export async function verifyAccessJWT(token, { teamDomain, aud, now = Date.now() / 1000, jwks }){
  if(!token) throw new Error("Access 토큰이 없습니다");
  const parts = token.split(".");
  if(parts.length !== 3) throw new Error("JWT 형식 오류");
  const header = json(parts[0]), payload = json(parts[1]);
  if(header.alg !== "RS256") throw new Error("지원하지 않는 알고리즘 " + header.alg);

  const keys = jwks || await fetchJwks(teamDomain);
  const jwk = keys.find(k => k.kid === header.kid);
  if(!jwk) throw new Error("서명 키를 찾을 수 없음 (kid " + header.kid + ")");

  const key = await crypto.subtle.importKey("jwk", { ...jwk, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key,
    b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if(!ok) throw new Error("JWT 서명 불일치");

  if(payload.exp && payload.exp < now) throw new Error("토큰 만료");
  if(payload.nbf && payload.nbf > now + 60) throw new Error("토큰 미발효");
  if(payload.iss !== `https://${teamDomain}`) throw new Error("발급자 불일치");
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if(!auds.includes(aud)) throw new Error("대상(aud) 불일치");
  if(!payload.email) throw new Error("이메일 클레임 없음");

  return { email: String(payload.email).toLowerCase(), sub: payload.sub, exp: payload.exp };
}
