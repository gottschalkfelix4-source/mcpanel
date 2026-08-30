FROM node:22-alpine

# tar/unzip für Backups & Modpacks, curl für Healthchecks,
# cifs-utils für die Samba-Zweitablage (wird zur Laufzeit eingehängt)
RUN apk add --no-cache tar curl tzdata openssl openssl-dev libc6-compat cifs-utils

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

ENV NODE_ENV=production
EXPOSE 3000
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/index.js"]
