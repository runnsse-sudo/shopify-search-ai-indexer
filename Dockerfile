FROM node:20-alpine AS builder

RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npx prisma generate
RUN npm run build

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

CMD ["npm", "run", "docker-start"]
