FROM node:20-alpine

# better-sqlite3 is a native module — needs build tools on Alpine
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# /data is the Fly.io persistent volume mount point
RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "server.js"]
