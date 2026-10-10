# The image of the Roach service. deploy/gcp runs it with the config file
# at /config/roach.json. See "Deploy" in README.md.
FROM node:24-alpine
# Roach signs a certificate for each intercepted host with openssl.
RUN apk add --no-cache openssl && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY src ./src
USER node
EXPOSE 8080
ENTRYPOINT ["node", "src/cli.ts"]
CMD ["service", "/config/roach.json"]
