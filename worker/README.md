# وسيط الذكاء الاصطناعي لخزانتي (Cloudflare Worker)

خادم صغير يحفظ مفتاح Claude سرًّا، ويخلّي تطبيق خزانتي يستخدم ميزات الذكاء الاصطناعي:
- تحديد نوع القطعة ولونها ومناسباتها وموسمها من الصورة.
- «رأي المصمم» في الطقم.

المفتاح ما يوصل للمتصفح أبدًا. والوسيط محمي بثلاث طبقات:
1. **رمز دخول** تختاره أنت، وبدونه يُرفض أي طلب.
2. **قائمة المواقع المسموحة:** موقع التطبيق فقط.
3. **حدود للطلبات:** عدد الصور وحجمها وطول النص.

## اللي تحتاجه
- حساب في [Anthropic Console](https://console.anthropic.com) ومفتاح API (يبدأ بـ `sk-ant-`).
- حساب مجاني في [Cloudflare](https://dash.cloudflare.com/sign-up).

## خطوات النشر (من المتصفح، بدون أوامر)

### ١) أنشئ الـ Worker من المستودع
1. ادخل [لوحة Cloudflare](https://dash.cloudflare.com) ← **Workers & Pages** ← **Create**.
2. اختر **Import a repository** واربط حساب GitHub، ثم اختر المستودع `khizanati`.
3. في الإعدادات:
   - **Project name:** `khizanati-ai`
   - **Root directory** (أو Path): `worker`
   - اترك أمر النشر الافتراضي: `npx wrangler deploy`
4. اضغط **Deploy** وانتظر حتى ينتهي.

### ٢) أضف الأسرار
افتح الـ Worker ← **Settings** ← **Variables and Secrets** ← **Add**، وأضف متغيرين من نوع **Secret**:

| الاسم | القيمة |
|---|---|
| `ANTHROPIC_API_KEY` | مفتاحك من Anthropic Console |
| `APP_PASSCODE` | رمز دخول تختاره (طويل وصعب التخمين) |

بعد الحفظ، انسخ رابط الـ Worker من صفحته. شكله كذا:
`https://khizanati-ai.<اسمك>.workers.dev`

### ٣) فعّل الميزة في التطبيق
افتح التطبيق ← تبويب **خزانتي** ← **✨ الذكاء الاصطناعي** ← حط الرابط ورمز الدخول ← **حفظ وتجربة**.
لازم تسوي هذي الخطوة في كل جوال أو متصفح تستخدمه.

## التكلفة
- كل طلب يُحسب على حسابك في Anthropic. صور التطبيق صغيرة والردود قصيرة، فالطلب الواحد تكلفته بسيطة.
- **أنصحك تحط حد إنفاق شهري** من Anthropic Console ← Billing ← Limits.
- النموذج الافتراضي `claude-opus-5-5`. لو تبي تكلفة أقل، غيّر `MODEL` في `wrangler.toml` إلى `claude-haiku-5-5` (أرخص بكثير، ودقته أقل شوي).
- لو رفض النموذج طلبًا، يعيد Anthropic المحاولة تلقائيًا بنموذج بديل، والإعادة تُحسب بسعر النموذج البديل.

## الإعدادات (`wrangler.toml`)
- `ALLOWED_ORIGINS`: المواقع المسموح لها، مفصولة بفاصلة. لو غيّرت رابط التطبيق، عدّلها.
- `MODEL`: النموذج المستخدم.

أي تعديل ترفعه على مجلد `worker/` في فرع `main` يتنشر تلقائيًا.

## للمطورين
```bash
cd worker
npm install
npm test                                  # اختبارات بدون مفتاح حقيقي
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .dev.vars
echo 'APP_PASSCODE=dev-code' >> .dev.vars
npm run dev                               # تشغيل محلي على http://localhost:8787
```

### المسارات (كلها POST، وتحتاج الترويسة `x-app-passcode`)
| المسار | المدخلات | المخرجات |
|---|---|---|
| `/ping` | — | `{ "ok": true }` |
| `/tag` | `{ prompt, images: [dataURL...] }` | `{ "data": {...} }` |
| `/stylist` | `{ prompt, images: [dataURL...] }` | نص يتدفق تدريجيًا |

### رموز الأخطاء
`401 unauthorized` · `403` موقع غير مسموح · `400 bad_request` · `413 too_large` · `422 refused` · `429 rate_limited` · `502 upstream_*`
