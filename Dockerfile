FROM debian:bookworm-slim

# ── System dependencies ──────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget curl ca-certificates \
    fuse3 \
    nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# ── Install RaiDrive CLI ─────────────────────────────────────
# Using the latest deb package (amd64). For arm64, change the filename accordingly.
ARG ARCH=amd64
RUN wget -q "https://app.raidrive.com/deb/raidrive-2024.8.15-linux.${ARCH}.deb" -O /tmp/raidrive.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends /tmp/raidrive.deb \
    && rm /tmp/raidrive.deb \
    && rm -rf /var/lib/apt/lists/*

# ── Allow fuse inside container ──────────────────────────────
# /dev/fuse must be available; run container with --device /dev/fuse --cap-add SYS_ADMIN
RUN echo "user_allow_other" >> /etc/fuse.conf

# ── Backend ──────────────────────────────────────────────────
WORKDIR /app
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY backend/ ./
COPY frontend/ ./frontend/

# ── Startup script ───────────────────────────────────────────
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3030

ENTRYPOINT ["/entrypoint.sh"]
