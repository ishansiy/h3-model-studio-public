# 模型工作室

当前版本为图像与视频的多模型工作台，采用B方案深色界面。视频默认H3，图像默认Z-Image-Turbo。

[多模型改造与运行说明](docs/多模型改造说明.md)

# H3 影像工作室 · Render / Node.js 版

这是独立的普通 Next.js 项目，不依赖 GPT 登录、Sites、Cloudflare Workers、D1 或 R2 服务。原站点保持原样；这个目录可以单独放进 GitHub 仓库，再部署到 Render。

限制来自原 Sites 托管运行环境无法直接使用普通代理，并非 GPT 模型。Node.js 版直接连接 HTTP/HTTPS 或 SOCKS5 代理，不需要额外 HTTPS 转发服务。计算仍由 Kaggle GPU 执行；迁移网站不会直接缩短模型采样时间。

## Render 部署

1. 将本目录作为 Git 仓库的部署根目录，包含 `render.yaml`、锁文件和 `lib/db/migrations/`。密钥与数据库备份应存放在仓库外。
2. 准备一个长期保留的 PostgreSQL 数据库。使用 Render Postgres 时，Web 服务和数据库选同一个地区，`DATABASE_URL` 填数据库的内部连接地址。使用外部 PostgreSQL 时，按数据库提供方要求配置 TLS，并使用直连地址运行迁移。[Render 数据库连接说明](https://render.com/docs/postgresql-creating-connecting)
3. 通过 `render.yaml` 新建 Blueprint，或手动创建 Node Web Service。配置 Node 24、构建命令 `npm ci --include=dev && npm run build`、启动命令 `npm start` 和健康检查 `/api/health`。Blueprint 只创建 Web 服务，数据库计划由你选择。
4. 在 Render 的 Environment 中填写 `DATABASE_URL`、`SITE_PASSWORD` 和 `H3_MASTER_KEY`。全新站点用至少 32 字符的随机主密钥。迁移旧站时沿用其 `H3_MASTER_KEY` 和 `BOOTSTRAP_OWNER_ID`。旧站如果配置了独立的 `KAGGLE_CIPHER_KEY`，也要沿用该值。
5. 每次启动先执行 Drizzle 迁移，成功后才启动 Web 服务。`/api/health` 会实际查询数据库。Render 缺少数据库连接配置时会拒绝启动。

**数据持久化**。账户凭证、任务、队列、专用 API 密钥和作品文件都存入 PostgreSQL。视频和图片字节存放在 `h3_objects` 表，跟随数据库备份。Render 重新部署或重启 Web 服务时，继续使用同一数据库和主密钥即可保留数据。免费 Render Postgres 的有效期为 30 天、容量上限为 1 GB。长期使用请选持久数据库方案。 [Render 免费服务限制](https://render.com/docs/free) · [Render Postgres 备份](https://render.com/docs/postgresql-backups)

免费 Web 服务空闲约 15 分钟后休眠，冷启动会延迟浏览和回调。Kaggle 计算额度与 Render 服务计划分别管理。自定义域名可用 `PUBLIC_BASE_URL`，默认使用 Render 提供的 `RENDER_EXTERNAL_URL` 作为队列回调地址。

### 迁移现有 SQLite 数据到 Render

如果来源已经使用 PostgreSQL，保留原库的连接地址和主密钥即可原地应用版本化迁移。从 SQLite 迁移时，执行以下步骤。

1. 等待来源的 GPU 任务和会话结束，迁移期间暂停来源站点接收新任务。先在来源主机用 SQLite 的在线备份命令生成完整快照，避免漏掉 WAL 里的更新。

   ```bash
   sqlite3 /path/to/h3.db ".backup /secure/path/h3-snapshot.db"
   ```

2. 在能访问目标 PostgreSQL 的受信环境中按第 4 步配置密钥和工作室身份，并将 `DATABASE_URL` 指向空的目标库。首次打开 Render 工作室前先完成导入。

   ```bash
   npm run db:import-sqlite -- /secure/path/h3-snapshot.db
   ```

3. 导入读取原快照，原始 ID、账户密文、历史任务、API 密钥记录、设置和作品一起写入目标。作品会核对 SHA-256。若目标已有数据、来源还有活动任务、密钥不匹配或导入出错，导入会停止，数据写入会整体回滚。
4. Render 连接目标库后，用原密码验证登录、作品下载和账号显示。保留原数据库快照和主密钥备份。

### ORM 维护

PostgreSQL 表和索引定义在 `lib/db/schema.ts`，版本化 SQL 放在 `lib/db/migrations/`。修改结构后运行 `npm run db:generate`，审阅生成的 SQL 并提交迁移和快照。需要单独执行结构迁移时，配置 `DATABASE_URL` 后运行 `npm run db:migrate`。

## 每个账户的普通代理

在“计算账户”展开对应卡片的 **高级选项 · 账户代理**，开启后填写并测试、保存。也可在“添加账户”的高级选项里填写代理，让第一次账户验证就走该代理。

支持以下格式：

```text
http://主机:端口
http://用户名:密码@主机:端口
https://用户名:密码@主机:端口
socks5://用户名:密码@主机:端口
socks5h://用户名:密码@主机:端口
```

认证含 `@`、`:`、`#` 等特殊字符时需 URL 编码。`127.0.0.1` / `localhost` 指 Render 容器自身，不是你的电脑；要填写 Render 能访问的代理地址和端口。

- 保存前验证 Kaggle Token 身份并通过相同代理查询出口 IP；测试失败保留原设置。原始地址与密码加密保存、API不回显。地址框留空表示沿用已有配置。
- 每个账户使用自己的连接器。代理故障时请求失败，**不会自动回退直连**；只有明确停用代理才恢复直连。
- 活动任务或 GPU 会话结束前禁止修改、测试或停用代理。
- 作用范围是**工作室 → Kaggle 的账户、额度和任务管理 API**。Kaggle Notebook 内模型下载、GPU 网络出口、视频存储流量不受此设置影响。
- 代理改变出口地址，不保证平台不封号，也不改变 Kaggle 的使用规则和额度。没有自动轮换账号、IP或绕过额度功能。
- SOCKS5 使用 Undici 自带实现；该上游接口仍标为实验性，项目已包含真实握手和认证的本地回归测试。用户自己的代理还需部署后测试连通性。

## 本地运行

要求 Node.js 24。复制 `.env.example` 为 `.env` 并填写自己的主密钥、访问密码。省略 `DATABASE_URL` 时使用 `data/h3.db`；本地需备份整个 `data` 目录和主密钥。

```bash
npm ci
npm test
npm run check
npm run build
npm start
```

默认 http://localhost:3000；开发可用 `npm run dev`。另提供 Dockerfile，适用于普通 Node 容器托管；容器同样必须配置持久数据库。Docker 镜像不包含真实密钥或数据库。

## 从原网站复制历史和成片

迁移前先确认原站点没有活动任务。原网站继续保留，不会被修改或删除。

在配置好**新数据库及同一组新站点环境变量**的终端执行：

```bash
npm run migrate:sites
```

交互输入原站点 HTTPS 地址和访问密码，密码隐藏输入，不作为命令参数、不写文件。脚本只读原站点，拒绝覆盖有账户或任务的目标库；复制终态历史与已完成的 MP4，不会创建 GPU 任务。

原站点接口最多返回最近100条任务；达到100条时脚本拒绝不完整迁移，需另外准备完整数据导出。账户 Token、代理密码和专用 API 密钥不会导出。复制后的账户暂时隐藏，重新接入同用户名的账户即可关联原历史；专用 API 密钥在新站点重新生成。迁移中断可能留下尚未关联的媒体对象，可修复问题后在空目标历史库重试。复制只做下载和SHA256检查，不重新声称已完成逐帧媒体质量验证。

## 保留功能和当前限制

保留密码访问、固定单人数据空间、创作/作品/计算账户/API接入独立页面、专用账户接入API、连续GPU任务队列、停止通道、历史预览和下载。最高档保留1024×768、最多4.46秒/107帧、原版最高50步；其他档位保持原有标记，没有新增GPU实测或自动降参。

数据库保存任务、账户密文和媒体对象（PostgreSQL BYTEA / 本地SQLite BLOB），不依赖临时磁盘。单文件上限100MB，上传阶段在服务内存中缓冲；大量或大体积视频会占用数据库容量，须监测数据库额度并备份。此版适合单人低并发使用，后续可接独立对象存储。

测试覆盖 SQLite 和 PostgreSQL 兼容环境的重启持久化、旧库结构升级、整库迁入、失败回滚、队列和作品下载。Render 实例的连通性在实际部署后通过健康检查验证。

## H3 可选混合精度加速

视频的「高级参数 → 计算方案」新增「混合精度加速」，请求参数为 `runtimeProfile: "fp16"`，目前仅开放原版模式。默认仍是 `standard` 原精度；历史任务复用也保留其原计算方案。模型、分辨率、帧数、采样步数及随机种子均不自动降低或更改，Turbo 继续使用既有执行器。

该方案保持条件编码、主残差、块输入归一化和最终输出的 FP32 路径，注意力与 MLP 矩阵分支使用 FP16。输出投影按 2 的幂缩放避免溢出；SwiGLU 逐点运算保留 FP32，分行计算控制显存。非有限数值或 OOM 时，使用未被修改的块输入完整回到原 FP32 运算，不裁剪数值。发布前先在 GPU 上检查原生 FP16 注意力、混合 RoPE、安全缩放和分行 SwiGLU 等价性。

2026-11-15 的同提示词/种子、512×288、107 帧、原版20步对照：原精度681.119秒，混合精度原加载446.505秒（约1.53倍，生成耗时减少34.4%）。该数字是生成耗时，首次环境安装、下载及服务启动另计。原精度双卡分块725.407秒、混合精度双卡分块511.056秒均更慢，未用于正式默认执行器。Z-Image 的既有双T4加速保持不变。

这不是逐像素无损方案：该视频对照的 SSIM 为0.944025，音轨相关系数为0.984274，发丝、海鸥、海面及音轨有差异。需要严格复现时使用原精度。上述倍数不代表所有尺寸、时长或提示词的固定收益。

GPU会话及任务保存实际精度审计、完整音视频解码证明和MP4 SHA256；后端拒绝缺失或不符合方案的证明。安全缩放思路参考 [Amduraznak/minimax-h3-fp16-fix](https://github.com/Amduraznak/minimax-h3-fp16-fix)，其MIT许可保留在 `docs/third-party/minimax-h3-fp16-fix-LICENSE`；当前实现适配固定的ComfyUI版本和量化检查点，并未直接启用整个模型的FP16。


## HyperFlow H3 Flash（独立视频模型）

视频模型选择器可选择HyperFlow H3 Flash。初版接入文生音视频，GGUF Q4_K_M，默认6步，也支持官方4/8步，Euler + HyperFlow专用sigmas，BasicGuider（CFG=1）。请求modelId为`hyperflow-h3-flash`，mode为`quality`、runtimeProfile为`standard`；不能套用H3 Turbo、FP16分支或CK方案。请求5–15秒，24FPS对齐到17n+5，默认5秒输出124帧（约5.17秒）。更高尺寸和更长时长以实际T4运行结果为准。

模型是结构剪枝后的独立模型，结果与H3原版不同，不能宣称无损替换。H3和Z-Image-Turbo仍为各自类别的默认模型，原账户、代理、接口与历史作品保留。每个模型使用独立GPU会话，模型内连续任务复用服务。

模型来源：https://huggingface.co/VideoRebirthAI/hyperflow-h3-flash
节点：https://github.com/Video-Rebirth/ComfyUI-HyperFlow-Flash
GGUF加载器：https://github.com/city96/ComfyUI-GGUF
固定版本与文件大小见`lib/hyperflow-config.ts`。HyperFlow节点与GGUF加载器按各自GPL-3.0许可在GPU会话内下载，不打包第三方节点源码或权重；模型沿用MiniMax H3社区许可。模型清单包含独立主模型与原H3共享音视频组件的仓库和revision。实际交付必须有two-time模型前向执行证明、完整音视频解码与上传哈希，不能把短步数探测、未出片或官网RTX 5090速度算成双T4成功。

## 对外生成 API

在计算账户页面创建带模型/任务权限的 API 密钥，使用 `Authorization: Bearer <工作室密钥>` 调用 `/api/v1/models`、`/api/v1/jobs`、`/api/v1/jobs/{id}`、`/sync`、`/cancel`、`/artifact`。原 `/api/v1/accounts` 保持兼容。旧密钥只保留账户权限，新增生成权限需要新建密钥。

- [完整中文说明](public/generation-api-guide.txt)
- [Python 调用示例](public/studio-api-client.py)
- OpenAPI：运行站点的 `/api/v1/openapi.json`
- 创建任务的 `requestId` 必须是客户端生成的小写 UUID；重试沿用该 ID，参数冲突返回 409。
- 新增 `integration_keys.scopes` 由 SQLite/Postgres 启动迁移自动补齐，默认仅原账户权限。API 与网页登录使用同一个固定工作空间和任务队列。
