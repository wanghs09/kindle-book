# Kindle 编书 · DSH 插件

**English**: A DeepSeek Harness plugin that turns web articles into an EPUB (and AZW3 via calibre) you can read offline — one sidebar page for pasting links, plus a `kindle_book` agent tool.

**中文**：把网页新闻抓成纯净正文，打包成 EPUB / AZW3。Harness 侧栏多一个「Kindle 编书」页面，粘贴链接就能编书下载；同时给 Agent 一个 `kindle_book` 工具，两条路走同一段逻辑。

## 功能

- **侧栏页面**：粘贴链接、填书名、选输出目录，一键生成 EPUB / AZW3，结果直接下载（中文文件名保留）。
- **Agent 工具**：`kindle_book(urls=[...], title="...")`，聊天里就能编书。
- **正文清洗**：去掉导航、广告、相关阅读、脚本样式，只留文字。
- **失败可见**：抓不到的链接单独列出，原始日志可展开。
- **跨平台 calibre 探测**：macOS / Linux / Windows 常见安装路径、`PATH`、`NEWS2KINDLE_EBOOK_CONVERT` 环境变量都能识别。

## 前置依赖

| 依赖 | 是否必需 | 说明 |
| --- | --- | --- |
| Python 3.10+ 与 `lxml` | 必需 | 插件自动依次探测：`config.pythonPath` → DSH 自带 python → `/opt/homebrew/bin/python3` → `/usr/local/bin/python3` → `/usr/bin/python3` → `PATH` 的 `python3`。安装：`python3 -m pip install --user lxml` |
| [calibre](https://calibre-ebook.com/) | 可选 | 只有需要 AZW3 时才要；缺了就只出 EPUB，页面会提示 |
| DSH `>= 0.2.1-0` | 必需 | 用到 `webServer` 路由、`main` / `sidebar.panellist` 槽位与工具注册 |

## 安装

任选一种（都通过侧栏 **插件** 页完成，不要手工改 profile 的 `package.json`）：

| 方式 | 操作 |
| --- | --- |
| **插件市场** | 插件页 → 发现 → 添加索引 `https://raw.githubusercontent.com/wanghs09/dsh-plugin-kindle-book/main/market-index.json` → 搜索「Kindle」安装 |
| **GitHub** | 插件页 → 添加插件 → 填 `git+https://github.com/wanghs09/dsh-plugin-kindle-book.git` |
| **npm** | 插件页 → 添加插件 → 填 `dsh-plugin-kindle-book`（尚未发布到 npm，见下方说明） |
| **本地目录** | 插件页 → 添加插件 → 本地目录 → 选本仓库克隆下来的目录 |

装好后侧栏出现「Kindle 编书」；未开启 HMR 时需重启 Harness。卸载同样在插件页完成。

> 想发布到 npm？`npm publish --access public`，然后把 `market-index.json` 里该版本的 `source` 换成 `{ "type": "npm" }`，
> 安装 spec 就会变成 `dsh-plugin-kindle-book@1.0.0`。Git 方式不需要这步。

## 使用（页面）

| 字段 | 说明 |
| --- | --- |
| 文章链接 | 一行一条；`#` 开头是注释；写成 `URL \| 章节标题` 可覆盖该章标题 |
| 书名 | 同时是输出子目录名；留空则用 `新闻摘编 YYYY-MM-DD` |
| 输出目录 | 绝对路径；默认 `~/Documents/Kindle`（可用配置改） |
| AZW3 | 勾选后调用 calibre；没装 calibre 就只有 EPUB |
| 生成封面 | 对应脚本的 `--no-cover` |

生成后列出 EPUB / AZW3 / 封面，点「下载」直接存盘；抓取失败的链接单列；原始日志可展开。同一时间只允许一次构建（并发返回 409）。

### 日常流程（攒几天再编）

1. 平时刷到想读但没空看的新闻，先扔进微信收藏，不急着读。
2. 隔几天从收藏里复制链接，一次性贴进来，书名用 `新闻摘编 10月27日` 这类日期，攒 5–10 篇编一本。
3. EPUB 在电脑上看（浏览器 / Calibre / Apple Books），AZW3 走 USB 拷到 Kindle 的 `documents/`；Send to Kindle 邮箱推送不支持 AZW3，那个通道用 EPUB。
4. 没抓到的链接会在结果里单列，单独再生成一次，或直接点开原文。

## 使用（Agent）

```text
把这两个链接做成一本 kindle 书，书名《十月观察》
→ kindle_book(urls=["https://...", "https://..."], title="十月观察")
```

参数：`urls`（必填，数组）、`title`、`azw3`、`cover`、`outDir`。返回输出目录、文件列表、失败链接与日志，与页面按钮行为完全一致。

## 配置（可选）

默认无需配置。要改的话，在 profile 的 patch 里给这一行加 `config`：

```yaml
- insert:
    - id: kindle-book
      name: 'dsh-plugin-kindle-book'
      config:
        pythonPath: /opt/homebrew/bin/python3
        calibrePath: /Applications/calibre.app/Contents/MacOS/ebook-convert
        outDir: /Users/you/Documents/Kindle
        timeoutMs: 300000
        minChars: 120
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `pythonPath` | 自动探测 | 能 `import lxml` 的解释器 |
| `calibrePath` | 自动探测 | `ebook-convert` 路径；也可用环境变量 `NEWS2KINDLE_EBOOK_CONVERT` |
| `outDir` | `~/Documents/Kindle` | 页面默认输出目录 |
| `timeoutMs` | `300000` | 单次构建上限，超时终止 |
| `minChars` | `120` | 正文少于该字数视为抓取失败 |

## 接口

三条同源路由，都先过 `connection.requestRejection` 的 Host/Origin 与登录校验：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/kindle-book/env` | Python（含 lxml）、calibre、脚本、默认输出目录与限制 |
| POST | `/kindle-book/build` | `{urls, title, outDir, azw3, cover}` → 结果、失败链接、日志 |
| GET | `/kindle-book/download?id=&name=` | 下载本次构建登记过的文件；不接受任意路径 |

下载只认「本次构建登记过的文件名」，没有路径穿越入口。

## 目录结构

```
.
├── package.json        # dsh.bundle.patch + dsh.client（Web 半侧）
├── cordis.patch.yml    # 插入 id 为 kindle-book 的插件行
├── index.js            # Host：3 个 webServer 路由 + kindle_book 工具
├── client.js           # Web：侧栏入口 + 主面板页面
├── news2kindle.py      # 抓取 → EPUB → AZW3（可用 NEWS2KINDLE_EBOOK_CONVERT 指定 calibre）
├── locale/{zh,en}.json # 插件页显示的标题与描述
├── icon.svg            # 侧栏图标
├── market-index.json   # 插件市场索引（format 1），供他人添加索引后搜索安装
└── scripts/            # 自检与发布脚本
```

## 自检

```bash
node --check index.js && cp client.js /tmp/c.mjs && node --check /tmp/c.mjs
node scripts/smoke.mjs            # 离线：路由/校验/下载 404
node scripts/smoke.mjs --network  # 额外跑一次真实构建（会联网抓取）
```

## 已知限制

- **AZW3 依赖 calibre**：没有 `ebook-convert` 时只出 EPUB。
- **国际站点直连不通**：BBC / NYT / Guardian 等需要代理，否则作为失败链接列出。
- **偶发 `IncompleteRead`**：微信长文偶尔中途断流（脚本单次读取、不重试），重新生成一次即可。
- **只有文字**：图片、视频按原脚本设定丢弃。
- **一次一本**：并发构建返回 409。

## 隐私与安全

- 插件 Host 代码运行在 Harness 宿主进程内，**不受工作区沙箱限制**：它只会读取/写入你指定的输出目录，并启动本机的 Python 与 calibre。
- 没有遥测、没有外部上报；唯一的网络请求是抓取你贴进去的文章 URL。
- 路由受 Harness 的登录态与 Host/Origin 校验保护，只接受本机同源请求。

## License

[MIT](LICENSE)
