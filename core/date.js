/** 날짜 유틸 — 전부 UTC 기준으로 다뤄 시간대·서머타임 영향을 받지 않는다.
 *  자산 데이터의 날짜는 모두 "YYYY-MM-DD" 문자열(달력 날짜)이다. */

/** "YYYY-MM-DD" → UTC 자정 Date */
export function dOf(iso){
  const p = String(iso).slice(0, 10).split("-");
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
}

/** Date → "YYYY-MM-DD" (UTC 기준) */
export function isoOf(d){
  return d.getUTCFullYear() + "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
    String(d.getUTCDate()).padStart(2, "0");
}

export function addDays(iso, n){
  const d = dOf(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return isoOf(d);
}

export function addMonths(iso, n){
  const d = dOf(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  // 말일 보정: 1/31 + 1개월 → 2/28
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return isoOf(d);
}

/** a → b 경과 일수 (음수 가능) */
export function daysBetween(aISO, bISO){
  return Math.round((dOf(bISO) - dOf(aISO)) / 86400000);
}

/** a → b 경과 개월 수 (완전히 채운 개월만) */
export function monthsBetween(aISO, bISO){
  const a = dOf(aISO), b = dOf(bISO);
  let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if(b.getUTCDate() < a.getUTCDate()) m -= 1;
  return m;
}

/** 두 날짜 중 이른 쪽 */
export function minISO(a, b){
  if(!a) return b;
  if(!b) return a;
  return a <= b ? a : b;
}

export function todayISO(now = new Date()){
  return isoOf(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}
