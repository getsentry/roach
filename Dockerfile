# The image of the Roach service. deploy/gcp runs it with the config file
# at /config/roach.json. See "Deploy" in README.md.
FROM node:24-alpine
# Roach signs a certificate for each intercepted host with openssl.
RUN apk add --no-cache openssl && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/roach/package.json ./packages/roach/
COPY packages/service/package.json ./packages/service/
# Only the service package and what it depends on: `@sentry/node`, and
# `@sentry/roach` as a link to packages/roach. Node strips the types of a
# linked package, because its real path is not in node_modules.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
      --filter "@sentry/roach-service..."
COPY packages/roach/src ./packages/roach/src
COPY packages/service/src ./packages/service/src
USER node
EXPOSE 8080
ENTRYPOINT ["node", "packages/service/src/cli.ts"]
CMD ["service", "/config/roach.json"]
