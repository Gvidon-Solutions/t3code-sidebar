# Self-hosted T3 server image for the t3code-sidebar fork.
# Build from the repo root: docker build -f deploy/t3-ws/Dockerfile -t t3-ws .

FROM node:24-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /src
COPY . .
ENV CI=1
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @t3tools/web run build
RUN cd apps/server && node scripts/cli.ts build
RUN pnpm --filter t3 deploy --prod --legacy /out \
 && test -f /out/dist/bin.mjs && test -d /out/dist/client

FROM node:24-bookworm-slim
ARG CODEX_VERSION=0.162.1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client ripgrep tini less procps jq \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@${CODEX_VERSION} && npm cache clean --force
RUN groupadd -g 10001 t3 && useradd -m -u 10001 -g 10001 -s /bin/bash t3
COPY --from=build /out /opt/t3
ENV NODE_ENV=production HOME=/home/t3
USER t3
WORKDIR /home/t3
EXPOSE 3790
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/t3/dist/bin.mjs", "serve", "--host", "0.0.0.0", "--port", "3790", "--no-browser"]
