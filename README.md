# 本地书架（book-manager）

纯离线、单用户的桌面端个人图书管理工具。无任何网络请求、无账号体系，所有数据（SQLite 单文件 + 封面 / 附件）都在本机。

## 技术栈

| 层    | 选型                                 | 说明                                       |
| ---- | ---------------------------------- | ---------------------------------------- |
| 桌面容器 | Electron 44                        | Windows / macOS 兼容                       |
| 前端   | React 19 + TypeScript 5.8 + Vite 7 | 每页一个文件夹（代码 + `.less`），根节点唯一作用域类          |
| 构建   | electron-vite 5                    | main / preload / renderer 三目标一次构建        |
| 数据库  | better-sqlite3 13                  | 同步 API；WAL 模式；库文件在 `userData/library.db` |
| 样式   | Less 4                             | 全局变量在 `src/renderer/styles/global.less`  |

> 版本决策备注：TypeScript 锁 5.8（不追 7.0 原生编译器，`tsc -b` 兼容性优先）；Vite 锁 7（electron-vite 5 的 peer 只支持到 7）。

## 跑起来

前置条件：**Node.js >= 20.19.0**（`@electron/rebuild` 4.x 与 electron-vite 5 都要求 Node 20+；Node 18 会在 rebuild 阶段报 `node:util does not provide an export named 'styleText'`）。本机用 nvm 的话：`nvm use 24.20.0`。

```bash
npm install          # 安装依赖
npm run rebuild      # 为 Electron ABI 重编译 better-sqlite3（必做，见下）
npm run dev          # 开发模式（热更新）
```

生产构建与预览：

```bash
npm run build        # 产出 out/{main,preload,renderer}
npm run preview      # 以生产产物启动
```

### 两个本机环境注意点

