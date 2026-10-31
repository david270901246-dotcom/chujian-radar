# 初见雷达 · 测测你给人的第一印象

上传一张正面照，选一个场景（初次见面 / 求职面试 / 社交聚会 / 线上头像），AI 从
亲和力、可信度、专业度、好感度、接近感、气场、记忆点 7 个维度分析陌生人对你的
第一印象，给出落差指数、雷达图、逐项解读与微调建议，和一句可复制的分享文案。

## 架构（一句话）

**GitHub Pages 放前端页面（index.html）+ Cloudflare Worker 在后端藏住 API Key 并转发请求 + 阿里云百炼通义千问 VL 模型负责看图分析。**

为什么要中间这一层 Worker：GitHub Pages 只能放公开的静态文件，API Key 写进网页等于全网公开，谁都能拿去盗刷额度。Key 只放在 Worker 的密钥变量里，前端永远看不到。

```
手机浏览器 ──POST 照片──▶ Cloudflare Worker ──带 Key 调用──▶ 百炼 DashScope（qwen3-vl-plus）
     ▲                          │
     └──────── 报告 JSON ────────┘
```

## 文件说明

| 文件 | 作用 |
|---|---|
| `index.html` | 前端单文件页面，无外部依赖。照片在浏览器端压缩后才发送；测评记录只存访客本机浏览器的 localStorage |
| `worker/worker.js` | Cloudflare Worker：`GET /` 健康检查，`POST /analyze` 分析接口 |
| `worker/wrangler.toml` | Worker 配置（名字、兼容日期、可选模型名） |

## 部署顺序（务必按这个顺序）

### 第 0 步：先去百炼拿 API Key

1. 打开阿里云百炼控制台：<https://bailian.console.aliyun.com/>，用阿里云账号登录（没有就先注册、完成实名认证）。
2. 按控制台提示开通「模型服务」（首次进入会引导开通，有免费额度）。
3. 在「模型广场」里找到并确认 **通义千问 VL（qwen3-vl-plus）** 已开通可用；想用更新的模型也可以，把模型名记下来，第 2 步填到 Worker 的 `MODEL` 变量里。
4. 创建 API Key：进入 API-KEY 管理页 <https://bailian.console.aliyun.com/?apiKey=1#/api-key>（也可以从控制台右上角菜单进「API Key」），点「创建 API Key」，选好归属业务空间后确认，把生成的 Key 复制保存好（格式一般是 `sk-` 开头）。
   - 参考官方文档：《如何获取 API Key》<https://help.aliyun.com/zh/model-studio/get-api-key>

### 第 1 步：部署 Worker

命令行方式（推荐）：

```bash
cd worker
npx wrangler login        # 浏览器里登录 Cloudflare 授权一次
npx wrangler secret put DASHSCOPE_API_KEY   # 粘贴第 0 步拿到的百炼 Key
npx wrangler deploy
```

也可以全程在 Cloudflare 后台网页操作：Workers & Pages → Create → 上传 `worker.js` 建好 Worker 后，在 Settings → Variables and Secrets 里添加 Secret：`DASHSCOPE_API_KEY`。

部署成功会得到一个地址，长这样：

```
https://chujian-radar.你的账号名.workers.dev
```

先验证一下：浏览器打开这个地址，应看到「初见雷达 Worker 正常运行」。打不开或报错，先别往下走，修好这一步。

### 第 2 步：把 Worker 地址填进前端

打开 `index.html`，找到顶部这一行（有醒目的 ★ 注释）：

```js
const WORKER_URL = "https://chujian-radar.<待填>.workers.dev/analyze";
```

把 `<待填>` 换成你自己的账号名，即改成第 1 步的真实地址（注意末尾的 `/analyze` 要保留），例如：

```js
const WORKER_URL = "https://chujian-radar.zhangsan.workers.dev/analyze";
```

### 第 3 步：推 GitHub 并开启 Pages

1. 在 GitHub 新建一个公开仓库，名字建议就叫 `chujian-radar`。
2. 把本文件夹的内容（`index.html`、`README.md`、`worker/`）推上去。
3. 仓库里进 Settings → Pages → Build and deployment → Source 选「Deploy from a branch」，Branch 选 `main`、目录选 `/ (root)`，保存。
4. 等一两分钟，Pages 会给出网址，一般是：

