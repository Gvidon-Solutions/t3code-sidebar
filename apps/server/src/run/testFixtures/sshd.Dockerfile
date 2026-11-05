FROM node:26.12.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server ca-certificates && rm -rf /var/lib/apt/lists/* \
    && usermod -l studio -s /bin/bash node && passwd -d studio && mkdir -p /run/sshd
ENTRYPOINT ["/usr/sbin/sshd", "-D", "-e"]
