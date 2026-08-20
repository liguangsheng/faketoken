# LLM API 中转站

Go + React + Postgres 实现的多用户 LLM API 网关。核心目标是**尽可能透传**：除了凭证、目标地址和（可选的）模型名，请求与响应的每一个字节都原样转发。

## 功能

| 能力 | 说明 |
| --- | --- |
| 多协议 | OpenAI 兼容 / Anthropic / Gemini 三种上游方言，各自按原生路径透传，不做格式互转 |
| 多用户 | 注册登录、JWT 会话、用户分组、管理员角色 |
| 密钥分组 | 每个 API 密钥可单独指定分组；分组是否开放给普通用户由管理员逐个决定 |
| 渠道管理 | 多渠道、启用/禁用、上游密钥 AES-256-GCM 加密存储、独立超时与 HTTP 代理 |
| 优先级路由 | 优先级高的渠道优先命中；同优先级内按权重随机；失败自动切换下一个渠道 |
| 熔断 | 连续失败的渠道进入指数退避冷却，成功后自动恢复 |
| 模型拉取 | 一键从上游 `/models` 拉取模型清单，勾选后写入渠道并即时生效 |
| 模型映射 | `客户端模型 = 上游模型`，转发时只改写 `model` 字段（或 Gemini 的 URL 段） |
| 前缀路由 | 渠道可配模型前缀（`gpt-4`）覆盖整个系列；精确匹配优先，前缀只在无人精确命中时兜底 |
| 渠道运维 | 按状态/类型/分组/模型筛选、批量启停删除、批量测试、复制渠道、查询上游余额 |
| 快速导入 | 粘贴服务商给的地址与密钥（或一段 curl），自动识别协议类型、拉取模型并预填表单 |
| 兑换码 | 管理员批量生成、用户自助兑换充值；单个兑换码只能使用一次 |
| 全局设置 | 开放注册、注册赠送额度、默认每页条数、完整日志保留条数与正文上限、渠道导入默认值，改完即时生效 |
| 计费 | 按 token 用量计费（输入/输出/缓存分别定价），分组倍率 × 渠道倍率，余额与密钥限额双重管控 |
| 价格表 | 内置 models.dev 快照（18 家厂商 260 个模型），支持一键导入与最长前缀匹配 |
| 可观测 | 每次调用记录渠道、重试次数、token 数、费用、耗时、首字节延迟；调用日志由服务端 SSE 实时推送 |

## 快速开始

```bash
cp .env.example .env
# 必填两个密钥
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -hex 32)|" .env

docker compose up -d --build
```

打开 http://localhost:3200 ，用 `.env` 里的 `INIT_ADMIN_USER` / `INIT_ADMIN_PASS`（默认 `admin` / `admin123`）登录，**第一件事是改密码**。

想换端口只改 `.env` 里的 `SERVER_PORT`（宿主机映射端口），例如 `SERVER_PORT=8080` 后 `docker compose up -d` 即可，容器内部始终监听 3200。

### 本地开发

```bash
make db-up        # 只起 Postgres（映射到宿主机 5433）
make web          # 构建前端到 web/dist
make run          # 编译并运行后端，读取 .env

make dev          # 另开终端跑 Vite，热更新，自动代理 /api 与 /v1 到 :3200
```

### 测试

```bash
make test              # 单元测试

# 端到端集成测试。用的是独立的一次性 Postgres（另一个端口 + tmpfs 存储，
# 因为每次开场都会 DROP SCHEMA），跑完自动删掉容器，失败和 Ctrl-C 也一样。
make test-integration

# 想留着实例连着跑几轮，省掉每次约 2 秒的启动：
make test-db           # 先手动起来，之后 make test-integration 不会再删它
make test-db-down      # 用完手动下掉
```

## 客户端接入

创建 API 密钥后，把中转站地址填给任意客户端即可：

```bash
# OpenAI 兼容
curl http://localhost:3200/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}],"stream":true}'

# Anthropic 原生
curl http://localhost:3200/v1/messages \
  -H "x-api-key: sk-xxx" -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4","max_tokens":64,"messages":[...]}'

# Gemini 原生（密钥也可放在 ?key= 里）
curl "http://localhost:3200/v1beta/models/gemini-2.5-pro:generateContent" \
  -H "x-goog-api-key: sk-xxx" -d '{"contents":[...]}'
```

