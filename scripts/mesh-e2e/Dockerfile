# T3 Mesh E2E VPS image: deploy/t3-ws/Dockerfile plus Mutagen and ssh tooling.
# Build from the repo root:
#   docker build -f scripts/mesh-e2e/Dockerfile -t t3-mesh-e2e:dev .
#
# Mutagen is downloaded from GitHub releases and checked against a pinned
# SHA-256; bump both ARGs together.

FROM node:26.12.1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.14.0
WORKDIR /src
COPY . .
ENV CI=1
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @t3tools/web run build
RUN cd apps/server && node scripts/cli.ts build
# pnpm 12 fails --legacy deploy when workspace-wide patches are not used by the
# t3 subtree; allow the unused ones instead of dropping the mobile patches.
RUN pnpm --filter t3 deploy --prod --legacy --config.allowUnusedPatches=true /out \
 && test -f /out/dist/bin.mjs && test -d /out/dist/client

FROM node:26.12.1-bookworm-slim
ARG CODEX_VERSION=0.162.1
ARG MUTAGEN_VERSION=0.18.1
ARG MUTAGEN_SHA256=7735286c778cc438418209f24d03a64f3a0151c8065ef0fe079cfaf093af6f8f

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client openssh-server ripgrep tini less procps jq \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/mutagen.tar.gz \
      "https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}/mutagen_linux_amd64_v${MUTAGEN_VERSION}.tar.gz" \
 && echo "${MUTAGEN_SHA256}  /tmp/mutagen.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/mutagen.tar.gz -C /usr/local/bin mutagen mutagen-agents.tar.gz \
 && chmod 0755 /usr/local/bin/mutagen \
 && rm -f /tmp/mutagen.tar.gz

RUN npm install -g @openai/codex@${CODEX_VERSION} && npm cache clean --force
RUN groupadd -g 10001 t3 && useradd -m -u 10001 -g 10001 -s /bin/bash t3 \
 && mkdir -p /run/sshd \
 && chown t3:t3 /etc/ssh/ssh_host_*_key
COPY --from=build /out /opt/t3
ENV NODE_ENV=production HOME=/home/t3
USER t3
WORKDIR /home/t3
EXPOSE 3791
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/t3/dist/bin.mjs", "serve", "--base-dir", "/home/t3/.t3", "--host", "0.0.0.0", "--port", "3791", "--no-browser"]