1. **`npm run rebuild` 不能跳过**：`better-sqlite3` 预编译包是 Node ABI（127），Electron 44 是 ABI 149，不重编译会在启动时报 "compiled against a different Node.js version"。重编译需要本机有 VS C++ 工具链 + Python 3。
2. **Node 版本**：若报 `node:util does not provide an export named 'styleText'`，说明终端里是 Node 18（`node -v` 确认），`nvm use 24.20.0` 切换后重跑。
3. **公司 Nexus 镜像下 rollup 原生模块**：镜像偶发不传递 `@rollup/rollup-win32-x64-msvc` 这个可选依赖，已作为显式 devDependency 钉死在 `package.json`（版本与 rollup 对齐）。若换机器重装后构建报 `Cannot find module '@rollup/rollup-win32-x64-msvc'`，手动 `npm i -D @rollup/rollup-win32-x64-msvc@<rollup版本>` 即可。
4. **Electron 二进制下载慢**时，可用镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`。

## 应用图标

`resources/` 里是从一张 SVG 导出的一整套图标，`scripts/make-icon.js` 负责导出（换图时重跑即可）：

| 文件 | 用途 |
|---|---|
| `icon.svg` | 源文件，改图从这里改 |
| `icon.png` | 1024×1024，留给以后打包 macOS 时生成 icns |
| `icon-256.png` | 非 Windows 平台的窗口图标 |
| `icon.ico` | Windows 窗口 / 任务栏 / 标题栏图标，内含 **16 / 24 / 32 / 48 / 64（32 位 DIB）+ 128 / 256（PNG）** 七档，任务栏取 16/24/32 时是原生尺寸不会发虚 |
| `public/favicon.svg` | 页面级图标（调试/预览时的标签页） |

主进程 `createWindow()` 里通过 `?asset` 导入（electron-vite 会解析成运行时绝对路径，`out/main/index.js` 里落成 `join(__dirname, '../../resources/icon.ico')`），Windows 走 ico、其余走 png，**解码为空时自动退回另一份**。另外 `app.setAppUserModelId('com.bookmanager.app')` 让 Windows 把窗口归到同一个应用下，任务栏不会另起一组。

换图标：

```bash
npm i -D playwright-core    # 只在本机装一次（光栅化走系统 Edge，不下载 Chromium）
node scripts/make-icon.js "path/to/icon.svg"
```

脚本会先扫出图形的真实不透明边界再居中，四周留 8% 边距——原图里 path 常常超出 viewBox（这张图标底部就溢出 32px），直接铺满会被裁掉一截、整体还偏上。

以后接 electron-builder 打包时：`win.icon` 指 `resources/icon.ico`，`mac.icon` / `linux.icon` 指 `resources/icon.png`，`appId` 与代码里的 `com.bookmanager.app` 保持一致（不一致任务栏图标会分成两组）。

## 目录结构

```
book-manager/
├── electron.vite.config.ts      # 三目标构建配置
├── index.html                   # 渲染进程入口（引 /favicon.svg）
├── resources/                   # 应用图标：icon.svg / icon.png / icon-256.png / icon.ico
├── public/favicon.svg           # 页面图标（构建时拷进 out/renderer）
├── scripts/
│   ├── smoke-db.ts              # 冒烟测试（384 项断言）
│   ├── make-icon.js             # 从 SVG 导出全套图标（playwright + 系统 Edge）
│   ├── verify-epub.js          # EPUB 渲染层实测（playwright + 系统 Edge，按需运行）
│   └── electron-stub.js         # 冒烟测试用的 electron 桩
└── src/
    ├── shared/                  # 主进程/渲染进程共享：类型与 IPC 契约
    │   ├── types.ts
    │   └── api.ts
    ├── main/                    # 主进程
    │   ├── index.ts             # 窗口 + cover:// 协议注册 + 生命周期
    │   ├── storage.ts           # userData 下 covers/ attachments 目录与文件工具
    │   ├── scan/                # 电子书扫描：formats / txt / epub / mobi / pdf / png / scanDir / watch
    │   ├── reader/              # 应用内阅读：open（三分支）/ pdf（页数与大纲）/ epub（小节与目录内联）/ pdfjs 装载层
    │   ├── import/              # 批量导入：csv / xlsx / fieldMap / importer
    │   ├── db/                  # schema.ts（DDL）/ index.ts（连接 + 迁移）/ repo.*.ts（数据访问）
    │   └── ipc/                 # category / book / trash / stats / cover / tag / attachment / scan / import / note / copy / list / reading handlers
    ├── preload/index.ts         # contextBridge 暴露 window.api
    └── renderer/
        ├── App.tsx              # 视图路由 + 全局状态
        ├── api/ utils/ components/   # components 含 TagInput / CoverCard / BookTable / Toast / ConfirmDialog
        └── pages/               # Layout / Home / Shelf / BookDetail / BookForm / Trash / BookLists / CategoryModal
```

数据流：渲染进程 `window.api` → preload → `ipcMain.handle` → `repo.*`（better-sqlite3）→ SQLite。渲染进程不直接碰数据库。

## P0 已实现（本次交付）

- **数据库**：10 张表一次建齐（P1-P4 复用），软删除 `is_deleted`、级联删除子表、`update_time` 触发器
- **分类管理**：无限层级树、含子类图书计数、新增 / 编辑 / 删除守卫（有子分类或有图书时拒绝并提示）、同级拖拽排序（跨级拒绝）、防成环
- **图书**：手动录入全字段（书名 / 作者 / 出版社 / 出版日期 / ISBN / 页数 / 定价 / 语言 / 馆藏位置 / 购入日期 / 分类 / 阅读状态 / 评分 / 已读页数 / 短评 / 简介）、编辑、软删除
- **浏览**：书架封面网格（无封面按书名哈希生成确定性渐变占位）+ 列表表格双视图、列排序、阅读状态角标（`unread` 未读为默认态、不显示角标；`want` / `reading` / `read` 才出徽标）
- **检索**：全局关键词（书名 / 作者 / ISBN / 出版社 / 简介，200ms 防抖）、分类树含子类筛选、状态筛选、10 种排序
- **回收站**：列表、单本恢复、全部恢复、单本彻底删除（级联删本地文件）、清空（均二次确认）
- **首页**：统计卡片（总藏书 / 未读 / 想读 / 在读 / 已读 / 无封面）、最近添加、分类快捷入口
- **布局**：左侧导航（分类树 + 书单占位 + 回收站计数）、顶部搜索 + 视图切换 + 录入入口

## 验收

```bash
npm run typecheck   # tsc -b 全量类型检查
npm run smoke       # 200 项断言（纯 Node，electron 走 alias 桩）
npm run build       # 三目标构建
```

## P1 第一轮已实现（封面 / 标签 / 附件）

- **封面管理**：详情页上传 / 替换 / 移除；渲染进程 canvas 压缩（长边 720px、JPEG 0.85，小图原样直传，**不引 sharp 等原生模块**）；主进程落盘 `userData/covers/<bookId>/`，换封面自动删旧文件；`cover://` 自定义协议展示（带路径守卫，只放行 covers 目录，不开 `webSecurity: false`）
- **标签管理**：chips 输入（回车/逗号提交、退格删尾、已有标签建议下拉）；`book:setTags` 单事务「建缺失标签 → 清旧绑定 → 建新绑定」；重命名 / 删除（book_tag 外键级联）；侧栏标签导航（带在架计数）+ 书架 chips 筛选；**标签名参与全局关键词检索**
- **附件管理**：原生对话框多选文件 → 主进程拷入 `userData/attachments/<bookId>/`（UUID 前缀 + 文件名清洗）；`shell.openPath` 一键打开；移除时删行 + 删文件 + 清空目录；彻底删除图书时封面与附件文件级联清理
- **数据库迁移**：`attachment` 增加 `file_size` 列，`db/index.ts` 内置 PRAGMA table_info 判重 + ALTER 的迁移模式，后续加列照此办理

