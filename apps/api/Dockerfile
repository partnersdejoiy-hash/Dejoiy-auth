# ---------- Build stage ----------
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
RUN pnpm install --frozen-lockfile --filter @dejoiy/api... --config.confirmModulesPurge=false
COPY apps/api/src ./apps/api/src
RUN pnpm --filter @dejoiy/api build

# ---------- Runtime stage ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && addgroup -S dejoiy && adduser -S dejoiy -G dejoiy
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
RUN pnpm install --frozen-lockfile --filter @dejoiy/api... --prod --config.confirmModulesPurge=false \
  && rm -rf /root/.cache /tmp/*
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/src/db/migrations ./apps/api/dist/db/migrations
USER dejoiy
EXPOSE 8080
WORKDIR /app/apps/api
CMD ["node", "dist/index.js"]
