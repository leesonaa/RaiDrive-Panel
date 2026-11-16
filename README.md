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
│   ├── server.js        # Express API，封装 raidrivecli 命令
│   ├── sync.js          # 文件同步引擎（rsync + 双向快照 + cron）
│   └── test/            # node --test，需要本机有 rsync
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

## GitHub Actions 构建

`.github/workflows/docker.yml`：push 到 main 时先跑 `npm test`，再构建 amd64 + arm64 镜像并推送到 Docker Hub（`leesonaa/raidrive-panel:latest`，打 tag `v*` 时另出版本号 tag）。PR 只构建不推送。

需要在仓库 Settings → Secrets and variables → Actions 添加：`DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`（Docker Hub Access Token）。

## ARM 架构（如 Orange Pi 5 Plus / RK3588）

使用 Actions 构建的镜像无需任何设置，arm64 自动选择。本地手动构建时可修改 `docker-compose.yml` 中的 build args：

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

## 文件同步

raidrivecli 本身没有同步命令，面板在挂载路径与本地目录之间用 rsync 做同步。
本地目录需要先通过 volume 映射进容器（见 `docker-compose.yml`）。

| 模式 | 说明 |
|------|------|
| 双向 | rsync 无原生双向，面板扫描两侧并与「上次同步快照」比对：单侧改动传到另一侧；一侧删除且另一侧未改则传播删除；改动与删除冲突时保留改动；两侧都改按策略（较新/本地/挂载点）取胜，败方副本备份到 `/etc/raidrive/panel/sync-conflicts/` |
| 本地 → 挂载点 / 挂载点 → 本地 | 单向 rsync，可选 `--delete` |

触发：页面手动运行（带实时进度和日志，支持试运行/取消），或为任务配置 cron 表达式定时执行。

安全保护（均可用「强制运行」跳过）：
- 远端路径必须在 Connected 的挂载点内，否则拒绝运行（防止挂载掉线后对空目录做同步）
- 双向：上次有记录的一侧突然变空则中止；计划删除数超过上限或超过已跟踪文件的一半则中止
- 单向 `--delete`：源目录为空则中止；传 `--max-delete` 上限
- 首次双向同步只做合并，不删除任何文件

限制：忽略符号链接和特殊文件；不比较文件内容，按「大小 + 修改时间（±2 秒）」判断变化；首次双向同步时两侧同名但时间不同的文件会按冲突策略处理。

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
| GET    | /api/sync/jobs            | 同步任务列表   |
| POST   | /api/sync/jobs            | 新建同步任务   |
| PUT    | /api/sync/jobs/:id        | 修改同步任务   |
| DELETE | /api/sync/jobs/:id        | 删除同步任务   |
| POST   | /api/sync/jobs/:id/run    | 运行（`dryRun` / `force`） |
| POST   | /api/sync/jobs/:id/cancel | 取消运行       |
| GET    | /api/sync/jobs/:id/log    | 最近一次运行日志 |
