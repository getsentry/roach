# The image of the Roach service. deploy/gcp runs it with the config file
# at /config/roach.json. See "Deploy" in README.md.
FROM node:24-alpine
# Roach signs a certificate for each intercepted host with openssl.
RUN apk add --no-cache openssl && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY service/package.json ./service/
# Only the dependencies of the service package (`@sentry/node`). The root
# package, `@sentry/roach`, has none.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
      --filter @sentry/roach-service
# The service imports the shared types and values in src/ by relative path.
COPY src ./src
COPY service/*.ts ./service/
USER node
EXPOSE 8080
ENTRYPOINT ["node", "service/cli.ts"]
CMD ["service", "/config/roach.json"]
