/**
* 初见雷达 · Cloudflare Worker
*
* 作用：藏住阿里云百炼（DashScope）API Key，代前端调用通义千问 VL 识图模型。
*
* 路由：
* GET / 健康检查，返回一行文本
* POST /analyze 入参 JSON { image_base64, scene}，出参第一印象报告 JSON
*
* 环境变量（在 Cloudflare 后台或 wrangler 里设置）：
* DASHSCOPE_API_KEY 必填。百炼 API Key。用 `wrangler secret put DASHSCOPE_API_KEY`
* 或后台「Settings → Variables and Secrets」添加为 Secret，
* 绝不要写进代码或提交到 GitHub。
* MODEL 可选。默认 "qwen3-vl-plus"（2026-10-31 实测：旧名 qwen-vl-plus 在当前百炼业务空间返回 model_not_found）。
* LIMITS 可选但生产环境必须绑定。Cloudflare KV 命名空间绑定，存两道限流
* 保险的每日计数（全站每日上限 + 单 IP 每日上限，见下方常量）。本地调试
* 不绑 KV 时自动跳过限流；生产环境不绑定 = 没有这两道保险，不要漏。
*
* CORS：现在允许 * 方便调试。上线稳定后建议收紧：把 ALLOW_ORIGIN 改成你的
* GitHub Pages 域名（如 "https://你的用户名.github.io"），防止别人盗用你的额度。
*/

const ALLOW_ORIGIN = "*"; // 上线后可收紧为你的 Pages 域名

const DASHSCOPE_URL =
"https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const DEFAULT_MODEL = "qwen3-vl-plus";
const MAX_IMAGE_BASE64_LEN = 2_500_000; // 约 2.5MB 字符（base64 后）
// 两道限流保险（计数存 KV 绑定 env.LIMITS，见文件头说明）：想调整松紧改这两个数字重新部署
const GLOBAL_DAILY_LIMIT = 100; // 全站每天最多分析 100 次（熔断，防刷爆百炼额度）
const IP_DAILY_LIMIT = 5; // 单个 IP 每天最多分析 5 次
const LIMIT_TTL_SECONDS = 172800; // 计数 key 保留 48 小时后自动过期清理
const SCENES = ["初次见面", "求职面试", "社交聚会", "线上头像"];
const DIMENSIONS = ["亲和力", "可信度", "专业度", "好感度", "接近感", "气场", "记忆点"];

function corsHeaders() {
return {
"Access-Control-Allow-Origin": ALLOW_ORIGIN,
"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
"Access-Control-Allow-Headers": "Content-Type",
"Access-Control-Max-Age": "86400",
};
}

function jsonResponse(obj, status) {
return new Response(JSON.stringify(obj), {
status: status || 200,
headers: { "Content-Type": "application/json; charset=utf-8",...corsHeaders()},
});
}

function buildPrompt(scene) {
return [
"你正在为「初见雷达」做第一印象分析。这是一款娱乐向测评产品，核心是给用户情绪价值：语气先肯定、先夸，再给具体又温和的微调建议，绝不刻薄、不打击人、不给人贴负面标签。",
"",
"本次场景：" + scene,
"",
"请只依据照片中的信息判断：面部表情、眼神状态、着装、仪态姿势、背景环境、光线与照片质感。",
"不要猜测照片里看不到的信息（职业、收入、性格本质、健康状况等），不要试图识别照片里的人是谁，不要提及任何真实人物名字。",
"",
"从 7 个维度各打 0-100 分（整数，一般落在 40-95，避免极端分数）：",
DIMENSIONS.join("、"),
"",
"同时给出：",
"1. headline：一句第一印象标题，有梗、抓人、适合截图分享，但不冒犯本人；",
"2. gapIndex：落差指数 0-100，表示「陌生人第一眼的印象」与「照片主角真实状态」之间可能的落差大小（比如看起来高冷其实好相处，落差就高）；",
"3. gapNote：一句话（30 字内）解释这个落差；",
"4. dimensions：7 个维度按上面给定的顺序，每个维度包含 score（分数）、read（一句话解读，先肯定，基于可见细节）、tip（一条具体可执行的小微调建议）；",
"5. overall：一段 60-100 字的总评，先肯定整体印象，再点出最值得放大的一点和最值得微调的一点；",
"6. shareLine：一句适合发朋友圈/小红书分享的文案（30-50 字），带一点自嘲或自信，末尾加 #初见雷达。",
"",
"只返回一个严格的 JSON 对象，不要输出任何其他文字、解释或 Markdown 代码块标记。JSON 结构：",
'{"headline":"...","gapIndex":0,"gapNote":"...","dimensions":[{"name":"亲和力","score":0,"read":"...","tip":"..."}],"overall":"...","shareLine":"..."}',
].join("\n");
}

