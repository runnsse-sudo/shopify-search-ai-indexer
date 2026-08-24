FROM node:20-alpine AS builder

RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npx prisma generate
RUN npm run build
RUN npm run build:scan-worker
RUN npm run build:repair-worker
RUN npm run build:queue-reconcile-worker
RUN npm run build:indexnow-worker
RUN npm run build:provider-materialization-worker

FROM node:20-alpine AS runtime

RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production

EXPOSE 3000

COPY package.json package-lock.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY prisma/migrations ./prisma/migrations

RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/build ./build
COPY --from=builder /app/build-workers ./build-workers

CMD ["npm", "run", "docker-start"]
