/** Cloudflare Worker 진입점.
 *
 *  경로
 *    GET  /api/me                        내 정보 + 가구 목록
 *    GET  /api/vault?h=<id>              암호문 봉투
 *    PUT  /api/vault?h=<id>              봉투 저장 {baseVersion, envelope}
 *    PUT  /api/household/verifier?h=     잠금 암호 검증기 등록
 *    POST /api/household/invite?h=       {email, role}
 *    GET  /api/quote?kr=005930,069500&us=AAPL,VOO&fx=1&idx=1
 *    GET  /api/history?market=KR&code=005930&from=2025-01-01
 *    GET  /api/rtms?lawd=28185&kind=아파트&months=6&complex=송도더샵&area=84.98
 *
 *  인증은 Cloudflare Access가 앞에서 처리한다. 여기서는 JWT를 검증해 이메일만 얻는다.
 *  정적 파일(app/)은 wrangler.toml의 [assets] 가 서빙한다. */
import { verifyAccessJWT } from "./access.js";
import { ensureUser, householdsFor, memberRole, getVault, putVault, setVerifier, invite } from "./sync.js";
import { getMonths, estimate } from "./rtms.js";
import { krQuote, usQuote, krHistory, usHistory, fx, cached } from "./quote.js";
import { pool } from "../core/pool.js";
import { toB64 } from "../core/bytes.js";

const INDEXES = { "S&P 500": "^GSPC", "NASDAQ 100": "^NDX", "KOSPI": "^KS11", "KOSDAQ": "^KQ11" };
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store", ...SECURITY, ...extra } });
const err = (msg, status = 400) => json({ error: msg }, status);

/** 모든 응답에 붙는 보안 헤더. CSP는 인라인 스크립트를 막는다 — app/은 인라인 onclick을 쓰지 않는다. */
const SECURITY = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "geolocation=(), camera=(), microphone=()"
};

const todayISO = () => new Date().toISOString().slice(0, 10);

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);
    if(!url.pathname.startsWith("/api/")){
      // 정적 자산은 [assets] 바인딩이 처리. 보안 헤더만 덧붙인다.
      const res = await env.ASSETS.fetch(request);
      const h = new Headers(res.headers);
      for(const k in SECURITY) h.set(k, SECURITY[k]);
      return new Response(res.body, { status: res.status, headers: h });
    }
    try{
      return await route(request, env, url);
    }catch(e){
      return err(e.message || "서버 오류", e.status || 500);
    }
  }
};

