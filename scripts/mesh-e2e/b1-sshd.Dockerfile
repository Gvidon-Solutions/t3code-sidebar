FROM ubuntu:24.04
ENV container=docker
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv openssh-server ca-certificates libatomic1 && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd && ssh-keygen -A && passwd -d root && printf 'Port 22299\nListenAddress 127.0.0.1\nPermitRootLogin prohibit-password\nPasswordAuthentication no\n' > /etc/ssh/sshd_config.d/B1.conf && systemctl enable ssh
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
