# ---- build stage: install deps (compiles better-sqlite3) + build the React UI ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# node-gyp toolchain for the native better-sqlite3 build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build \
  && npm prune --omit=dev   # keep the compiled better-sqlite3, drop devDeps

# ---- runtime stage: slim image with ffmpeg, no build tools, no secrets ----
FROM node:22-bookworm-slim
WORKDIR /app

# ffmpeg + ffprobe power the MKV/AVI transcode pipeline (audio + subtitles)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# same base image as the builder → the native binary is ABI-compatible
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./package.json

# Provider credentials + library live here, mounted as a volume — never baked in.
VOLUME ["/app/data"]
EXPOSE 3000

# Run directly (avoids the cross-env devDependency used by "npm start")
CMD ["node", "server/index.js"]