`GET /v1/models` 返回的是**当前用户分组实际可用**的模型，而不是某个上游的原始清单。

### 完整请求日志

控制台「全局日志」中点开任意一行，可以看到该次调用的完整请求与响应正文。

只保留最近若干次调用（默认 1000 次），超出的旧记录自动删除；条数在「全局设置 → 完整日志」调整，设为 0 则不记录并清空已有正文。单条正文的字节上限由「正文捕获」控制，默认 4 MiB，足以容纳百万 token 上下文。

保存前会脱敏：认证头、Cookie、API Key、密码和 Token 等常见凭证替换为 `[REDACTED]`，JSON 与 SSE 流逐字段处理，二进制正文不落库只记类型和大小。

**正文仅管理员可见**，普通用户的调用日志只有元数据，不含请求内容。

控制台的关键字搜索**不覆盖正文**（只搜 ID、用户、密钥、模型、渠道、IP、错误这些短字段）。要在正文里检索，用命令行导出：

```bash
make search KEYWORD=海鸥                      # 默认搜请求+响应，导出到 .search/
./scripts/search-logs.sh --help              # 全部选项

./scripts/search-logs.sh -f req 海鸥          # 只搜请求正文
./scripts/search-logs.sh -i -E 'err(or)?' -n 50   # 忽略大小写 + 正则 + 限量
./scripts/search-logs.sh --no-bodies 海鸥     # 只要元数据和上下文片段，文件很小
./scripts/search-logs.sh -o - 海鸥 | jq .     # 直接接管道，摘要走 stderr
```

命中概览打到终端，完整记录按 JSONL 落到 `.search/`（已 gitignore，权限 0600）。**只能搜到仍在保留窗口内的正文**，因此「没搜到」的准确含义是「最近 N 次调用里没有」。导出文件里是别人的原始 prompt，当数据库本身对待。

## 实时日志

调用日志不再轮询，改由 `GET /api/logs/stream`（管理员为 `/api/admin/logs/stream`）以 SSE 推送。日志写入 Postgres**提交之后**才广播，因此实时看到的和刷新后看到的一致。

几个刻意的取舍：

- **不用 `EventSource`**：它无法携带请求头，只能把会话令牌放进查询串，那会把凭证写进沿途每一层的访问日志。前端改用 `fetch` + `ReadableStream` 读取同样的协议，凭证仍走 `Authorization` 头。
- **推送不阻塞转发**：广播是进程内的非阻塞发送，某个控制台读得慢只会丢事件并被告知丢了多少，不会拖住请求结算。日志行已经落库，这里只是通知。
- **只有第一页实时追加**：列表按时间倒序，在第二页插入新行会让正在阅读的内容不断位移。非首页时推送暂停，改为提示「有 N 条新记录」，点击回到首页一次性合并。
- **选择时间范围时自动暂停**：时间范围限定的是历史，实时流永远是「现在」，两者混在一起只会得到一个自相矛盾的列表。

## 兑换码

管理员在「兑换码」页批量生成（可设面额、数量、备注、有效期、活动分组），用户在「个人设置 → 兑换码充值」输入即可到账。

两种重复入账都由数据库拦住，而不是先查后写：

- **同一个码并发提交**：`UPDATE ... WHERE status = 未使用` 本身就是锁，只有一次能匹配到行。
- **同一分组的多个码**：`(分组, 使用者)` 上的部分唯一索引拒绝第二次认领。填了分组的兑换码，每个用户只能用一个；留空则不限制。

## 透传边界

转发时只做这些改动，其余全部原样通过：

**请求方向**
- 替换凭证：`Authorization` / `x-api-key` / `x-goog-api-key` / `?key=` 换成渠道自己的密钥
- 剔除 `Cookie`、`X-Forwarded-*` 等会泄露调用方身份的头
- 剔除逐跳头（`Connection`、`Transfer-Encoding` 等）
- 剔除 `Accept-Encoding`，交给 Go transport 协商，从而能读到明文用量
- 命中模型映射时改写 `model` 字段——用字节切片替换，不重新序列化 JSON，因此字段顺序、空白、大整数精度全部保持原样

**响应方向**
- 状态码、响应头、响应体全部原样返回，包括上游返回的 4xx 错误详情
- SSE 逐块 flush，不做缓冲；用量统计旁路读取，不影响流本身