## P1 第二轮已实现（电子书扫描 / 批量导入 / 监控目录）

- **电子书扫描**（录入弹窗「文件扫描」选项卡）：**支持两种来源**——选目录递归扫描，或「选文件…」直接多选（可跨目录，去重 / 已入库 / 不支持格式都会在跳过区给出原因）；解析元数据（PDF 走 pdfjs-dist 3.x legacy 的 `getMetadata` + 首页内嵌图提取，EPUB 走 yauzl 解压读 OPF + 封面条目，MOBI 手写 PalmDB + EXTH 解析，TXT 按正文元信息行 / 文件名启发）；封面超限丢弃并提示；按 `ebook_path` 去重（含回收站）；勾选后批量入库，封面落盘 `userData/covers/<bookId>/`
- **批量导入**（「批量导入」选项卡）：xlsx / xls / csv 解析；表头自动猜测字段映射（中文关键词词典）可手动改；重复处理三策略（跳过 / 覆盖 / 新增副本）；去重规则 ISBN 优先、无 ISBN 按「书名 + 作者 + 出版社」；支持统一指定分类；错误行按行号汇总
- **监控目录**：chokidar 监听（防抖 6s + awaitWriteFinish），新增电子书自动入库，主进程推送 `scan:autoImported` 事件，渲染层 toast + 自动刷新；目录清单持久化在 `settings` 表，重启自动恢复
- **数据库迁移**：`book` 增加 `ebook_path` / `source` 列，新增 `settings` 键值表；迁移继续走 PRAGMA table_info 判重 + ALTER

### 依赖选型备注

- `pdfjs-dist` 锁 **3.11.174**：4.x 起删除 UMD 构建只剩 ESM，主进程 CJS 用不了；3.x legacy 在 Node 下自动 fake worker，提取元数据 / 内嵌图不依赖 canvas（`canvas` 是它的 optionalDependency，二进制缺失时其内部 try/catch 会兜住）
- **PDF 扫描两个坑已修**（`src/main/scan/pdf.ts`）：① 满屏 `Cannot polyfill DOMMatrix/Path2D` 是 pdfjs 在 Node 试装 `canvas` 的噪声——加载前预置空 `globalThis.DOMMatrix` / `Path2D` 类即可跳过，不渲染所以安全；② 含中文 / 特殊字体的 PDF 报 `cMapUrl` / `standardFontDataUrl` 缺失，`getDocument` 时把 `cMapUrl` / `standardFontDataUrl` 指向 `node_modules/pdfjs-dist` 自带的 `cmaps/` 与 `standard_fonts/` 目录（Node 下走 `fs.readFile` 离线读，无需联网）；③ `OPS` 常量在 3.x 挂在模块导出而非 document 上，`extractFirstImage` 改用 `pdfjsLib.OPS`；④ 元数据尾部可能带 `\u0000` 空字符，trim 后再清 NUL
- `chokidar` 锁 4.x：5.x 是 ESM-only
- `xlsx` 锁 0.18.5：SheetJS 最后官方版（npm 可装）
- EPUB 的 XML 解析用正则而非 XML 库：OPF 结构简单，少一个依赖少一分风险

