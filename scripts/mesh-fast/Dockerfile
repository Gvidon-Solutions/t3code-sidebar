FROM ghcr.io/astral-sh/uv:0.9.9 AS uv
FROM node:26.12.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server git curl ca-certificates procps libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libatspi2.0-0 libx11-xcb1 fonts-liberation && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd && passwd -d node
COPY --from=uv /uv /usr/local/bin/uv
RUN curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/nvm.sh -o /opt/nvm.sh
