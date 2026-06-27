# RaiDrive Panel

基于 [RaiDrive CLI](https://docs.raidrive.com/en/cli/) 的 Docker 可视化管理面板。

## 项目结构

```
raidrive-panel/
├── Dockerfile
├── docker-compose.yml
├── entrypoint.sh
├── backend/
│   ├── package.json
│   └── server.js        # Express API，封装 raidrivecli 命令
└── frontend/
    └── index.html       # 单页管理界面
```

## 快速启动

```bash
# 构建并启动
docker compose up -d --build

# 访问面板
open http://localhost:3030
```

## ARM 架构（如 Orange Pi 5 Plus / RK3588）

修改 `docker-compose.yml` 中的 build args：

```yaml
args:
  ARCH: arm64
```

## 注意事项

### FUSE 权限

RaiDrive CLI 使用 FUSE 虚拟文件系统，容器必须有：

```yaml
devices:
  - /dev/fuse
cap_add:
  - SYS_ADMIN
security_opt:
  - apparmor:unconfined
```

### 需要浏览器授权的存储

Google Drive、OneDrive、Dropbox 等需要浏览器 OAuth 授权，在无头容器中无法直接完成。
建议：
1. 先在宿主机安装 raidrivecli 完成授权，然后将 `/etc/raidrive/main.dat` 复制到容器 volume
2. 或使用支持无头授权的存储（WebDAV、SFTP、FTP、S3 兼容）

### 持久化配置

配置文件通过 Docker volume 持久化，重启容器后无需重新配置：

- `raidrive-config` → `/etc/raidrive/main.dat`（加密配置）
- `raidrive-cache`  → `/var/cache/raidrive/`
- `raidrive-logs`   → `/var/log/raidrive/`

## API 接口

| 方法   | 路径                  | 功能           |
|--------|-----------------------|----------------|
| GET    | /api/status           | 守护进程状态   |
| GET    | /api/list             | 列出挂载点     |
| POST   | /api/add              | 添加存储       |
| POST   | /api/mount            | 挂载           |
| POST   | /api/unmount          | 卸载           |
| DELETE | /api/remove           | 删除挂载点     |
| GET    | /api/show/:label      | 查看详情       |
| POST   | /api/signin           | 登录账号       |
| POST   | /api/signout          | 退出登录       |
| GET    | /api/logs             | SSE 日志流     |
| GET    | /api/daemon-logs      | 读取守护进程日志|