## P2 已实现（阅读时间线 / 读书笔记 / 自定义书单 / 实体副本）

- **读书笔记**：详情页内联新增 / 编辑 / 删除（内容 + 关联页码）；空内容拦截；软删除级联
- **实体副本**：同一本书登记多本（编号 / 馆藏位置 / 状态 / 备注），状态枚举在架 / 借出 / 遗失 / 损毁，带彩色状态徽标；增改删 + 级联
- **自定义书单**：左侧导航「我的书单」进入独立页面（建 / 重命名 / 删除 / 查看成员 / 移出）；详情页「加入书单」弹窗支持勾选多个书单 + 即时新建；`UNIQUE(list_id, book_id)` 防重复加入；书单计数实时刷新
- **阅读时间线**：新增 `reading_log` 表；图书状态 `want→reading` 自动记「开始阅读」并补 `start_read_at`，`→read` 记「读完」并补 `finish_read_at`（同状态再保存不重复记）；详情页「打卡进度」记一条 progress 事件并同步 `current_page`；时间线 = `reading_log` 与 `note` 合并按时间倒序，首页「近期阅读动态」挂件跨书聚合 start/finish/progress/note 四类事件
- **数据库迁移**：`reading_log` 表通过 `db/index.ts` 的 `CREATE TABLE IF NOT EXISTS` 兜底老库（与 P1 的列迁移模式并存）

## 增量（直接打开电子书文件）

- **三处入口，都不进详情页**：书架卡片封面右下角 hover 浮现「打开」角标；列表视图在书名后跟 `EPUB` / `PDF` 格式小标（点它直接开书，列宽不变、不产生横向滚动）；详情页顶部「打开电子书」主按钮，另有字段区「电子书」行（文件名 + 打开 / 定位 / 更换）
- **走系统默认程序**：主进程 `shell.openPath`，返回错误文案时抛给渲染层 toast；`shell.showItemInFolder` 负责「定位」（资源管理器 / Finder 中选中）
- **打开前先校验**（`src/main/ebookFile.ts`，纯逻辑、不依赖 electron，故可被冒烟覆盖）：区分「还没绑定文件」「文件已不在原位置」「绑定路径是目录」三种成因，错误文案直接可读，用户知道该重绑还是该找回文件
- **补绑 / 换文件**：手动录入和 Excel 导入的书没有 `ebook_path`，详情页可直接「选择文件」绑定（`book:bindEbook`，对话框默认从原目录打开）；`repo.book.setEbookPath` 负责回写
- 冒烟新增 `[23]` 14 项（绑定回写、路径校验三态、list 带出 `ebook_path`），合计 **214 项**

## R1 已实现（应用内阅读器：骨架 + TXT）

不调外部软件就能在应用里读书，这一轮的重点不是「能显示文字」，而是把「读到哪自动记住、下次打开接上」这条链跑通。

