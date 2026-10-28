# Kindle 编书 · news2kindle

把新闻 / 文章网页抓成纯净正文（去导航、广告、相关阅读），打包成 **EPUB**，再可用本机 calibre 转成 **AZW3** 拷进 Kindle 离线阅读。

两个入口走同一套逻辑：
- **命令行脚本**：`news2kindle.py`（网页 → EPUB → AZW3）
- **Harness 插件**：侧栏「Kindle 编书」页面 + Agent 的 `kindle_book` 工具

> 本仓库从 AltChat 仓库独立而来（原 `dsh-plugins/kindle-book/` 插件检出 + `data/kindle/` 脚本与数据）。
> 插件本体另有上游仓库：<https://github.com/wanghs09/dsh-plugin-kindle-book>

---

## 目录结构

```
kindle-book/
├── news2kindle.py      # 主脚本：抓取 → 纯净正文 → EPUB →（可选）AZW3
├── index.js            # Harness 插件 Host：3 个 webServer 路由 + kindle_book 工具
├── client.js           # Harness 插件 Web：侧栏入口 + 主面板页面
├── package.json        # dsh.bundle.patch + dsh.client
├── cordis.patch.yml    # 插入 id 为 kindle-book 的插件行
├── market-index.json   # 插件市场索引（format 1）
├── locale/{zh,en}.json # 插件页标题与描述
├── icon.svg            # 侧栏图标
├── scripts/            # 自检（smoke.mjs）与发布（publish.sh）
├── docs/plugin.md      # 插件详细文档（安装/页面/Agent/配置/接口/自检/安全）
├── data/
│   ├── urls.txt                  # 文章链接清单（每行一条，| 可覆盖章节标题，# 注释）
│   ├── urls-2026-10-27-ai-market.txt  # 示例：AI 与市场主题合集
│   └── out/                      # 生成的读物（git 忽略）
└── .gitignore
```

---

## 命令行用法

```bash
# 直接给链接
python3 news2kindle.py https://a.com/1 https://b.com/2 --title "十月新闻" --azw3

# 或读取链接清单（每行一条，可用 | 覆盖章节标题）
python3 news2kindle.py urls.txt --title "十月新闻" --azw3
```

`urls.txt` 示例：

```
https://news.sina.com.cn/c/2026-10-26/doc-xxx.shtml
https://www.chinanews.com.cn/cj/2026/10-27/10721502.shtml | 统计局：工业利润
# 井号开头是注释
```

输出在 `out/<书名>/`：`.epub`、`.azw3`；`--no-cover` 可不要封面。

| 参数 | 作用 |
| --- | --- |
| `--title` | 书名，也是输出目录名 |
| `--author` | 作者字段，默认「网页摘编」 |
| `--azw3` | 同时调用 calibre 生成 AZW3 |
| `--no-cover` | 不生成封面 |
| `--min-chars` | 正文低于该字数视为抓取失败，默认 120 |

> 脚本自动定位 calibre：环境变量 `NEWS2KINDLE_EBOOK_CONVERT` → `PATH` → 各平台常见安装路径；找不到时跳过 AZW3、只出 EPUB 并提示。

---

## Harness 插件

插件详细文档见 [`docs/plugin.md`](docs/plugin.md)。快速上手：

- **安装**（插件页完成，不要手工改 profile 的 `package.json`）：
  - 插件市场：添加索引 `https://raw.githubusercontent.com/wanghs09/dsh-plugin-kindle-book/main/market-index.json` → 搜「Kindle」
  - GitHub：填 `git+https://github.com/wanghs09/dsh-plugin-kindle-book.git`
  - 本地目录：选本仓库
- **页面**：侧栏「Kindle 编书」→ 粘贴链接、填书名、选输出目录、勾选 AZW3 → 生成 → 下载（保留中文文件名）。
- **Agent**：`kindle_book(urls=["https://...", "https://..."], title="《十月观察》")`。
- **接口**：`GET /kindle-book/env`、`POST /kindle-book/build`、`GET /kindle-book/download?id=&name=`（同源、需登录态，下载只认本次构建登记过的文件名）。

### 日常流程（攒几天再编）

1. 平时刷到想读但没空看的新闻，先扔进微信收藏，不急着读。
2. 隔几天从收藏里复制链接，一次性贴进来，书名用 `新闻摘编 10月27日` 这类日期，攒 5–10 篇编一本。
3. EPUB 在电脑上看（浏览器 / Calibre / Apple Books），AZW3 走 USB 拷到 Kindle 的 `documents/`；Send to Kindle 邮箱推送不支持 AZW3，那个通道用 EPUB。
4. 没抓到的链接会在结果里单列，单独再生成一次，或直接点开原文。

---

## 依赖与限制

| 依赖 | 是否必需 | 说明 |
| --- | --- | --- |
| Python 3.10+ 与 `lxml` | 必需 | `python3 -m pip install --user lxml` |
| [calibre](https://calibre-ebook.com/) | 可选 | 只有 AZW3 需要；缺了就只出 EPUB |
| DSH `>= 0.2.1-0` | 插件必需 | 用到 webServer 路由、侧栏槽位与工具注册 |

- 国际站点（BBC / NYT / Guardian 等）本机直连不通，需代理；微信长文偶发 `IncompleteRead`，重新生成即可。
- 付费墙、纯 JS 渲染的页面会抓不到正文，脚本会报 `FAIL` 并列出来。
- 只保留文字，图片和视频一律丢弃。
- 插件并发构建返回 409（一次一本）。

---

## 数据

`data/urls.txt` 与 `data/urls-2026-10-27-ai-market.txt` 是待编书的链接清单（内容为个人积累，非仓库代码）；生成的读物在 `data/out/`（git 忽略，不入库）。

---

## License

[MIT](LICENSE)
