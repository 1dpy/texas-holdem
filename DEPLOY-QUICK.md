# 部署到 Railway —— 你只做 2 步

项目已改造为「云就绪」：服务器读 `process.env.PORT`、前端自动 `wss://`、含 `/healthz` 健康检查、配好 `railway.json`（NIXPACKS 构建 + 健康检查）。Railway CLI 我也已在本机预装。

## 第 1 步：登录（仅此一次，弹浏览器授权）
在项目目录执行：
```
npx @railway/cli login
```
浏览器打开后，用 GitHub / 邮箱授权一下即可。

## 第 2 步：初始化 + 部署 + 拿公网链接
```
npx @railway/cli init
npx @railway/cli up
npx @railway/cli domain
```
- `init` 创建项目（提示里选 New Project）
- `up` 把当前目录传上去自动构建部署（识别 Node + railway.json）
- `domain` 生成公网 HTTPS 链接

`domain` 会输出形如 `https://texas-holdem-production.up.railway.app` 的地址——**这就是发给朋友开玩的链接**。

## 以后更新代码
改完直接 `npx @railway/cli up` 重新部署。

## 想调盲注 / 筹码 / 座位
改 `engine.js` 里的 `smallBlind` / `bigBlind` / `startingChips` / `maxSeats`，再 `up`。