- **全屏阅读视图**：三个入口——书架卡片封面角标、列表视图书名后的格式标、详情页「阅读」按钮；Esc 或左上角返回，退出后回到进来时那一页
- **TXT 渲染**：主进程读文件并按 UTF-8 strict → GBK 兜底解码，统一 BOM 与换行；按行切段，`第 X 章 / Chapter N / 楔子 / 序言` 这类行首短标题自动生成目录
- **进度记忆**：新增 `reading_position` 表（一本一行，`locator` 存字符偏移、`percent` 存 0~1）；滚动 1.5s 防抖落库，退出时再落一次并记一条进度事件；重开按偏移二分定位回原段落
- **不动旧口径**：`book.current_page` 由 `percent × pages` 反算回写，且**只增不减**（往回读不清进度）；TXT 没有页数时按 1200 字/页估一次补空值，书架进度条 / 首页统计 / 阅读时间线因此零改动
- **打开即开卷**：`unread / want` 的书进阅读器自动转 `reading`，补 `start_read_at` 与 start 事件（复用 `repo.book.update` 的跃迁逻辑，不另写一套）
- **排版**：字号 15~34、行距三档、版心三档、纸白 / 米黄 / 夜间三主题，偏好存 localStorage；快捷键 Esc、空格、方向键、PageUp/Down、`+` `-`、`T`
- **虚拟滚动**：只渲染视口附近的十几段，配合 `HeightIndex`（实测高度 + 未测段落估算）维持「段落下标 ↔ 像素位置」映射。5MB 级 TXT 首屏只建 13 个节点，改字号从「重排全书」变成「重排十几段」；跳转位置用目标段落的真实 `rect` 校正，不依赖估算累积
- **纯逻辑抽在 `src/shared/reader.ts`**（不依赖 electron / node，主进程与渲染进程共用一份）：段落切分、章节识别、locator 编解码、offset ↔ percent ↔ 页码换算、段落高度估算与 `HeightIndex`
- 冒烟新增 `[24]` 62 项（表结构、切分与章节、换算边界、位置读写、页码只增不减、打开失败三态）与 `[25]` 38 项（宽度估算、行数估算、索引互逆性、越界与脏值、5 万段性能），合计 **314 项**

## 大文件性能（实测，7.1 MB / 248 万字 / 4.07 万段）

同一台机器、同一份文本，用系统 Edge 跑构建产物：

| 指标 | 全量渲染（旧） | 虚拟滚动（现） |
|---|---|---|
| 首屏建 DOM + 排版 | 413~886 ms | ~100 ms |
| 改一次字号的重排 | 328~465 ms | 12~26 ms |
| DOM 里的 `<p>` 数量 | 40667 | 12~17 |
| 连续滚动每屏 JS 开销 | — | ~4 ms |

正确性一并验过：滚到中间 50%、滚到底 100%、目录跳到第 11 章落到「第11章 风起于青萍之末」、退出后重开恢复到 37%、改字号前后位置保持在 50%、上下各连续滚 30 屏 DOM 稳定在 12 段。

已知代价：**从未访问过的区域靠估算定位**，所以拖动滚动条一次跳到远处会有 1~5% 的位置偏差，滚一屏之后即自我校正（实测区会被实测高度永久覆盖）。这是虚拟滚动的固有取舍，不影响「显示百分比 = 当前可见内容的位置」这条语义。

## R2 已实现（PDF 阅读）

PDF 走的是完全不同的渲染路径，但共用同一个外壳与同一条进度链路：`ReaderBook` 只是把「正文文本」换成了「原始字节 + 页数」。

- **按页渲染**：pdfjs 3.11 逐页画到 canvas，只画视口附近那几页，离开视口 4 页以外的画布直接释放。实测 358 页的书全程只维护 3~7 张画布，几百页扫描件不会把内存吃满
- **文本层**：每页叠一层透明文字，可选中、可复制、Ctrl+F 能查找；`--scale-factor` 必须写在页容器上，缺了 pdfjs 会把文字层摊到左上角并刷警告
- **目录**：取 PDF 自带大纲（bookmark），目的地解析成页码后压平，层级用全角空格缩进；扫描件「每页一条 000001.bmp」这种假目录会被过滤，剩不到两条就当没有（此时隐藏目录按钮，靠底栏页码跳转兜底）
- **页码**：底栏「第 [n] / 总页 页」，输入页码回车即跳；PageUp/Down 与空格按页翻
- **缩放**：适应宽度 / 100% / 150% / 200%。100% 按 96dpi 折算（1pt = 4/3 px），不折算的话 100% 比「适应宽度」还小，看起来像缩小了
- **进度**：`locator` 存页码（`{"k":"page","v":67}`），`percent` 按「页内位置」折算，滚到底正好 100%；`book.current_page` 仍是 percent × pages 反算，书架与时间线零改动
- **worker 用 blob 起**：`?raw` 把 worker 内联成字符串再转 blob URL —— 打包后页面在 `file://` 下，直接指向磁盘的 worker 脚本会被同源策略挡掉
- **CMap 内联**：169 个 `cmaps/*.bcmap`（约 1.5MB）以 base64 打进包，配自定义 `CMapReaderFactory` + `useWorkerFetch: false`。不做这件事，中文 PDF 会整页文字空白或乱码（默认实现让 worker 去 fetch 本地文件，file:// 下必然失败）。pdfjs / worker / cmaps 全部动态引入，不打开 PDF 不会加载
- **跳页不做平滑滚动**：动画途中按需渲染会改布局，Chromium 会中断动画 —— 实测一次跳 200 页会停在中途差两百多像素，页码跟着报错。瞬时跳转没有这个问题
- 冒烟新增 `[26]` 14 项（打开返回字节流、页数取自文件、无大纲时目录为空、页码 locator 往返、页数补齐边界、损坏 PDF 与暂不支持格式各自抛错），合计 **329 项**

