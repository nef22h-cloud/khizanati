// خزانتي — وسيط الذكاء الاصطناعي (Cloudflare Worker)
// يحفظ مفتاح Claude سرًّا على الخادم، ويستقبل طلبات التطبيق المحمية برمز دخول.
//
// المسارات (كلها POST):
//   /ping     يتأكد من الرمز فقط
//   /tag      { prompt, images[] } ← { data: {...} }  (تحليل صورة القطعة وإرجاع JSON)
//   /stylist  { prompt, images[] } ← نص يتدفق تدريجيًا   (رأي المصمم)
//
// الأسرار (wrangler secret put): ANTHROPIC_API_KEY, APP_PASSCODE
// المتغيرات (wrangler.toml): ALLOWED_ORIGINS, MODEL

import Anthropic from "@anthropic-ai/sdk";

const MAX_PROMPT_CHARS = 8000;
const MAX_IMAGES = 8;
const MAX_IMAGE_B64 = 1_500_000; // ≈ 1.1MB لكل صورة (صور التطبيق أصغر بكثير)
const MAX_BODY_BYTES = 9_000_000;
const DATA_URL = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-app-passcode",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors },
  });

// مقارنة ثابتة الزمن عشان ما يُخمَّن الرمز من سرعة الرد
function safeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function parseBody(body) {
  if (!body || typeof body.prompt !== "string") return null;
  const prompt = body.prompt.trim();
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) return null;
  const imgs = Array.isArray(body.images) ? body.images : [];
  if (!imgs.length || imgs.length > MAX_IMAGES) return null;
  const images = [];
  for (const s of imgs) {
    const m = typeof s === "string" && s.length <= MAX_IMAGE_B64 + 40 ? DATA_URL.exec(s) : null;
    if (!m) return null;
    images.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
  }
  return { prompt, images };
}

function requestParams(env, { prompt, images }) {
  return {
    model: env.MODEL || "claude-opus-5-5",
    max_tokens: 4000,
    output_config: { effort: "low" }, // مهام قصيرة: تصنيف وتعليق من ٣ جمل
    // لو رفض النموذج الطلب، يعيد الخادم المحاولة تلقائيًا بنموذج بديل
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [{ role: "user", content: [...images, { type: "text", text: prompt }] }],
  };
}

function errorResponse(err, cors) {
  console.error("anthropic error:", err && (err.status || ""), err && err.message);
  if (err instanceof Anthropic.RateLimitError) return json({ error: "rate_limited" }, 429, cors);
  if (err instanceof Anthropic.AuthenticationError) return json({ error: "upstream_auth" }, 502, cors);
  if (err instanceof Anthropic.BadRequestError) return json({ error: "upstream_bad_request" }, 502, cors);
  if (err instanceof Anthropic.APIError) return json({ error: "upstream_error" }, 502, cors);
  return json({ error: "server_error" }, 500, cors);
}

function extractJSON(text) {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

async function handleTag(client, params, cors) {
  let msg;
  try { msg = await client.beta.messages.create(params); }
  catch (e) { return errorResponse(e, cors); }
  if (msg.stop_reason === "refusal") return json({ error: "refused" }, 422, cors);
  const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
  const data = extractJSON(text);
  return data ? json({ data }, 200, cors) : json({ error: "bad_output" }, 502, cors);
}

async function handleStylist(client, params, cors) {
  const it = client.beta.messages.stream(params)[Symbol.asyncIterator]();
  let first;
  // ننتظر أول حدث قبل ما نرد، عشان أخطاء الاتصال ترجع برمز HTTP صحيح
  try { first = await it.next(); }
  catch (e) { return errorResponse(e, cors); }
  const enc = new TextEncoder();
  const textOf = ev => ev && ev.type === "content_block_delta" && ev.delta.type === "text_delta" ? ev.delta.text : "";
  const body = new ReadableStream({
    async start(ctrl) {
      try {
        if (!first.done) {
          const t = textOf(first.value);
          if (t) ctrl.enqueue(enc.encode(t));
          for (let r = await it.next(); !r.done; r = await it.next()) {
            const t2 = textOf(r.value);
            if (t2) ctrl.enqueue(enc.encode(t2));
          }
        }
        ctrl.close();
      } catch (e) {
        console.error("stream error:", e && e.message);
        ctrl.error(e);
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...cors },
  });
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (!cors) return new Response("Forbidden", { status: 403 });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const { pathname } = new URL(req.url);
    if (req.method !== "POST" || !["/ping", "/tag", "/stylist"].includes(pathname))
      return json({ error: "not_found" }, 404, cors);
    if (!env.ANTHROPIC_API_KEY || !env.APP_PASSCODE) return json({ error: "not_configured" }, 500, cors);
    if (!safeEqual(req.headers.get("x-app-passcode") || "", env.APP_PASSCODE))
      return json({ error: "unauthorized" }, 401, cors);
    if (pathname === "/ping") return json({ ok: true }, 200, cors);

    if (+(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) return json({ error: "too_large" }, 413, cors);
    let body;
    try { body = parseBody(await req.json()); } catch { body = null; }
    if (!body) return json({ error: "bad_request" }, 400, cors);

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const params = requestParams(env, body);
    return pathname === "/tag" ? handleTag(client, params, cors) : handleStylist(client, params, cors);
  },
};
