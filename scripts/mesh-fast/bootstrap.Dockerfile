FROM ubuntu:24.04
ENV container=docker
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv openssh-server ca-certificates libatomic1 socat && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd && ssh-keygen -A && passwd -d root && printf 'Port 22\nListenAddress 0.0.0.0\nPermitRootLogin prohibit-password\nPasswordAuthentication no\nStrictModes no\n' > /etc/ssh/sshd_config.d/mesh-fast.conf && systemctl enable ssh
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
