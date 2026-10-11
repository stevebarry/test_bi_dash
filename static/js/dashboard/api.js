/*
 * Thin fetch wrapper for the dashboard's JSON API (/api/meta, /api/kpis,
 * /api/aggregate). These endpoints are the generic backend contract; the
 * data model behind them is described by /api/meta.
 */

/**
 * GET `path`, or POST `body` as JSON when one is given. Resolves to the
 * parsed JSON. On a non-2xx response, throws an Error carrying the server's
 * `error` message (if any) and the HTTP `status`.
 */
export async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let payload = null;
  try { payload = await res.json(); } catch (e) { /* non-JSON error */ }
  if (!res.ok) {
    const err = new Error((payload && payload.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return payload;
}
