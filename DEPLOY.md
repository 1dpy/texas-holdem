# 部署上线指南（拿到公网链接，和朋友随时开玩）

本项目是 **Node + WebSocket 实时后端**，需要部署到「能跑 Node 进程 + 支持 WebSocket」的平台。
代码已经做好「云就绪」适配：
- 服务器读取 `process.env.PORT`（平台自动注入端口）
- 前端自动用 `wss://`（HTTPS 下）连同源地址，无需改任何连接配置
- 提供 `/healthz` 健康检查端点
- 已附带 `Dockerfile` / `render.yaml` / `railway.json` / `fly.toml` / `Procfile`

> ⚠️ 部署那一步需要用**你自己的账号**登录对应平台（涉及账号凭证，别人无法代登）。下面每条路线都只需点几下 / 跑一两条命令。

---

## 路线 A：Railway（最快，一条命令，推荐先试）

优点：不需要 GitHub，直接把当前目录传上去；自动识别 Node 项目。

```bash
cd texas-holdem

# 1) 登录（会弹浏览器授权，一次即可）
npx @railway/cli login

# 2) 初始化并部署（首次会让你创建/选择项目）
npx @railway/cli init
npx @railway/cli up

# 3) 生成公网域名
npx @railway/cli domain
```

最后一条会输出一个类似 `https://texas-holdem-production.up.railway.app` 的地址——**这就是发给朋友的链接**。

> 说明：Railway 有一次性试用额度，长期使用可能需要绑卡（约 $5/月起）。只是偶尔约局的话额度基本够用。

---

## 路线 B：Render（免费层，无需绑卡；空闲会休眠）

优点：免费不绑卡。缺点：15 分钟无人访问会休眠，下次打开需等约 30~50 秒冷启动（玩起来后一直有活动就不会休眠）。

步骤：
1. 把项目推到你的 GitHub 仓库：
   ```bash
   cd texas-holdem
   git init && git add . && git commit -m "texas holdem"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/texas-holdem.git
   git push -u origin main
   ```
2. 打开 <https://render.com> → 用 GitHub 登录。
3. 点 **New +** → **Blueprint** → 选中刚才的仓库（项目里已带 `render.yaml`，会自动识别配置）。
4. 点 **Apply**，等构建完成，即可得到一个 `https://texas-holdem.onrender.com` 的公网链接。

---

## 路线 C：Fly.io（全球节点，含香港，延迟低；需绑卡验证）

优点：可选香港节点（`hkg`），国内访问延迟低。项目已带 `fly.toml`。

```bash
cd texas-holdem

# 1) 安装 flyctl（Windows PowerShell）
#    iwr https://fly.io/install.ps1 -useb | iex

# 2) 登录（弹浏览器）
fly auth login

# 3) 首次部署（沿用项目里的 fly.toml，注意 app 名全局唯一，可能要改名）
fly launch --copy-config --now

# 之后每次更新
fly deploy
```

部署完成后 `fly open` 或用输出的 `https://<你的app名>.fly.dev` 链接分享给朋友。

---

## 部署后怎么玩

1. 打开你的公网链接 → 输入昵称 → **创建房间**。
2. 点「复制邀请链接」或把 4 位房间码发给朋友。
3. 朋友打开链接（或输入房间码加入）→ 房主点「开始」即可发牌。

## 常见问题
- **朋友连不上 / 一直转圈**：确认用的是 `https://` 公网链接（不是 `localhost`）。前端已自动用 `wss://`，无需手动配置。
- **Render 首次打开很慢**：免费层冷启动，等半分钟；开玩后不会再休眠。
- **想改盲注 / 初始筹码 / 座位数**：改 `engine.js` 里的 `smallBlind` / `bigBlind` / `startingChips` / `maxSeats`，重新部署即可。