/** 把上游模型返回的文本容错解析成对象：去掉 ```json 围栏、截取第一个 { 到最后一个} */
function tolerantParseJson(text) {
if (!text || typeof text!== "string") return null;
let t = text.trim();
t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
const start = t.indexOf("{");
const end = t.lastIndexOf("}");
if (start === -1 || end === -1 || end <= start) return null;
try {
return JSON.parse(t.slice(start, end + 1));
} catch (e) {
return null;
}
}

function clampScore(v) {
const n = Math.round(Number(v));
if (isNaN(n)) return null;
return Math.max(0, Math.min(100, n));
}

/** 校验并按固定顺序规整模型输出；不合格返回 null */
function normalizeReport(raw) {
if (!raw || typeof raw!== "object") return null;
const byName = {};
if (Array.isArray(raw.dimensions)) {
for (const d of raw.dimensions) {
if (d && d.name) byName[d.name] = d;
}
} else if (raw.dimensions && typeof raw.dimensions === "object") {
for (const name of Object.keys(raw.dimensions)) {
byName[name] = { name,...raw.dimensions[name]};
}
}
const dims = [];
for (const name of DIMENSIONS) {
const d = byName[name];
if (!d || clampScore(d.score) === null) return null;
dims.push({
name,
score: clampScore(d.score),
read: String(d.read || ""),
tip: String(d.tip || ""),
});
}
const gap = clampScore(raw.gapIndex!= null? raw.gapIndex: raw.gap_index);
return {
headline: String(raw.headline || "这是 AI 给你的第一印象"),
gapIndex: gap === null? 50: gap,
gapNote: String(raw.gapNote || raw.gap_note || ""),
dimensions: dims,
overall: String(raw.overall || ""),
shareLine: String(raw.shareLine || raw.share_line || ""),
};
}

async function callDashScope(apiKey, model, dataUri, scene, useJsonFormat) {
const body = {
model,
messages: [
{
role: "system",
content:
"你是「初见雷达」的第一印象分析师。你只依据照片可见信息做娱乐向分析，语气先肯定后建议，只返回严格 JSON。",
},
{
role: "user",
content: [
{ type: "text", text: buildPrompt(scene)},
{ type: "image_url", image_url: { url: dataUri}},
],
},
],
temperature: 0.8,
};
// DashScope 兼容模式支持 response_format；个别模型不支持时下面会去掉它重试一次
if (useJsonFormat) body.response_format = { type: "json_object"};

const resp = await fetch(DASHSCOPE_URL, {
method: "POST",
headers: {
"Content-Type": "application/json",
Authorization: "Bearer " + apiKey,
},
body: JSON.stringify(body),
});
return resp;
}

/** 今天的日期字符串（Asia/Shanghai 时区，YYYY-MM-DD）。用 Intl 取上海时间，不能用 UTC 日期，否则北京时间凌晨会被算到前一天 */
function shanghaiToday() {
const parts = new Intl.DateTimeFormat("en-CA", {
timeZone: "Asia/Shanghai",
year: "numeric",
month: "2-digit",
day: "2-digit",
}).formatToParts(new Date());
const p = {};
for (const part of parts) p[part.type] = part.value;
return p.year + "-" + p.month + "-" + p.day;
}

/** 访客 IP：优先 Cloudflare 注入的 CF-Connecting-IP，其次 X-Forwarded-For 第一段，都没有用 "unknown" */
function clientIp(request) {
const cf = request.headers.get("CF-Connecting-IP");
if (cf) return cf.trim();
const xff = request.headers.get("X-Forwarded-For");
if (xff) return xff.split(",")[0].trim();
return "unknown";
}

/** KV 计数容错解析：读不到/不是数字一律当 0 */
function parseCount(v) {
const n = parseInt(v, 10);
return isNaN(n) ? 0 : n;
}

/**
 * 两道限流保险：全站每日上限 + 单 IP 每日上限，计数存 KV（env.LIMITS）。
 * 没绑 KV（本地调试）时跳过限流直接放行；生产环境必须绑定，见文件头说明。
 * 返回 null = 放行；返回 Response = 已触发限流，直接把它返回给前端。
 * 通过检查后先把两个计数各 +1 再放行：先计数后调用是为了防刷爆额度，
 * 代价是上游调用失败也会计入次数——这是已知取舍（失败重试会消耗名额）。
 */
