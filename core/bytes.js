/** base64 ↔ 바이트 변환. 브라우저·Worker·Node 22에서 동일하게 동작한다. */

export function toB64(bytes){
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for(let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

export function fromB64(b64){
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for(let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const utf8 = new TextEncoder();
export const utf8d = new TextDecoder();

/** 상수 시간 비교 — 길이가 달라도 조기 반환으로 정보를 흘리지 않는다 */
export function timingSafeEqual(a, b){
  if(a.length !== b.length) return false;
  let diff = 0;
  for(let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
