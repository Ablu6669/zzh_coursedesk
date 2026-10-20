const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};
const handle = async (event) => {
  return { ok: true, echo: (event && event.action) || 'none', time: Date.now() };
};
exports.main = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  try {
    const r = await handle(event || {});
    if (event && event.httpMethod) return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(r) };
    return r;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
};
