#!/bin/sh
# Opens exactly what coturn needs (Ubuntu/Debian with ufw). Cloud VMs: open the same ports in the provider's security group too.
set -e
ufw allow 3478/udp;  ufw allow 3478/tcp
ufw allow 5349/udp;  ufw allow 5349/tcp
ufw allow 49152:50151/udp
ufw allow 8080/tcp
ufw status
