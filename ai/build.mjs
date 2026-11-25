// يحسب متجهات أوصاف الأنواع مرة وحدة ويحفظها في labels.json،
// عشان الجوال يحمّل نصف النموذج الخاص بالصور فقط.
import { AutoTokenizer, SiglipTextModel } from "@huggingface/transformers";
import { writeFileSync } from "node:fs";
import { LABELS, TEMPLATES } from "./labels.mjs";

export const MODEL = "Marqo/marqo-fashionSigLIP";
const tok = await AutoTokenizer.from_pretrained(MODEL);
const tm = await SiglipTextModel.from_pretrained(MODEL, { dtype: "fp32" });
const norm = v => { const n = Math.hypot(...v); return v.map(x => x / n); };

const labels = [], vecs = [];
for (const [cat, sub, descs] of LABELS) for (const d of descs) {
  const texts = TEMPLATES.map(t => t.replace("{}", d));
  const { text_embeds } = await tm(tok(texts, { padding: "max_length", truncation: true }));
  const D = text_embeds.dims[1], avg = new Array(D).fill(0);
  for (let i = 0; i < texts.length; i++) norm(Array.from(text_embeds.data.slice(i * D, (i + 1) * D))).forEach((x, j) => (avg[j] += x));
  labels.push([cat, sub]); vecs.push(norm(avg));
}
// ضغط كل متجه إلى int8 مع معامل تحجيم (يكفي للمقارنة)
const dim = vecs[0].length, bytes = new Int8Array(vecs.length * dim), scales = [];
vecs.forEach((v, i) => {
  const s = Math.max(...v.map(Math.abs)) / 127; scales.push(+s.toPrecision(6));
  v.forEach((x, j) => (bytes[i * dim + j] = Math.round(x / s)));
});
writeFileSync(new URL("./labels.json", import.meta.url), JSON.stringify({
  model: MODEL, dim, labels, scales, data: Buffer.from(bytes.buffer).toString("base64"),
}));
console.log(`labels.json: ${labels.length} descriptors × ${dim}`);