```
https://你的用户名.github.io/chujian-radar/
```

5. 用手机打开这个网址，传一张自己的正面照实测一次：能出报告就全线通了。这个网址就是可以发给别人、挂到店铺自动发货里的成品链接。

## 费用说明

- **Cloudflare Workers**：免费版每天 10 万次请求，这个量级足够用。
- **GitHub Pages**：免费。
- **阿里云百炼**：新开通一般赠送免费试用额度（通义千问 VL 系列有各自的免费额度，以百炼控制台「模型广场 / 用量」页显示为准）。免费额度用完后按量付费，按输入+输出 token 计价，分析一张照片的成本是分角级别（具体单价以百炼官方价格页为准）。建议在百炼控制台设置用量预警/额度上限，避免异常调用刷爆账单。

## 防白嫖两道保险（限流）

公开链接谁拿到都能打开页面，页面本身拦不住人；真正的关卡在 Worker 调百炼之前。Worker 内置两道每日限流（按北京时间 Asia/Shanghai 自然日计算）：

| 保险 | 上限 | 触发后返回 |
|---|---|---|
| 全站每日熔断 | 全站每天最多分析 **100 次** | 429「今天的分析名额已经用完了，明天再来试试吧。」 |
| 单 IP 每日上限 | 同一 IP 每天最多分析 **5 次** | 429「你今天已经测了 5 次了，明天再来吧。」 |

实现要点：

- 计数存在 Cloudflare KV（绑定名 `LIMITS`），key 是 `g:<日期>` 和 `ip:<日期>:<IP>`，48 小时自动过期。通过检查后先计数再调模型，所以上游失败也占名额——这是防刷爆额度的已知取舍。
- **部署时必须绑定 KV**：在 Cloudflare 后台建一个 KV 命名空间，在 Worker 的 Settings 里绑定为 `LIMITS`（或按 `worker/wrangler.toml` 末尾的注释示例填 id）。不绑定的话 Worker 会跳过限流（本地调试方便），等于两道保险不存在，上线前务必确认绑好。
- **调整数字**：改 `worker/worker.js` 顶部的 `GLOBAL_DAILY_LIMIT` / `IP_DAILY_LIMIT` 两个常量，重新部署 Worker 即可。
- **定位说清**：这两道保险只负责封顶止损——保证最坏情况下一天最多被刷 100 次、账单可控；它们不替代兑换码。真要做到「不付款不能用」，还需要一人一码的兑换码校验（付费买家凭码分析），两道限流是兑换码之外的兜底，而不是它的平替。

## 安全提醒（重要）

- **API Key 只能填 Cloudflare 的密钥变量（Secret）**，绝不要写进 `index.html`、`worker.js`、`wrangler.toml` 或任何会提交到 GitHub 的文件。一旦提交过，哪怕后来删掉，Git 历史里还在，必须立刻去百炼把那个 Key 删除重建。
- Worker 代码里 CORS 现在是允许 `*`（方便调试）。上线稳定后建议收紧：把 `worker.js` 里的 `ALLOW_ORIGIN` 改成你的 Pages 域名（如 `"https://你的用户名.github.io"`）再重新部署，防止别人拿你的 Worker 地址盗用额度。
- Worker 已做请求体大小校验（照片 base64 上限约 2.5MB 字符），前端也会先把照片最长边压到 1024px 再发送，双保险控成本。
- 访客照片只经过 Worker 转发给百炼做分析，本站不设任何服务器存储；访客的测评记录和缩略图只存在他们自己浏览器的 localStorage 里。

## 常见问题

- **页面提示「分析服务还没配置好」**：`index.html` 的 `WORKER_URL` 还是占位地址，或 Worker 里还没填 `DASHSCOPE_API_KEY`。按部署顺序第 1、2 步检查。
- **分析时报 502**：百炼那边的问题——Key 不对/欠费/模型没开通，或照片格式不支持（换一张 JPG 正面照试试）。
- **想换模型**：改 `worker/wrangler.toml` 里 `[vars]` 的 `MODEL`（或 Cloudflare 后台的同名普通变量），重新 `npx wrangler deploy`。
