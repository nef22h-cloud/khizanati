// اختبارات الوسيط بدون مفتاح حقيقي: نستبدل fetch باستجابات وهمية لواجهة Claude.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const ORIGIN = "https://nef22h-cloud.github.io";
const env = { ANTHROPIC_API_KEY: "test-key", APP_PASSCODE: "s3cret", ALLOWED_ORIGINS: ORIGIN + ",http://localhost:8000", MODEL: "claude-opus-5-5" };
const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const realFetch = globalThis.fetch;
let calls;

function call(path, { body, origin = ORIGIN, code = "s3cret", method = "POST" } = {}) {
  const headers = { "content-type": "application/json" };
  if (origin) headers.Origin = origin;
  if (code !== null) headers["x-app-passcode"] = code;
  return worker.fetch(new Request("https://w.example" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
}

function mockAnthropic(handler) {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://api.anthropic.com/")) return realFetch(input, init);
    const req = JSON.parse(init.body);
    calls.push({ url, req, headers: init.headers });
    return handler(req);
  };
}

const message = (text, stop_reason = "end_turn") => new Response(JSON.stringify({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5",
  content: [{ type: "text", text }], stop_reason, stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
}), { status: 200, headers: { "content-type": "application/json" } });

function sse(chunks) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let s = ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  s += ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  for (const c of chunks) s += ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: c } });
  s += ev("content_block_stop", { index: 0 });
  s += ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  s += ev("message_stop", {});
  return new Response(s, { status: 200, headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => { calls = []; globalThis.fetch = realFetch; });

test("rejects unknown origins", async () => {
  const r = await call("/ping", { origin: "https://evil.example" });
  assert.equal(r.status, 403);
});

test("answers CORS preflight for allowed origin", async () => {
  const r = await call("/tag", { method: "OPTIONS" });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
});

test("rejects wrong or missing passcode", async () => {
  assert.equal((await call("/ping", { code: "nope" })).status, 401);
  assert.equal((await call("/ping", { code: null })).status, 401);
});

test("ping succeeds with right passcode", async () => {
  const r = await call("/ping");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test("validates body", async () => {
  assert.equal((await call("/tag", { body: { prompt: "x", images: [] } })).status, 400);
  assert.equal((await call("/tag", { body: { prompt: "x", images: ["https://not-a-data-url"] } })).status, 400);
  assert.equal((await call("/tag", { body: { prompt: "", images: [IMG] } })).status, 400);
  assert.equal((await call("/tag", { body: { prompt: "x", images: Array(9).fill(IMG) } })).status, 400);
  assert.equal(calls.length, 0);
});

test("/tag returns parsed JSON and sends the right request", async () => {
  mockAnthropic(() => message('Sure: {"cat":"top","sub":"تيشيرت","colors":["أسود"]}'));
  const r = await call("/tag", { body: { prompt: "classify", images: [IMG] } });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).data, { cat: "top", sub: "تيشيرت", colors: ["أسود"] });
  const { req, url, headers } = calls[0];
  assert.match(url, /\/v1\/messages/);
  assert.equal(req.model, "claude-opus-5-5");
  assert.equal(req.fallbacks, "default");
  assert.equal(req.output_config.effort, "low");
  assert.equal(req.messages[0].content[0].type, "image");
  assert.equal(req.messages[0].content[0].source.media_type, "image/jpeg");
  assert.equal(req.messages[0].content.at(-1).text, "classify");
  const h = new Headers(headers);
  assert.ok(h.get("x-api-key") === "test-key" || h.get("authorization") === "Bearer test-key");
  assert.match(h.get("anthropic-beta") || "", /server-side-fallback-2026-07-01/);
});

test("/tag reports refusals and unparseable output", async () => {
  mockAnthropic(() => message("", "refusal"));
  assert.equal((await call("/tag", { body: { prompt: "x", images: [IMG] } })).status, 422);
  mockAnthropic(() => message("no json here"));
  assert.equal((await call("/tag", { body: { prompt: "x", images: [IMG] } })).status, 502);
});

test("maps upstream rate limit to 429", async () => {
  mockAnthropic(() => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), { status: 429, headers: { "content-type": "application/json", "x-should-retry": "false" } }));
  const r = await call("/tag", { body: { prompt: "x", images: [IMG] } });
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { error: "rate_limited" });
});

test("/stylist streams text", async () => {
  mockAnthropic(() => sse(["الطقم ", "حلو ", "مرة"]));
  const r = await call("/stylist", { body: { prompt: "رأيك", images: [IMG, IMG] } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(await r.text(), "الطقم حلو مرة");
  assert.equal(calls[0].req.stream, true);
  assert.equal(calls[0].req.messages[0].content.length, 3);
});

test("/stylist returns an HTTP error when the upstream fails before streaming", async () => {
  mockAnthropic(() => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }), { status: 401, headers: { "content-type": "application/json" } }));
  const r = await call("/stylist", { body: { prompt: "x", images: [IMG] } });
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { error: "upstream_auth" });
});
