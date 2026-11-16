FROM debian:bookworm-slim

# ── System dependencies ──────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget curl ca-certificates \
    fuse3 rsync \
    nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# ── Install RaiDrive CLI ─────────────────────────────────────
# Using the latest deb package (amd64). For arm64, change the filename accordingly.
# buildx sets TARGETARCH (amd64/arm64) per platform; override with --build-arg ARCH=... if needed.
ARG TARGETARCH
ARG ARCH=${TARGETARCH:-amd64}
RUN wget -q "https://app.raidrive.com/deb/pool/main/r/raidrive/raidrive_2025.12.0-linux_${ARCH}.deb" -O /tmp/raidrive.deb \
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