## 路由与计费

**分组从哪来**：优先取 API 密钥自身的分组，未指定时跟随账号分组（这也是所有历史密钥的行为）。路由和计费**必须用同一个分组**，否则会出现「按 A 组挑渠道、按 B 组算钱」。

分组同时决定可用渠道和计费倍率，因此普通用户能选哪些分组由管理员在「分组倍率」页逐个开放，默认关闭。这个限制在服务端强制：只在前端收窄选项是没用的，直接调接口照样能指定任意分组。

**渠道选择**：`abilities` 表把 `(分组, 模型) -> 渠道` 展平成一次索引查询。候选按优先级降序分层，层内按权重不放回随机抽样——权重 9:1 的两个渠道，约 90% 的请求会先打到前者，同时保证重试能遍历整层。

**快速导入**：把服务商发来的整段文字贴进「渠道管理 → 快速导入」即可。服务端负责解析（`internal/api/channel_import.go`），从中挑出接口地址与密钥：URL 按是否含 `/v1`、`api` 与 https 打分取最优，并**保留路径前缀**——聚合站常部署在 `https://host/openai/v1`，只取域名会指向不存在的地址；`/chat/completions` 这类请求路径会被剥掉，所以直接贴 curl 也能用。密钥优先认显式标注（`API Key:`、`密钥：`），其次才按 `sk-`、`AIza` 这类形状匹配，因此不遵循任何命名习惯的密钥也能识别。协议类型由密钥前缀和域名推断。导入只做预览：地址、密钥、模型都会回填到普通表单等待确认，**在保存前不写库**；若已存在同名渠道，会提示并转为覆盖编辑该渠道，而不是新建一条重名记录。

**前缀兜底**：只有当没有任何渠道精确列出该模型时，才查 `ability_prefixes`。精确配置永远优先，因此新增一个 `gpt-4` 前缀不会抢走已有的 `gpt-4o` 路由。前缀渠道不出现在 `GET /v1/models` 里——前缀无法枚举；这类渠道建议单独配置「测试模型」，否则探活没有可用的模型名。

**重试**：默认最多 3 次。`401/403/404/408/429/5xx` 和网络错误会换下一个渠道；`400/422` 直接透传给调用方。响应头一旦发出就不再重试，避免半截响应被污染。每次换渠道之间按 `RETRY_BACKOFF` 递增停顿（上限 2 秒，客户端断开即中止）；上游返回 `Retry-After` 时，该渠道的熔断冷却直接采用它给的时间，而不是本地的指数退避。

**计费**：金额统一用 int64 micro-USD（1e-6 美元）存储，价格表用「美元 / 100 万 token」，于是

```
费用(micro-USD) = token 数 × 单价 × 分组倍率 × 渠道倍率
```

模型价格支持最长前缀匹配：配了 `gpt-4o` 之后，`gpt-4o-2024-11-20` 自动沿用，不必逐个快照维护。