async function checkRateLimits(request, env) {
if (!env.LIMITS) return null;
const date = shanghaiToday();
const globalKey = "g:" + date;
const ipKey = "ip:" + date + ":" + clientIp(request);
const globalCount = parseCount(await env.LIMITS.get(globalKey));
if (globalCount >= GLOBAL_DAILY_LIMIT) {
return jsonResponse(
{ error: "daily_limit", message: "今天的分析名额已经用完了，明天再来试试吧。" },
429
);
}
const ipCount = parseCount(await env.LIMITS.get(ipKey));
if (ipCount >= IP_DAILY_LIMIT) {
return jsonResponse(
{ error: "ip_limit", message: "你今天已经测了 5 次了，明天再来吧。" },
429
);
}
await env.LIMITS.put(globalKey, String(globalCount + 1), { expirationTtl: LIMIT_TTL_SECONDS });
await env.LIMITS.put(ipKey, String(ipCount + 1), { expirationTtl: LIMIT_TTL_SECONDS });
return null;
}

async function handleAnalyze(request, env) {
if (!env.DASHSCOPE_API_KEY) {
return jsonResponse(
{
error: "not_configured",
message:
"分析服务还没配置好：Worker 里还没有设置 DASHSCOPE_API_KEY（百炼 API Key）。请按 README 到 Cloudflare 后台添加这个密钥变量。",
},
503
);
}

let payload;
try {
payload = await request.json();
} catch (e) {
return jsonResponse(
{ error: "bad_json", message: "请求格式不对：需要 JSON 格式的请求体。"},
400
);
}

const imageBase64 = payload && payload.image_base64;
if (!imageBase64 || typeof imageBase64!== "string" || imageBase64.length < 100) {
return jsonResponse(
{ error: "image_required", message: "没有收到有效的照片数据，请重新上传照片再试。"},
400
);
}
if (imageBase64.length > MAX_IMAGE_BASE64_LEN) {
return jsonResponse(
{ error: "image_too_large", message: "照片太大了，请换一张小一点的照片，或等页面压缩后再试。"},
413
);
}

// 请求与照片校验都过了、真正调用上游之前，先过两道限流保险（触发限流直接返回 429）
const limitResponse = await checkRateLimits(request, env);
if (limitResponse) return limitResponse;

let scene = payload && payload.scene;
if (!SCENES.includes(scene)) scene = "初次见面";

const dataUri = imageBase64.startsWith("data:")
? imageBase64
: "data:image/jpeg;base64," + imageBase64;
const model = env.MODEL || DEFAULT_MODEL;

let upstream;
try {
upstream = await callDashScope(env.DASHSCOPE_API_KEY, model, dataUri, scene, true);
if (upstream.status === 400) {
// 可能是当前模型不支持 response_format，去掉后重试一次
const text = await upstream.text();
if (/response_format/i.test(text)) {
upstream = await callDashScope(env.DASHSCOPE_API_KEY, model, dataUri, scene, false);
} else {
return jsonResponse(
{
error: "upstream_failed",
message: "AI 分析服务拒绝了这次请求（400），请稍后再试；如果反复出现，可能是照片格式不支持，换一张 JPG 试试。",
},
502
);
}
}
} catch (e) {
return jsonResponse(
{ error: "upstream_unreachable", message: "连不上 AI 分析服务，请稍后再试一次。"},
502
);
}

if (!upstream.ok) {
return jsonResponse(
{
error: "upstream_failed",
message:
"AI 分析服务暂时不可用（上游返回 " + upstream.status + "），请稍后再试一次。如果反复失败，请管理员检查百炼 API Key 和模型开通状态。",
},
502
);
}

let data;
try {
data = await upstream.json();
} catch (e) {
return jsonResponse(
{ error: "upstream_bad_response", message: "AI 返回的内容看不懂，请再试一次。"},
502
);
}

const content =
data &&
data.choices &&
data.choices[0] &&
data.choices[0].message &&
data.choices[0].message.content;
const parsed = tolerantParseJson(typeof content === "string"? content: "");
const report = parsed && normalizeReport(parsed);
if (!report) {
return jsonResponse(
{ error: "upstream_bad_response", message: "AI 返回的报告不完整，请再点一次开始分析重试。"},
502
);
}

report.scene = scene;
return jsonResponse(report, 200);
}

export default {
async fetch(request, env) {
const url = new URL(request.url);

if (request.method === "OPTIONS") {
return new Response(null, { status: 204, headers: corsHeaders()});
}

if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
return new Response("初见雷达 Worker 正常运行。POST /analyze 开始分析。\n", {
status: 200,
headers: { "Content-Type": "text/plain; charset=utf-8",...corsHeaders()},
});
}

if (request.method === "POST" && url.pathname === "/analyze") {
return handleAnalyze(request, env);
}

return jsonResponse({ error: "not_found", message: "没有这个接口。"}, 404);
},
};
