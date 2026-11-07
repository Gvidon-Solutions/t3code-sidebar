FROM ghcr.io/astral-sh/uv:0.9.9 AS uv
FROM node:26.12.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server git curl ca-certificates procps && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd && passwd -d node
COPY --from=uv /uv /usr/local/bin/uv
RUN curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/nvm.sh -o /opt/nvm.sh