async function authenticate(request, env){
  if(env.DEV_BYPASS_EMAIL && env.ENVIRONMENT === "dev")     // 로컬 개발 전용
    return { email: env.DEV_BYPASS_EMAIL };
  const token = request.headers.get("Cf-Access-Jwt-Assertion") ||
                (request.headers.get("cookie") || "").match(/CF_Authorization=([^;]+)/)?.[1];
  return verifyAccessJWT(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
}

async function requireMember(db, householdId, userId, roles){
  const role = await memberRole(db, householdId, userId);
  if(!role) throw Object.assign(new Error("이 가구의 구성원이 아닙니다"), { status: 403 });
  if(roles && !roles.includes(role)) throw Object.assign(new Error("권한이 없습니다 (" + role + ")"), { status: 403 });
  return role;
}

async function route(request, env, url){
  const p = url.pathname, q = url.searchParams, db = env.DB;

  /* ── 시세: 개인정보 없음. 인증은 요구하되(남용 방지) 사용자 식별은 하지 않는다 ── */
  if(p === "/api/quote" || p === "/api/history" || p === "/api/rtms"){
    await authenticate(request, env);
  }

  if(p === "/api/quote" && request.method === "GET"){
    const kr = (q.get("kr") || "").split(",").filter(Boolean);
    const us = (q.get("us") || "").split(",").filter(Boolean);
    const jobs = [];
    kr.forEach(c => jobs.push(["KR:" + c, () => cached("q:kr:" + c, 60, () => krQuote(c))]));
    us.forEach(s => jobs.push(["US:" + s, () => cached("q:us:" + s, 60, () => usQuote(s))]));
    if(q.get("fx")) jobs.push(["FX", () => cached("fx", 600, () => fx())]);
    if(q.get("idx")) for(const nm in INDEXES)
      jobs.push(["IDX:" + nm, () => cached("q:us:" + INDEXES[nm], 120, () => usQuote(INDEXES[nm]))]);

    const results = await pool(jobs, ([, fn]) => fn(), 6);          // ← 순차 13회 → 동시 6
    const quotes = {}, errors = {};
    results.forEach((r, i) => { const k = jobs[i][0]; if(r.ok) quotes[k] = r.value; else errors[k] = r.error.message; });
    return json({ quotes, errors, at: new Date().toISOString() });
  }

  if(p === "/api/history" && request.method === "GET"){
    const market = (q.get("market") || "KR").toUpperCase(), code = q.get("code");
    if(!code) return err("code 필요");
    const from = q.get("from") || new Date(Date.now() - 3 * 365 * 86400e3).toISOString().slice(0, 10);
    const to = todayISO();
    const key = `h:${market}:${code}:${from}:${to}`;
    const r = await cached(key, 3600, async () => ({
      rows: market === "KR" ? await krHistory(code, from, to)
                            : await usHistory(code, rangeFor(from))
    }));
    return json({ market, code, from, to, rows: r.rows, cached: r.cached });
  }

  if(p === "/api/rtms" && request.method === "GET"){
    const lawd = (q.get("lawd") || "").trim();
    if(!/^\d{5}$/.test(lawd)) return err("lawd는 5자리 법정동코드");
    const kind = q.get("kind") || "아파트";
    const months = Math.min(24, Math.max(1, Number(q.get("months")) || 6));
    const r = await getMonths({ db, lawd, kind, months, key: env.RTMS_KEY, today: todayISO() });
    const est = estimate(r.deals, { complex: q.get("complex") || "", area: Number(q.get("area")) || 0 });
    return json({ lawd, kind, months: r.months, cachedMonths: r.cachedMonths, errors: r.errors,
                  deals: est.matched.length ? est.matched : r.deals.slice(0, 500),
                  totalDeals: r.deals.length, summary: est.summary, msg: est.msg });
  }

  /* ── 이하 개인 데이터: 사용자 식별 필요 ── */
  const { email } = await authenticate(request, env);
  const user = await ensureUser(db, email);

  if(p === "/api/me" && request.method === "GET"){
    const hs = await householdsFor(db, user, { saltB64: toB64(crypto.getRandomValues(new Uint8Array(16))) });
    return json({ user: { id: user.id, email: user.email, name: user.display_name },
      households: hs.map(h => ({ id: h.id, name: h.name, role: h.role, kdfSalt: h.kdf_salt,
        verifier: h.verifier ? JSON.parse(h.verifier) : null })) });
  }

  const hid = q.get("h");
  if(!hid) return err("h(가구 id) 필요");

  if(p === "/api/vault" && request.method === "GET"){
    await requireMember(db, hid, user.id);
    return json(await getVault(db, hid));
  }
  if(p === "/api/vault" && request.method === "PUT"){
    await requireMember(db, hid, user.id, ["owner", "editor"]);
    const body = await request.json().catch(() => null);
    if(!body) return err("JSON 본문 필요");
    const r = await putVault(db, hid, user.id, body);
    return json(r, r.status);
  }
  if(p === "/api/household/verifier" && request.method === "PUT"){
    await requireMember(db, hid, user.id, ["owner"]);
    const body = await request.json().catch(() => null);
    if(!body || !body.ct) return err("검증기 봉투 필요");
    await setVerifier(db, hid, body);
    return json({ ok: true });
  }
  if(p === "/api/household/invite" && request.method === "POST"){
    await requireMember(db, hid, user.id, ["owner"]);
    const body = await request.json().catch(() => ({}));
    if(!body.email) return err("email 필요");
    const r = await invite(db, hid, user.id, body.email, body.role || "editor");
    return json(r, r.status);
  }

  return err("없는 경로", 404);
}

function rangeFor(fromISO){
  const days = (Date.now() - new Date(fromISO)) / 86400e3;
  return days <= 35 ? "1mo" : days <= 100 ? "3mo" : days <= 200 ? "6mo" : days <= 370 ? "1y"
       : days <= 740 ? "2y" : days <= 1100 ? "3y" : "5y";
}
