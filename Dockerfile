FROM node:20-alpine AS base
WORKDIR /app
# Prisma needs OpenSSL on alpine.
RUN apk add --no-cache openssl libc6-compat

FROM base AS deps
COPY package.json package-lock.json ./
# `npm ci` instead of `npm install` so the image strictly matches the
# committed lockfile (the same lockfile CI uses). Avoids silent dep drift
# between local Docker builds and CI builds.
RUN npm ci

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
# `next.config.mjs` sets `output: "standalone"` so this produces
# `.next/standalone/server.js` (a minimal self-contained server) in addition
# to the usual `.next/` artifacts.
RUN npm run build

# Web runtime — uses Next.js standalone server. Image stays small because
# the standalone bundle inlines only the deps the route handlers actually
# import; no node_modules, no src copy.
FROM base AS web-runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# The standalone bundle expects `.next/static` and `public` to sit next to
# its entrypoint. The bundler itself doesn't copy them — that's our job here.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# Prisma's generated client and migrations are needed at runtime for
# `migrate deploy` and the runtime `PrismaClient` constructor lookups.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma ./prisma
EXPOSE 3000
CMD ["node", "server.js"]

# Worker runtime — `tsx src/workers/ingest-worker.ts`. Needs full node_modules
# + src tree (no Next.js standalone bundle for this process). Kept as a
# separate stage so the web image doesn't pay for these copies.
FROM base AS worker-runner
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src ./src
CMD ["npm", "run", "worker"]
