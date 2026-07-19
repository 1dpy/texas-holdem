# 德州扑克在线平台 —— 通用容器镜像（Fly.io / Railway / 任意支持 Docker 的平台都可用）
FROM node:20-alpine

WORKDIR /app

# 先拷贝依赖清单并安装（利用 Docker 层缓存）
COPY package*.json ./
RUN npm install --omit=dev

# 拷贝其余源码
COPY . .

# 平台会通过 $PORT 注入端口；本地默认 3000
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
