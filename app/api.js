/** /api 클라이언트. 같은 오리진이라 CORS·프록시가 없다. Access 쿠키는 브라우저가 자동으로 붙인다. */
import { fetchWithTimeout } from "./core/pool.js";

async function call(path, { method = "GET", body, timeoutMs = 20_000 } = {}){
  const res = await fetchWithTimeout(path, { method, timeoutMs, credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined });
  if(res.status === 401 || res.status === 403){
    // Access 세션 만료 → 로그인 페이지로 (Access가 리디렉션을 처리한다)
    if(res.headers.get("content-type")?.includes("text/html")){ location.reload(); return null; }
  }
  const data = await res.json().catch(() => ({ error: "응답 형식 오류 (" + res.status + ")" }));
  if(!res.ok && res.status !== 409) throw Object.assign(new Error(data.error || ("HTTP " + res.status)), { status: res.status, data });
  return { status: res.status, ...data };
}

export const api = {
  me: () => call("/api/me"),
  vault: {
    get: h => call("/api/vault?h=" + encodeURIComponent(h)),
    put: (h, baseVersion, envelope) => call("/api/vault?h=" + encodeURIComponent(h), { method: "PUT", body: { baseVersion, envelope } })
  },
  household: {
    setVerifier: (h, v) => call("/api/household/verifier?h=" + encodeURIComponent(h), { method: "PUT", body: v }),
    invite: (h, email, role) => call("/api/household/invite?h=" + encodeURIComponent(h), { method: "POST", body: { email, role } })
  },
  quote: ({ kr = [], us = [], fx = true, idx = true } = {}) =>
    call(`/api/quote?kr=${kr.map(encodeURIComponent).join(",")}&us=${us.map(encodeURIComponent).join(",")}${fx ? "&fx=1" : ""}${idx ? "&idx=1" : ""}`,
         { timeoutMs: 30_000 }),
  history: (market, code, from) =>
    call(`/api/history?market=${market}&code=${encodeURIComponent(code)}${from ? "&from=" + from : ""}`, { timeoutMs: 30_000 }),
  rtms: ({ lawd, kind, months, complex, area }) =>
    call(`/api/rtms?lawd=${lawd}&kind=${encodeURIComponent(kind)}&months=${months}` +
         `&complex=${encodeURIComponent(complex || "")}&area=${area || 0}`, { timeoutMs: 60_000 })
};