## R3 已实现（EPUB 阅读）

EPUB 又是第三条路径，但依然共用同一个外壳与同一条进度链路：主进程只给「小节规模 + 目录」，正文按节现取现解压，渲染层用沙箱 iframe 承载。

- **按节取正文**：`reader:section` 一次给一节（xhtml + CSS + 图片全内联）。一本 12 MB 的图文 EPUB 展开后正文加图能到几十 MB，整本过 IPC 只为读第三章纯属浪费内存
- **样式与图片内联**：`<link rel=stylesheet>` 的整份 CSS 读进来，`url()` 与 `<img src>` 改写成 data URL（上限 12 MB/张），`@import` 直接删掉。所以 iframe 里零网络请求，`file://` 下也不会有「图片全裂」
- **两层去脚本**：主进程删掉 `<script>` / `<iframe>` / `on*` 事件属性 / `javascript:` 协议 / `<link>` `<base>`，iframe 再挂 `sandbox="allow-same-origin"`（不给 `allow-scripts`）兜底。`allow-same-origin` 留着是为了量高度
- **外层统一滚动**：iframe 高度 = 内容 `scrollHeight`，滚动的永远是外层 `.reader-scroll`。滚轮在内层被接管后转给外层，键盘（PageUp/Down、Esc、+/-、t）在焦点落进 iframe 时转一份回父窗口 —— 用户不该因为换了个格式就发现「滚轮没反应」
- **进度按字数加权**：一节的字数是权重，`percent = (前面各节字数 + 本节字数 × 节内比例) / 全书字数`。按节数平均会偏得很离谱：实测某本书的「致谢」只有 6 个字却独占一节，按节数算就是 1/28 = 3.6%，按字数算才是 0.003%
- **定位**：`locator` 存 `{"k":"section","v":52.45}`（第 52 节读了 45%），是三种格式里唯一带小数的。`total+1` 表示「最后一节读到底」，重开时按 `(total, 1)` 还原，否则读到 100% 退出再打开会掉回 99%
- **目录**：EPUB3 的 `nav.xhtml`（`<nav epub:type="toc">`，层级用 `<ol>` 嵌套深度算）优先，EPUB2 的 `toc.ncx` 兜底（`<text>` 与 `<content src>` 顺序配对）；都没有就退回「每节取首个 h1~h3」，至少能跳。同一节的重复目录条目只留第一条
- **换字号 / 换主题不丢位置**：srcDoc 重建会让 iframe 重载，重载后按改动前的节内比例落回去
- **主题色从 CSS 变量读**：iframe 拿不到父文档的变量，直接 `getComputedStyle` 读 `--r-bg/--r-ink` 再写进 srcdoc，避免在 TS 里再抄一份色值（抄一份就一定会漏改）
- 冒烟新增 `[27]` 55 项（小节定位往返、加权进度与反算、nav/ncx 解析、沙箱剔除、真实 zip 构造的 EPUB 打开与按节取正文、越界/非 EPUB/损坏文件各自抛错），合计 **384 项**
- 渲染层实测（系统 Edge + playwright，脚本 `scripts/verify-epub.js`）：22 项全过 —— iframe 高度贴合内容、滚轮与键盘转发、目录跳转、改字号后位置不跳、中途退出重开落回同一处（42% → 第 52.45 节 → 42%）、一路 PageDown 能自动翻节到 100%

