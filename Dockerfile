FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY apps/ apps/
COPY packages/ packages/
COPY patches/ patches/
COPY scripts/ scripts/
COPY types/ types/
COPY vendor/ vendor/
RUN npm run engine:prepare && npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
# Media export passes chromium.executablePath() to Playwright, so install full Chromium.
# Playwright's --with-deps runs apt-get update before installing browser dependencies.
RUN npm ci --omit=dev \
    && ./node_modules/.bin/playwright install --with-deps --no-shell chromium \
    && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && install -d -o node -g node -m 0750 /data
COPY --from=build /app/dist/server.mjs /app/dist/cli.mjs ./dist/
COPY --from=build /app/dist/web/ ./dist/web/
COPY --from=build /app/.generated/state-conquest/ ./.generated/state-conquest/
COPY --from=build /app/packages/arena/src/ ./packages/arena/src/
COPY configs/models.default.json ./configs/
COPY deploy/REVISION ./deploy/
COPY LICENSE ./
COPY vendor/state-conquest/data/geography/LICENSE.us-atlas.txt \
     vendor/state-conquest/data/geography/NOTICE.census.txt \
     vendor/state-conquest/data/geography/SOURCE.json \
     ./vendor/state-conquest/data/geography/
USER node
RUN test -x "$(node --input-type=module -e 'import { chromium } from "playwright"; console.log(chromium.executablePath())')"
CMD ["node", "dist/server.mjs", "--port", "4180", "--data-dir", "/data"]
