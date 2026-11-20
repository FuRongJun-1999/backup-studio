# Backup Studio

高性能本地目录备份工具。面向「同一批文件反复备份」的真实场景：目标目录已存在旧备份时，靠内容哈希去重避免重复复制；源端文件改名或移动时，目标端同步路径变化，而不是复制出第二份。

界面遵循 [desktop-agent-ui](https://github.com/Ludi-Herry/desktop-agent-ui) 设计规范：去边框分层、发丝描边、同心圆角、阻尼弹簧动效、暗色字重补偿。

---

## 功能

| 能力 | 说明 |
| --- | --- |
| 哈希去重 | 源端与目标端同内容文件只比对哈希，不重复传输；二次备份近乎零写入 |
| 改名同步 | 源端 `a.txt` → `doc/a.txt` / `a1.txt` 时，目标端直接改名对齐路径，零字节传输 |
| 内容更新 | 同路径但大小/哈希变化的文件覆盖更新 |
| 多线程复制 | `worker_threads` 复制池，默认 `CPU-1` 并发，上限 8 |
| 断点续传 | 复制中断后按 1 MiB 分片续传，逐片比对目标 `.part` 与源文件的 SHA-256，**只重写损坏、截断或缺失的分片** |
| 拔盘恢复 | 目标介质掉线即停止写入并保全断点；介质回来后**不自动续传**，需用户确认并重新扫描 |
| 同步语义可切换 | 运行时切换 `严格镜像` / `镜像并保留历史`（删除前归档到 `.backup-studio/history`） |
| 删除风险闸门 | 源端为空或孤儿占比过高时强制二次确认，防止误选目录造成不可逆丢失 |
| 虚拟列表 | 计划清单上限 20000 条，虚拟滚动渲染，十万级文件不打爆 IPC |

### 去重与改名判定链路

计划器（`electron/engine/planner.ts`）按五轮收敛，尽量少算哈希：

1. **元数据快判** —— manifest 记录了上次的 `size` / `mtime` / `sha256`，完全一致直接判「跳过」。
2. **大小不同** —— 同路径大小不一致，直接判「更新」，无需哈希。
3. **同尺寸** —— 大小相同但无元数据命中，才计算两边哈希比对，相同判「跳过」，不同判「更新」。
4. **按 size 分桶** —— 源端新增文件先按文件大小分桶，只对「可能与目标端孤儿文件配对」的桶算哈希，避免对全部新文件做哈希。
5. **改名配对** —— 同哈希且旧路径在目标端成为孤儿 → 判为「改名」；同名优先于改名。

### 断点续传如何只重传受损分片

worker 以 1 MiB 为一块遍历源文件，对每一块计算 SHA-256，并与目标 `.part` 对应位置的块逐一比对：

- 目标端该块存在且哈希一致 → **复用，不写入**
- 哈希不一致（等长损坏、写入未落盘）或目标端缺失/截断 → **只重写这一块**

写完后仍回读整份文件重算 SHA-256 与源比对，**校验通过才原子 rename 提交**。校验失败返回 `VERIFY_FAILED` 并保留临时件——不再整份重传，下次运行继续按分片比对。

### 拔盘恢复如何成立

账本（journal）写在**本机 userData**——介质被拔出时续传进度仍然可读，这是恢复的前提；同时尽力双写一份到目标盘并附 CRC32，仅作候选证据。介质可用性以目标根可达性为准而非单一错误码（文件级 `ENOENT` 也可能是介质掉线的表象）。

介质回来后**不会自动续传**：掉线前的计划里含有当时算出的删除动作，直接沿用会误删。因此旧计划立即失效，须由用户确认后重新扫描生成新计划，再按分片续传。

介质掉线后不会再往目标路径写入，也不会重建目标目录：

- 账本镜像双写只在**介质在线、目标根可达、身份未漂移**时进行，且镜像写入**不会创建**目标端目录
- 提交产物时**先 rename 再按需补建目录**，补建之前先复核目标根是否仍可达——不可达即判定掉线，不动目标盘
- 介质回来时校验身份：同一路径插入了**另一块设备**判为身份漂移，禁止写入，不当作「介质恢复」

---

## 技术栈与选型

**Electron + React + TypeScript + 纯手写 CSS / Design Token**，不引组件库。

选 Electron 而非 Tauri/Rust 的理由：

- 备份是**磁盘 I/O 密集**而非 CPU 密集。哈希走 `node:crypto`（原生 C++ 实现），复制用 `worker_threads` 真并行，与 Rust 版差距极小。
- 本机无 Rust 工具链，安装需额外授权。
- 同一代码库可产出 Windows NSIS `.exe` 与 Linux AppImage / `.deb`，双平台交付成本最低。

界面全部铁律下沉到 CSS 物理层（双环焦点、Grid `0fr→1fr` 折叠、inset 发丝描边），组件库会稀释对这些细节的控制力。

---

## 目录结构

```
backup-studio/
├─ electron/                # 主进程
│  ├─ main.ts               # 窗口、IPC、目录选择框
│  ├─ preload.ts            # contextBridge 安全桥
│  └─ engine/
│     ├─ scan.ts            # DFS 扫描（跳过符号链接与 .backup-studio）
│     ├─ hash.ts            # SHA-256 并发哈希
│     ├─ manifest.ts        # 原子写 JSON 的目标端清单
│     ├─ planner.ts         # 五轮计划判定 + 删除风险闸门
│     ├─ journal.ts         # 账本（写本机 userData）
│     ├─ copyWorker.ts      # worker 分块复制 / 续传 / 校验
│     ├─ pool.ts            # worker_threads 复制池
│     └─ service.ts         # 状态机、介质探测、暂停恢复
├─ shared/types.ts          # 跨进程类型契约
├─ src/                     # 渲染层
│  ├─ App.tsx
│  ├─ components/           # 目录选择 / 计划面板 / 进度 / 分栏 / 虚拟列表 / 事件流
│  ├─ lib/                  # api / format / spring / mock
│  ├─ hooks/
│  └─ styles/               # tokens / base / app
├─ test/engine.test.ts      # 引擎测试（10 例）
└─ _refs/desktop-agent-ui/  # 设计规范参考
```

---

## 环境要求

- Node.js ≥ 20（本机验证于 v24.13.0）
- npm（Windows 下需用 `npm.cmd`）
- 打包 Windows 需在 Windows 上执行；打包 Linux 需在 Linux 上执行（electron-builder 不做跨平台打包）

## 安装与开发

```powershell
Set-Location 'D:\SQM\desktop\gowork\backup-studio'
npm.cmd install
```

国内网络加速：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
npm.cmd install --registry=https://registry.npmmirror.com --no-audit --no-fund
```

## 常用命令

```powershell
npm.cmd run dev:renderer   # 仅启动渲染层（Vite，端口 5273），window.backupAPI 缺失时启用 mock 后端
npm.cmd run typecheck      # 渲染层 + 主进程 + 测试目录类型检查
npm.cmd run build          # 渲染层 Vite 构建 + 主进程 tsc 编译
npm.cmd run test:engine    # 引擎测试（需先 build:electron，因为依赖编译后的 copyWorker.js）
npm.cmd start              # 构建后启动 Electron
npm.cmd run pack:win       # 打包 Windows NSIS 安装包 → release/
npm.cmd run pack:linux     # 打包 Linux AppImage + deb → release/
```

## 打包产物

- Windows：`release/Backup Studio Setup 0.1.0.exe`（NSIS，可选安装目录、创建桌面快捷方式）
- Linux：`release/backup-studio-0.1.0.AppImage`、`release/backup-studio_0.1.0_amd64.deb`

## CI 双平台构建

- `.github/workflows/ci.yml` —— push / PR 触发：类型检查 → 构建 → 引擎测试
- `.github/workflows/release.yml` —— 打 tag `v*.*.*` 触发：Windows NSIS + Linux AppImage/deb 构建并上传 Release

---

## 引擎测试

`npm.cmd run test:engine` 覆盖 24 个场景：

**基础备份与同步**

1. 首次复制全部写入
2. 二次备份哈希命中全部跳过
3. 改名同步（源端改名 → 目标端跟随）
4. 同路径内容更新
5. 严格镜像模式删除源端已消失文件
6. 保留历史模式归档而非删除

**续传与并发**

7. 断点续传后文件字节与全量一致
8. B3：显式恢复只重写损坏、截断和缺失的分片
9. 多线程并发复制结果正确

**掉盘容灾**

10. 拔盘检测：备份过程中目标介质掉线，介质状态转为 lost
11. 掉线后不再向目标盘写入，也不会重建目标目录
12. 只读探测不创建任何目录（探测阶段不得有写副作用）
13. 不存在的路径探测为不可达且不抛异常
14. 介质身份可识别且同一路径比对稳定
15. 介质身份漂移判定为 L2 并禁止写入
16. 不可达介质判定为 L2
17. 证据不足时默认 L1 只读，不自动写盘
18. 隔离状态下即使介质正常也判为 L2
19. 事务日志可检测盘上副本被截断（CRC 不匹配）
20. CRC32 对相同内容稳定且对改动敏感
21. 本机账本在介质不可用时仍可读出断点
22. 隔离标记可撤销，撤销后允许重新备份
23. 中断后旧计划失效，必须重新扫描才能开始

**闸门**

24. 高风险删除触发二次确认闸门

---

## 界面规范落地清单

- **去边框**：全部容器靠 1%–3% 微明度分层，禁用纯黑 `#000`
- **配色**：浅色 `#f5f5f3` / `#fcfcfb`；暗色 `#0b0b0b` / `#151515` / `#1a1a19` / `#20201e`
- **输入框聚焦**：不加 outline，改为加深双环 `box-shadow`（内环 inset + 外环 1px + 4px 柔光）
- **暗色补偿**：字重整体降 40（400 → 360）
- **行内图标**：`vertical-align: -0.125em`
- **数字防抖**：所有数字 `tabular-nums`
- **丝滑折叠**：免 JS 算高，CSS Grid `0fr → 1fr`
- **防孤字**：正文 `text-wrap: pretty`
- **拖拽弹簧**：分栏拖拽用阻尼弹簧 **(1200/80)**，零回弹咬死；点赞/对勾用欠阻尼 **(380/18)** 微弹
- **反馈自熄**：复制对勾 2.5s 后自动淡出恢复
- **边框只套一层**：容器内按钮不加边框，hover 改底色；描边用 inset `box-shadow`
- **同心圆角**：外圆角 = 内圆角 + 内边距
- **分栏**：拖动时右侧预览盖透明遮罩；Esc 恢复原比例；双击回 50/50；左栏超过 82% 自动收起右栏
- **长文件名**：中间省略号，后缀完整保留
- **中点禁用**：不使用 `·` 作为分隔符，改用竖线

弹簧参数按 Framer Motion 的 spring 语义实现：1200/80 → 阻尼比 ζ≈1.15（过阻尼，零回弹）；380/18 → ζ≈0.46（欠阻尼，微弹）。实现为自研半隐式欧拉 + 子步进积分器，零第三方依赖，直接驱动 DOM / CSS 变量而非触发 React 重渲染。

---

## 已知限制

- Linux 二进制需在 Linux 上构建，或使用仓库内的 GitHub Actions 矩阵产出；本机无 Linux 交叉环境。
- `worker_threads` 受 Electron 单进程架构限制，无法通过多进程进一步提升并行度；瓶颈通常在磁盘而非线程数。
- 目标介质为网络盘 / SMB 时，续传需回读并逐块哈希 `.part`，会放大网络往返开销。
- 渲染层 mock 后端仅供浏览器预览界面，不参与真实备份。

## License

MIT