## R4 路线（未实现）

- **R4 增强**：书签、阅读时长统计、文内搜索；划线批注要存选区 CFI，留到 V2
- **MOBI / AZW3**：正文是 PalmDOC / HUFF-CDIC 压缩，没有现成依赖时自己解压（含 KF8 的 HTML 重组）性价比太低。要做得引 foliate-js（MIT、纯 ESM、支持 EPUB/MOBI/KF8/FB2/CBZ），代价是作者明说 API 不稳定（需锁版本）+ 必须配 CSP 挡内嵌脚本

## P3-P4 路线（未实现）

- **P3**：离线规则助手（自然语言检索、分类推荐、数据清洗、口语化统计）
- **P4**：定时备份 / 恢复、数据导出（Excel/CSV/JSON/Markdown）、主题切换、卡片大小、回收站入口已提前实现

## 已知边界（有意取舍，后续再议）

- **PDF 封面只取首页第一张内嵌位图**：矢量绘制的封面（无内嵌图对象）提取不到，会用书名渐变占位；这是不引 canvas 原生模块换来的轻量，个人规模够用
- MOBI 封面取 firstImageIndex 起的第一个含 JPEG/PNG magic 的 record，个别打包不规范的文件可能取错
- 扫描 / 导入过程在主进程顺序执行，数百本 PDF 的目录要等十几秒（UI 不卡，IPC 是异步的）；超大目录后续可加分批 + 进度事件
- 封面裁剪交互未做：目前只做上传 / 替换 / 移除；压缩固定长边 720px（`utils/cover.ts` 的 `compressImageFile`），个人规模无需缩略图缓存
- 标签筛选走客户端过滤（当前分类/关键词结果集已在内存），万本以上规模可下推 SQL
- 中文书名排序走 SQLite 二进制排序（非拼音序），个人规模可接受；量大可上 FTS5 + 自定义 collation
- **应用内阅读支持 TXT / PDF / EPUB**：TXT 上限 15 MB（虚拟滚动后还能往上抬，但整本过 IPC 与解码的成本会开始明显），PDF 上限 512 MB，EPUB 上限 256 MB
- **PDF 的整份字节是经 IPC 交给渲染层的**：几十 MB 的书感觉不到，几百 MB 的扫描件打开会明显占内存（峰值约文件大小的两三倍）。真要伺候这类文件，得改成自定义协议按 Range 流式读取，这一轮没做
- **PDF 夜间模式只压亮度不反色**：反色对图文书很难看，扫描件本身是白底，压到 0.84 亮度已经够用
- **EPUB 一次只渲染一节**：跨节连续滚动（一节读完自动接下一节）没做，节末要按一次 PageDown；超长的一节（实测有 4.9 万像素高）全靠一个 iframe 撑，Chromium 单个 iframe 到这个量级还稳，再长就该改成分段渲染
- **EPUB 的 CSS 只做「能读」**：整份内联但会强制覆盖 `html/body` 的字号、行距、颜色与所有元素的 `background-color`（不覆盖的话书里写死的浅底/深字在夜间模式下会瞎）。代价是个别书的背景图片装饰会被抹掉
- **MOBI / AZW3 仍走「打开电子书」调系统程序**
- **TXT 目录靠正则猜**：没有「第 X 章」这类行首标题的流水文本不会生成目录，但正文与进度记忆不受影响
- **虚拟滚动的位置精度依赖估算**：没读过的区域用「字号 × 版心宽」估行数，中文正文误差通常 < 1 行；拖动滚动条首次跳到远处可能有 1~5% 的落点偏差，滚一屏后修正。段落高度无法预知是流式排版的天生限制，PDF / EPUB 有固定页或 CFI 就不受影响
- 包体：入口 chunk ~822KB（React 19 全量），PDF 相关三个 chunk（pdfjs 820KB / worker 1.09MB / cmaps 1.57MB）按需加载。桌面本地应用可接受
- 「未分类」没有独立侧栏入口，从「全部图书」进入
