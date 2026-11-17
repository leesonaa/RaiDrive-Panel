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
│   ├── fs-api.js        # 文件管理 API（浏览/复制/移动/删除，rsync 传输）
│   ├── sync.js          # 任务式同步引擎（rsync + 双向快照 + cron）
│   ├── rsync-run.js     # rsync 进程与进度解析
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

## 文件管理（双栏拖动传输）

左栏「本地」是容器内的目录，右栏「挂载点」是 RaiDrive 挂载路径（两栏都可以跳到任意允许的位置）。

- 把文件/文件夹从一栏**拖到另一栏**即复制；拖到某个文件夹行上则进入该文件夹
- 工具栏「拖动时：复制 / 移动」切换默认行为，**按住 Shift** 临时反转
- **框选**：在空白处（或未选中行的大小/时间列）按住鼠标拖出矩形，经过的行被选中；`Ctrl` 反选、`Shift` 追加；拖到列表上下边缘会自动滚动。抓住图标/文件名（已选中的行可从任意位置抓）则是拖动文件
- **右键菜单**：对文件——打开、复制到另一栏、移动到另一栏、复制、剪切、粘贴到此文件夹、重命名、删除、复制路径；对空白处——粘贴、新建文件夹、刷新、全选、反选、复制当前路径。选中规则和资源管理器一致：在已选项上右键保持选择，在未选项上右键只选该项，在空白处右键取消选择
- **复制 / 剪切 / 粘贴**：`Ctrl+C`、`Ctrl+X`、`Ctrl+V`（可跨栏、跨目录；在同一文件夹内粘贴会询问「保留两者」）。被剪切的项显示为半透明
- 其他：多选（Ctrl/⌘ 点击、Shift 范围、Ctrl+A）、双击进入、后退/前进/上一级、排序、过滤、收藏目录
- 目标已有同名项时弹出选择：跳过 / 保留两者（自动重命名）/ 覆盖；不会用文件替换同名文件夹
- 底部显示传输进度，可取消；Delete 删除、F2 重命名
- 「⇄ 同步这两个目录」会用当前两栏目录预填一个任务式同步（见下）

可浏览范围：所有 RaiDrive 挂载路径，加上**映射进容器的所有卷**（自动识别，例如 `/mnt/disk2/movies:/mnt2` 直接可用；容器自身的系统目录和 `/etc/raidrive` 等配置卷不在内）。如需严格限制，设置 `FS_ROOTS`（冒号分隔的容器内路径），设置后只允许列出的目录；`FS_AUTODETECT=0` 可关闭自动识别。符号链接不能指向范围之外。未 Connected 的挂载点拒绝浏览和写入，避免把文件写进掉线后的空目录。

**安全**：这个面板能读写删除容器内文件，请设置 `PANEL_USER` 和 `PANEL_PASSWORD` 开启 HTTP Basic 认证（两个都设才生效），不要把 3030 端口暴露到公网。

### 文件属主与权限

默认情况下容器以 root 运行，写入本地目录的文件属主是 root。可以设置写入**本地目录**时使用的属主和权限（写入云盘挂载点不受影响）：

| 系统 | PUID | PGID | UMASK |
|------|------|------|-------|
| Unraid | 99 | 100 | 000 |
| 群晖 Synology | 1000 | 1000 | 022 |

两种方式任选：在 compose 里设环境变量 `PUID` / `PGID` / `UMASK`，或在面板「设置 → 文件权限」里填写（带一键预设，保存到 `perms.json`，优先于环境变量）。UMASK `000` → 文件 666 / 文件夹 777，`022` → 644 / 755，`002` → 664 / 775。对文件管理的复制/移动/新建文件夹和任务式同步都生效。注意：权限位按 UMASK 统一设置（可执行位不保留）；更改属主需要容器以 root 运行（默认即是）。API：`GET/PUT/DELETE /api/perms`。

## 任务式同步

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
| GET/PUT/DELETE | /api/perms    | 文件属主/权限配置 |
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
| GET    | /api/fs/roots             | 可浏览的根目录和默认位置 |
| GET    | /api/fs/list?path=        | 列目录         |
| POST   | /api/fs/mkdir             | 新建文件夹     |
| POST   | /api/fs/rename            | 重命名         |
| POST   | /api/fs/delete            | 删除           |
| POST   | /api/fs/transfer          | 复制/移动（`sources` `destDir` `op` `onConflict`），进度走 SSE |
| POST   | /api/fs/transfer/:id/cancel | 取消传输     |
| GET    | /api/fs/tasks             | 传输任务列表   |
