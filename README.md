# dsh-music-hub

自研 DSH 音乐播放器插件：**本地音乐 + QQ音乐 + 酷狗 + 网易云** 四源。

- 播放条挂在对话输入框上方（`conversation.input.dock`），面板/歌词浮层挂 `shell.overlay`
- 宿主半区提供 `/dsh-music/*` 同源路由（曲库扫描、流式播放、在线音源取链代理）
- `GET /dsh-music/manifest` 与 `dsh-card-desktop` 的「音乐」视图契约兼容

## 目录

```
lib/index.js        宿主入口：路由注册、本地曲库、流式播放、偏好持久化
lib/local.js        目录扫描 + 音频文件头解析（音质识别）
lib/online.js       在线三源路由层：登录态持久化、搜索/播放/歌词/歌单分派
lib/sources/*       QQ / 酷狗 / 网易云 协议实现（移植，见 NOTICE.md）
lib/client.js       浏览器半区：播放条、播放面板、歌词浮层（UMD 形态经 __ModuleLoader__ 加载）
```

> 开发用的孤立验证套件（`test/*.mjs`）不随发布包提供，见文末「验证」。

## 路由

| 路由 | 说明 |
|---|---|
| `GET /dsh-music/manifest` | 曲库摘要（含在线登录态），兼容 card-desktop 音乐视图 |
| `GET /dsh-music/stream/<id>` | 本地音频流（Range/206） |
| `GET /dsh-music/api/state` | 偏好 + 曲库状态 |
| `GET /dsh-music/api/dir?path=` | 目录浏览（选音乐目录弹窗用） |
| `POST /dsh-music/api/setroot` | 设置曲库根目录并重扫 |
| `POST /dsh-music/api/refresh` | 重扫当前目录 |
| `POST /dsh-music/api/prefs` | 保存播放偏好（音量/模式/进度） |
| `GET /dsh-music/api/lyric?id=` | 本地同名 `.lrc` 歌词 |
| `GET /dsh-music/<qq\|kg\|nc>/status` | 登录态 |
| `POST /dsh-music/<src>/login/start` | 出二维码（酷狗含设备注册） |
| `GET /dsh-music/<src>/login/check?key=` | 轮询扫码状态 |
| `POST /dsh-music/<src>/login/logout` | 退出登录 |
| `GET /dsh-music/<src>/search?w=&page=` | 搜索 |
| `GET/HEAD /dsh-music/<src>/play/<id>` | 取链并代理音频流（带 `X-DSH-Quality`） |
| `GET /dsh-music/<src>/lyric` | 歌词（酷狗 KRC 逐字优先） |
| `GET /dsh-music/<src>/playlists` / `playlist-categories` / `playlist-search` / `playlist-songs` | 歌单 |
| `GET /dsh-music/<src>/top-lists` / `top-songs` | 榜单 |
| `GET /dsh-music/<src>/my-playlists` | 我的歌单（需登录） |

安全：JSON 接口走 trusted-host 围栏（回环或 `trustedHosts` + 同源 Origin）；
播放流按 Host 判信（浏览器 `<audio>` 不发 Origin）；本地流只放行扫描登记过的曲目，不开放任意路径。

## 安装

### 与卡片桌面的关系

本插件和 [卡片桌面](https://github.com/gqf1/dsh-card-desktop) 是**两个独立插件**，各自安装、独立开关：

| 你装了 | 效果 |
|---|---|
| 只装本插件 | 所有会话输入框上方出现**播放条**；卡片桌面不出现 |
| 只装卡片桌面 | 代码工作台可用；卡片桌面里的「音乐」页是**空面板**，不报错、不影响其他功能 |
| **两个都装** | 播放条 + 卡片桌面内嵌的完整音乐页（推荐） |

> 两个插件目前只在 GitHub、没发到 npm。DSH 的聚合包（像 `@linxin666/dsh-web-all`）依赖 npm registry，
> 而 pnpm 11 默认禁止子包使用 git 依赖，做成聚合包会安装失败（`ERR_PNPM_EXOTIC_SUBDEP`）。
> 所以采用「两个仓库、分两次装」这个可靠做法。

### 从 GitHub 直接装（推荐）

DSH →「设置」→「插件管理器」→ **Add plugin**，填：

```
github:gqf1/dsh-music-hub
```

再按同样方式装上卡片桌面：

```
github:gqf1/dsh-card-desktop
```

然后**完全退出 DSH 再重新打开**（桌面客户端点右上角 × 只是收进托盘，要从托盘右键退出）。

> 为什么要重启：本插件的宿主半区（`lib/index.js`、`lib/online.js`、`lib/sources/*`）
> 在 DSH 启动时加载，不重启就是旧代码。刷新页面只对 `lib/client.js` 生效。

**命令行版 / 浏览器版**用：

```bash
dsh plugin --profile web add github:gqf1/dsh-music-hub
```

### 本机开发（改代码用）

desktop profile 由 Electron 应用独占托管，`dsh plugin --profile desktop add` 会被拒绝。开发时手动挂：

1. `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 加 `"dsh-music-hub"`，
   `dependencies` 加 `"dsh-music-hub": "link:<本仓库绝对路径>"`。
2. 在该 profile 目录执行 `pnpm install --no-frozen-lockfile`（生成 node_modules 软链）。
3. 重启 DSH 使宿主半区加载。

回滚：把 `package.json` 里上面两处改回去，再 `pnpm install`、重启。

## 验证

开发套件在源码仓库的 `test/` 下（不随发布包提供）。在仓库根目录执行：

```bash
node test/host-smoke.mjs      # 宿主：曲库扫描 / 流式 Range / 围栏 / 偏好 / 目录
node test/online-smoke.mjs    # 在线：三源搜索/榜单/出码 + 未登录取链失败路径 + 围栏（需联网）
node test/client-smoke.mjs    # 客户端：UMD 工厂形态 / inject / 插槽注册 / slots 缺失降级
node test/client-render.mjs   # 客户端：每个组件真渲染（抓渲染期未声明标识符）、交互路径
node test/tool-smoke.mjs      # 模型工具 music_play：意图写入 / 各失败分支文案 / tools 缺失降级
node test/source-live.mjs     # 在线协议层直连探针（签名向量 + 真实接口，需联网）
node test/live-host-e2e.mjs [baseUrl]  # 打「已跑起来的宿主」做真端到端（默认 19487）
```

**生效范围（实测踩过坑）**：

- `lib/local.js`、`lib/client.js` —— 客户端/本地扫描，**刷新页面即生效**，不必重启。
- `lib/index.js`、`lib/online.js`、`lib/sources/*` —— 宿主半区，**必须重启 DSH** 才加载。
  判断方法：比对进程启动时间与文件修改时间，进程更早就说明跑的是旧代码。

所有测试都用临时 `DSH_HOME`（`mkdtempSync`）隔离，**不会碰真实 `~/.dsh` 的曲库/登录态**。

## 已知边界

- 酷狗：**匿名取链已失效**，播放必须扫码登录；首次登录会先注册设备（真 dfid），否则取链被风控拦（20028）。
- QQ：未登录只能浏览与搜索，取链需要登录态；VIP 无损需会员。
- 网易云：免费曲匿名可取 320k，VIP/数字专辑只能拿 45 秒试听片段。
- 本地歌词仅读同名 `.lrc`；在线歌词来自各平台接口。

## 许可

本插件自有代码 MIT。`lib/sources/*` 移植自 [kendu76/dsh-music-player](https://github.com/kendu76/dsh-music-player)（MIT），
详见 [NOTICE.md](./NOTICE.md)。