**内置价格表**：编译进二进制的一份 [models.dev](https://models.dev) 快照，覆盖 OpenAI / Anthropic / Google / xAI / DeepSeek / Moonshot / Z.AI / 通义 / MiniMax / Mistral 等 18 家一方厂商共 260 个模型（单位同样是「美元 / 100 万 token」）。空库首次启动会自动灌入；已有数据的实例可在控制台「模型价格 → 导入内置价格」手动导入，分两种模式：

| 模式 | 行为 |
| --- | --- |
| 只补充缺失 | 只写入价格表里没有的模型，你手工调过的单价一律保留 |
| 覆盖同名 | 用快照覆盖同名模型，快照里没有的条目不动 |

快照过期后重新拉取：

```bash
make prices        # go run ./cmd/genprices && go test ./internal/billing
```

聚合平台（OpenRouter 等）用 `openai/gpt-4o` 这类带命名空间的模型名转发同一批模型，会让表膨胀数倍，因此不收进内置快照，需要的话在控制台自行添加。

**未配价的模型**：用量只有在上游应答之后才知道，因此放行一个没有价格的模型，等同于白送上游额度——它不扣费，用户余额、请求计数、密钥用量都不会变化。默认策略是**拒绝**（`BILLING_UNPRICED_POLICY=reject`）：请求在转发前就被挡下，返回 `403 model_not_priced`，不消耗上游额度。另外两种策略：

| 策略 | 行为 |
| --- | --- |
| `reject`（默认） | 拒绝请求，不转发。新增模型必须先配价才能用 |
| `fallback` | 按 `BILLING_FALLBACK_*` 兜底价计费，服务不中断。兜底价至少一项非 0，否则启动即报错 |
| `free` | 放行且不扣费，仅记录用量。会打 warn 日志 |

策略与兜底价可在控制台「模型价格 → 计费策略」实时修改（存 `options` 表，覆盖环境变量，无需重启）。同一页面会列出「渠道已提供但没有价格」的模型，用于巡检。

排查历史漏计费：

```sql
SELECT model, count(*), sum(total_tokens)
FROM request_logs
WHERE cost = 0 AND status_code < 400 AND total_tokens > 0
GROUP BY model ORDER BY 3 DESC;
```

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `JWT_SECRET` | 必填 | 会话签名密钥 |
| `ENCRYPTION_KEY` | 必填 | 渠道密钥加密主密钥，**更换会导致已存密钥无法解密** |
| `DATABASE_URL` | localhost:5433 | Postgres 连接串 |
| `LISTEN` | `:3200` | 进程监听地址（容器内） |
| `SERVER_PORT` | `3200` | docker-compose 发布到宿主机的端口 |
| `POSTGRES_PORT` | `5433` | Postgres 发布到宿主机的端口 |
| `RELAY_TIMEOUT` | `10m` | 单次上游请求总超时 |
| `STREAM_IDLE_TIMEOUT` | `120s` | 流式响应静默多久判定为卡死 |
| `MAX_RETRIES` | `3` | 单次请求最多尝试的渠道数 |
| `RETRY_BACKOFF` | `200ms` | 换渠道重试前的停顿基数，按尝试次数递增，上限 2 秒 |
| `ALLOW_REGISTER` | `true` | 是否开放注册，可在「全局设置」中覆盖（无需重启） |
| `INIT_QUOTA_MICRO_USD` | `1000000` | 新用户初始余额（$1），可在「全局设置」中覆盖 |
| `BILLING_UNPRICED_POLICY` | `reject` | 模型未配价时：`reject` / `fallback` / `free` |
| `BILLING_FALLBACK_INPUT_PRICE` | `0` | 兜底输入价（美元 / 1M token），仅 `fallback` 使用 |
| `BILLING_FALLBACK_OUTPUT_PRICE` | `0` | 兜底输出价（美元 / 1M token） |
| `BILLING_FALLBACK_CACHED_PRICE` | `0` | 兜底缓存输入价，留 0 表示与输入同价 |
| `BILLING_FALLBACK_PER_REQUEST_PRICE` | `0` | 兜底按次计费（美元 / 次） |
| `WEB_DIR` | `web/dist` | 前端静态文件目录 |

## 安全说明

- 用户密码用 bcrypt 存储，不可逆
- API 密钥用 sha256 索引（转发热路径只比对哈希，不做解密），同时用 AES-256-GCM 加密留存一份，便于在密钥页重新复制。这是一个取舍：数据库单独泄露拿不到可用密钥，但泄露叠加 `ENCRYPTION_KEY` 就可以——与渠道上游密钥同样的假设。不想要这一层的话，删掉 `tokens.key_enc` 即可退回只存哈希
- 取回密钥是独立接口 `GET /api/tokens/{id}/key`，只有密钥所有者和管理员可调用；列表接口永远不返回明文
- 渠道上游密钥用 AES-256-GCM 加密落库，API 返回时脱敏为 `sk-abc...wxyz`
- 编辑渠道时密钥留空表示保持不变，密钥不会回传到浏览器

## 目录结构

```
cmd/server            入口与启动引导
cmd/genprices         从 models.dev 生成内置价格表（make prices）
internal/config       环境变量配置
internal/db           连接池与内嵌 SQL 迁移
internal/model        领域模型
internal/store        Postgres 仓储层
internal/auth         密码、JWT、API Key、AES 加密
internal/provider     上游方言适配（鉴权位置、模型清单、用量解析）
internal/relay        转发核心：选路、重试、熔断、流式、用量嗅探
internal/billing      价格表与费用计算
internal/api          HTTP 路由与管理接口
web/                  React + TypeScript + antd 控制台
scripts/              运维脚本：夜间备份、集成测试实例、正文检索
```
