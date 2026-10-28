#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
news2kindle.py — 把新闻网页抓成纯净正文，打包成适合 Kindle 阅读的 EPUB，
并可选调用 calibre 的 ebook-convert 生成 AZW3。

用法:
    python3 news2kindle.py urls.txt --title "书名"
    python3 news2kindle.py https://a.com/x https://b.com/y --title "书名"

urls.txt 每行一条，支持:
    https://example.com/a
    https://example.com/b | 自定义章节标题

输出:
    <outdir>/<slug>/<slug>.epub
    <outdir>/<slug>/<slug>.azw3   (加 --azw3 时)
"""

import argparse
import datetime
import hashlib
import html as htmllib
import os
import re
import shutil
import subprocess
import sys
import unicodedata
import zipfile
from urllib.parse import urlparse, urljoin
from urllib.request import Request, urlopen

from lxml import html as LH

def find_ebook_convert() -> str:
    """定位 calibre 的 ebook-convert：环境变量 > PATH > 各平台常见安装路径。"""
    override = os.environ.get("NEWS2KINDLE_EBOOK_CONVERT", "").strip()
    if override:
        return override
    found = shutil.which("ebook-convert")
    if found:
        return found
    candidates = [
        "/Applications/calibre.app/Contents/MacOS/ebook-convert",
        os.path.expanduser("~/Applications/calibre.app/Contents/MacOS/ebook-convert"),
        r"C:\Program Files\Calibre2\ebook-convert.exe",
        r"C:\Program Files (x86)\Calibre2\ebook-convert.exe",
        "/usr/bin/ebook-convert",
        "/usr/local/bin/ebook-convert",
        "/snap/bin/ebook-convert",
        "/opt/calibre/ebook-convert",
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return candidates[0]


EBOOK_CONVERT = find_ebook_convert()
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

DROP_TAGS = "//script|//style|//noscript|//iframe|//form|//nav|//aside|//footer|//header|//button|//svg|//video|//audio|//canvas"
BOILER = re.compile(
    r"(^|[-_ ])(ad|ads|advert|advertise|share|social|comment|related|recommend|"
    r"newsletter|subscribe|promo|cookie|breadcrumb|footer|header|sidebar|menu|"
    r"toolbar|banner|qrcode|popup|modal|login|signup|appdownload)([-_ ]|$)", re.I)
DATE_META = [
    "article:published_time", "og:article:published_time", "datepublished",
    "publication_date", "publishdate", "pubdate", "publish_date", "date",
    "weibo:article:create_at", "sailthru.date", "parsely-pub-date",
]


# --------------------------------------------------------------------------- #
# 抓取
# --------------------------------------------------------------------------- #
def decode_body(raw: bytes, encoding: str | None) -> str:
    for enc in filter(None, [encoding, "utf-8", "gb18030", "big5"]):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace")


def fetch(url: str, timeout: int = 30) -> str:
    req = Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": f"{urlparse(url).scheme}://{urlparse(url).netloc}/",
    })
    with urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        enc = resp.headers.get_content_charset()
    if raw[:2] == b"\x1f\x8b":
        import gzip
        raw = gzip.decompress(raw)
    return decode_body(raw, enc)


# --------------------------------------------------------------------------- #
# 正文提取
# --------------------------------------------------------------------------- #
def meta_content(doc, keys):
    for key in keys:
        nodes = doc.xpath(
            f"//meta[translate(@property,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')='{key}'"
            f" or translate(@name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')='{key}']/@content")
        for v in nodes:
            if v and v.strip():
                return v.strip()
    return ""


def clean_text(s: str) -> str:
    s = htmllib.unescape(s or "")
    s = s.replace("\u3000", " ").replace("\xa0", " ")
    return re.sub(r"[ \t\r\f\v]+", " ", s).strip()


def is_boiler(el) -> bool:
    for attr in ("class", "id", "role"):
        val = el.get(attr)
        if val and BOILER.search(val):
            return True
    return False


def clean_subtree(root):
    """只清理正文容器内部的广告/导航块。

    注意不要在整页上跑：微信公众号的 <body class="... comment_feature ...">
    会被误判成评论区，整页正文连带被删掉。
    """
    for el in root.xpath(".//*[@class or @id or @role]"):
        if str(el.tag).lower() in ("body", "html", "head"):
            continue
        if is_boiler(el):
            el.drop_tree()


def paragraph_score(p) -> float:
    """单段“像正文”的权重：长度 + 标点密度（Readability 思路）。"""
    txt = clean_text(p.text_content())
    n = len(txt)
    if n < 20:                      # 公众号常一句一段，门槛要低
        return 0.0
    marks = sum(txt.count(c) for c in "，。；、,.;!?！？")
    return (1.0 + min(marks, 6) * 0.5 + min(n / 100.0, 3.0)) * (1.0 - 0.8 * link_ratio(p))


def pick_container(doc):
    """按段落聚集度找正文容器：父节点记满分，祖父节点记半分。"""
    scores: dict = {}
    for p in doc.xpath("//p"):
        if is_boiler(p):
            continue
        s = paragraph_score(p)
        if s <= 0:
            continue
        node = p.getparent()
        if node is None:
            continue
        scores[node] = scores.get(node, 0.0) + s
        gp = node.getparent()
        if gp is not None:
            scores[gp] = scores.get(gp, 0.0) + s * 0.5
    if not scores:
        return None
    best = max(scores.values())
    # 在近似同分的候选里取最“紧”的那层，避免把整页侧栏都包进来
    near = [el for el, sc in scores.items() if sc >= best * 0.9]
    return min(near, key=lambda el: len(el.text_content()))


BLOCK_TAGS = {"p", "h2", "h3", "h4", "blockquote", "li", "pre", "dd", "dt"}
# 正文末尾的尾巴：遇到即收尾
TAIL_MARK = re.compile(
    r"^(责任编辑|责编|相关新闻|相关阅读|相关报道|推荐阅读|延伸阅读|更多精彩|"
    r"免责声明|特别声明|【纠错】|扫一扫|点击进入专题|分享到|上一篇|下一篇)")
# 夹在正文里的元信息行：跳过但继续
SKIP_LINE = re.compile(r"^(来源[:：]|稿源[:：]|编辑[:：]|作者[:：]|标签[:：]|字号[:：]|"
                       r"原标题[:：]|本文来源|文章来源|图片来源[:：])")


def link_ratio(el) -> float:
    total = len(clean_text(el.text_content()))
    if total == 0:
        return 1.0
    linked = sum(len(clean_text(a.text_content())) for a in el.xpath(".//a"))
    return linked / total


def blocks_from(container):
    blocks, last = [], ""
    for el in container.iter():
        tag = str(el.tag).lower() if isinstance(el.tag, str) else ""
        if tag not in BLOCK_TAGS or is_boiler(el):
            continue
        txt = clean_text(el.text_content())
        if not txt:
            continue
        if TAIL_MARK.match(txt):
            break                              # 版权/相关阅读等尾巴，直接收尾
        if SKIP_LINE.match(txt):
            continue
        if tag == "li" and len(txt) < 12:
            continue
        if txt.count("|") >= 3:                # 省市/频道导航条
            continue
        if tag in ("h2", "h3", "h4"):
            if len(txt) > 120:
                continue
            blocks.append(("h2" if tag != "h4" else "h3", txt))
            last = txt
            continue
        if len(txt) < 18:                      # 图注、按钮、零碎行
            if not (tag == "blockquote" and len(txt) > 8):
                continue
        if link_ratio(el) > 0.6 and len(txt) < 120:   # 纯链接行
            continue
        if txt == last:                        # 相邻重复（标题重复/分页残留）
            continue
        blocks.append(("quote" if tag == "blockquote" else ("li" if tag == "li" else "p"), txt))
        last = txt
    return blocks


WX_NOISE = re.compile(
    r"^(预览时标签不可点|继续滑动看下一个|向上滑动看下一个|微信扫一扫|长按识别二维码|"
    r"点击上方.{0,10}|扫码关注|关注该公众号|人划线|阅读原文|分享|收藏|点赞|在看|"
    r"写下你的评论|取消|知道了|轻点两下取消赞|轻点两下取消在看|留言|已同步到看一看)$")


def text_lines_from(root):
    """按 br / 块级标签断行，把没有 <p> 的公众号正文拆成段落。

    公众号排版常用 <section><span> 一行一句，段落标签极少见，
    因此这里退化为“一行一段”的文本提取。
    """
    raw = LH.tostring(root, encoding="unicode")
    raw = re.sub(r"(?i)<br[^>]*>", "\n", raw)
    raw = re.sub(r"(?i)</(p|section|div|li|h[1-6]|blockquote|tr|pre|dd|dt)>", "\n", raw)
    raw = re.sub(r"<[^>]+>", "", raw)
    raw = htmllib.unescape(raw).replace("\u3000", " ").replace("\xa0", " ")
    out = []
    for line in raw.split("\n"):
        t = re.sub(r"[ \t\r\f\v]+", " ", line).strip()
        if not t or WX_NOISE.match(t):
            continue
        if not re.search(r"[\w\u4e00-\u9fff]", t):     # 纯符号/空白行
            continue
        out.append(t)
    return [("p", t) for t in out]


def extract(url: str, page: str):
    doc = LH.fromstring(page)
    base_href = meta_content(doc, ["og:url"]) or url

    title = (meta_content(doc, ["og:title", "twitter:title"]) or
             (clean_text(doc.xpath("string(//h1[1])")) if doc.xpath("//h1") else "") or
             clean_text(doc.xpath("string(//title)")))
    title = clean_text(re.split(r"\s+[-|_—]\s+(?!.*\s[-|_—]\s+)", title)[0])
    title = re.sub(r"\s*[|｜]\s*【[^】]{0,20}】\s*$", "", title).strip()   # 公众号标题尾巴

    site = meta_content(doc, ["og:site_name"]) or urlparse(url).netloc.replace("www.", "")
    date = meta_content(doc, DATE_META)
    if not date:
        t = doc.xpath("//time/@datetime | //time/@content")
        date = t[0].strip() if t else ""
    date = normalize_date(date)
    if not date:
        # 公众号：页面 JS 里带 createTime / ct 时间戳
        m = re.search(r"createTime[\"'\s:=]+(20\d{2}-\d{1,2}-\d{1,2})", page)
        if m:
            date = normalize_date(m.group(1))
    if not date:
        m = re.search(r'var ct = "(\d{10})"', page)
        if m:
            date = datetime.datetime.fromtimestamp(int(m.group(1))).date().isoformat()
    if not date:
        # 从 URL 路径兜底（/2026/10-27/ 这类结构很常见）
        m = re.search(r"/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})/", url)
        if m:
            date = "%s-%02d-%02d" % (m.group(1), int(m.group(2)), int(m.group(3)))
    if not date:
        head = page[:40000]
        m = (re.search(r"published at (20\d{2})-(\d{1,2})-(\d{1,2})", head) or
             re.search(r"(20\d{2})-(\d{1,2})-(\d{1,2})T\d{2}:\d{2}", head))
        if m:
            date = "%s-%02d-%02d" % (m.group(1), int(m.group(2)), int(m.group(3)))
    author = meta_content(doc, ["author", "article:author", "og:article:author"])

    for bad in doc.xpath(DROP_TAGS):
        bad.drop_tree()
    for bad in doc.xpath("//figure | //*[contains(@class,'image') or contains(@class,'photo')]"):
        if len(clean_text(bad.text_content())) < 40:
            bad.drop_tree()
    body = pick_container(doc)
    blocks = []
    if body is not None:
        clean_subtree(body)
        blocks = blocks_from(body)
    if sum(len(t) for _, t in blocks) < 300:
        # 兜底 1: 公众号正文容器（常见于没有 <p>、纯 section 排版的文章）
        for wc in doc.xpath("//*[@id='js_content']")[:1]:
            blocks = text_lines_from(wc)
    if sum(len(t) for _, t in blocks) < 300:
        # 兜底 2: 全文档段落（不清整页，避免误伤）
        blocks = blocks_from(doc.body if doc.body is not None else doc)

    # 去掉与标题重复的首块（标题常被站点重复一遍）
    def same(a, b):
        return re.sub(r"\s+", "", a) == re.sub(r"\s+", "", b)
    while blocks and same(blocks[0][1], title):
        blocks = blocks[1:]
    # 去掉末尾的零碎短行
    while blocks and len(blocks[-1][1]) < 30:
        blocks.pop()

    chars = sum(len(t) for k, t in blocks if k == "p")
    return {
        "url": url,
        "base": base_href,
        "title": title or url,
        "site": site,
        "date": date,
        "author": author,
        "blocks": blocks,
        "chars": chars,
    }


def normalize_date(s: str) -> str:
    if not s:
        return ""
    s = s.strip()
    m = re.match(r"(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})", s)
    if m:
        y, mo, d = (int(g) for g in m.groups())
        return f"{y}-{mo:02d}-{d:02d}"
    try:
        dt = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.date().isoformat()
    except ValueError:
        return s[:40]


# --------------------------------------------------------------------------- #
# EPUB 组装（EPUB 3 + NCX 兼容）
# --------------------------------------------------------------------------- #
CSS = """@charset "utf-8";
body { font-family: serif; line-height: 1.65; margin: 0 0.6em; text-align: justify; }
h1 { font-size: 1.45em; line-height: 1.35; margin: 1.2em 0 0.2em; text-align: left; }
h2 { font-size: 1.12em; margin: 1.4em 0 0.4em; text-align: left; }
.meta { font-size: 0.82em; color: #666; margin: 0 0 1.4em; line-height: 1.5; text-align: left;
        border-bottom: 1px solid #ccc; padding-bottom: 0.6em; }
p { margin: 0 0 0.75em; text-indent: 0; }
blockquote { margin: 0.8em 1.2em; color: #444; font-style: italic; }
li { margin: 0 0 0.4em 1.2em; }
.sep { text-align: center; margin: 2em 0; color: #999; }
"""


def esc(s: str) -> str:
    return htmllib.escape(s, quote=False)


def build_cover(path, book_title, subtitle):
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return False
    W, H = 1200, 1800
    img = Image.new("RGB", (W, H), "#1c2b33")
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 12], fill="#c8a45c")
    font = None
    for fp in ("/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/STHeiti Medium.ttc",
               "/System/Library/Fonts/Supplemental/Songti.ttc"):
        if os.path.exists(fp):
            try:
                font = ImageFont.truetype(fp, 74)
                break
            except OSError:
                continue
    if font is None:
        return False
    # 按宽度折行：优先在「｜·/」空格等分隔处断行，避免把词拆开或末行只剩孤字
    maxw = W - 200

    def _hard_wrap(seg, w):
        out = []
        while d.textlength(seg, font=font) > w:
            k = len(seg)
            while k > 1 and d.textlength(seg[:k], font=font) > w:
                k -= 1
            out.append(seg[:k])
            seg = seg[k:]
        return out, seg

    lines, cur = [], ""
    for seg in re.split(r"(?<=[｜|·/，、；：\s])", book_title):
        if not seg:
            continue
        if d.textlength(cur + seg, font=font) <= maxw:
            cur += seg
            continue
        if cur.strip():
            lines.append(cur.strip())
        head, cur = _hard_wrap(seg, maxw)
        lines.extend(head)
    if cur.strip():
        lines.append(cur.strip())
    y = 560
    for line in lines[:8]:
        d.text((100, y), line, font=font, fill="#f4efe6")
        y += 96
    sm = ImageFont.truetype(font.path, 40) if getattr(font, "path", None) else font
    d.text((100, H - 220), subtitle, font=sm, fill="#9fb0b8")
    d.text((100, H - 150), "news2kindle", font=sm, fill="#5d7078")
    img.save(path, "PNG")
    return True


def slugify(name: str) -> str:
    s = unicodedata.normalize("NFKC", name)
    s = re.sub(r"[^\w\u4e00-\u9fff]+", "-", s).strip("-")
    return s[:60] or "kindle-news"


def build_epub(articles, book_title, author, out_path, cover_path=None):
    uid = "urn:uuid:" + hashlib.sha1(
        (book_title + "".join(a["url"] for a in articles)).encode()).hexdigest()
    modified = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    chapters, manifest, spine, nav_items, ncx_points = [], [], [], [], []
    for i, a in enumerate(articles, 1):
        cid = f"c{i:03d}"
        fid = f"{cid}.xhtml"
        meta_bits = [x for x in (a["site"], a["date"]) if x]
        if a["author"]:
            meta_bits.append(a["author"])
        meta_line = esc(" · ".join(meta_bits))
        link = esc(a["url"])
        meta_line = (meta_line + " · " if meta_line else "") + f'<a href="{link}">查看原文</a>'
        body = [f'<h1>{esc(a["title"])}</h1>',
                f'<p class="meta">{meta_line}</p>']
        for kind, text in a["blocks"]:
            if kind == "h2":
                body.append(f"<h2>{esc(text)}</h2>")
            elif kind == "quote":
                body.append(f"<blockquote><p>{esc(text)}</p></blockquote>")
            elif kind == "li":
                body.append(f"<li>{esc(text)}</li>")
            else:
                body.append(f"<p>{esc(text)}</p>")
        if i < len(articles):
            body.append('<p class="sep">* * *</p>')
        chapters.append(
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<!DOCTYPE html>\n'
            '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">\n'
            f'<head><meta charset="utf-8"/><title>{esc(a["title"])}</title>'
            '<link rel="stylesheet" type="text/css" href="style.css"/></head>\n'
            f'<body>\n<section epub:type="chapter" xmlns:epub="http://www.idpf.org/2007/ops">'
            + "\n".join(body) + "</section>\n</body>\n</html>")
        manifest.append(f'<item id="{cid}" href="{fid}" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="{cid}"/>')
        nav_items.append(f'<li><a href="{fid}">{esc(a["title"])}</a></li>')
        ncx_points.append(
            f'<navPoint id="np{i}" playOrder="{i}"><navLabel><text>{esc(a["title"])}</text></navLabel>'
            f'<content src="{fid}"/></navPoint>')

    cover_manifest, cover_meta, cover_spine = "", "", ""
    if cover_path and os.path.exists(cover_path):
        cover_manifest = '<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>'
        cover_meta = '<meta name="cover" content="cover"/>'
        cover_spine = '<itemref idref="cover-page" linear="no"/>'
        chapters.append(
            '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'
            '<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/>'
            '<title>封面</title><style>html,body{margin:0;padding:0;height:100%;}'
            'img{max-width:100%;max-height:100%;}</style></head>'
            '<body><div style="text-align:center"><img src="cover.png" alt="cover"/></div></body></html>')
        manifest.append('<item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>')

    nav = ('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'
           '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" '
           'xml:lang="zh-CN" lang="zh-CN"><head><meta charset="utf-8"/><title>目录</title>'
           '<link rel="stylesheet" type="text/css" href="style.css"/></head><body>'
           '<nav epub:type="toc" id="toc"><h1>目录</h1><ol>' + "".join(nav_items) +
           '</ol></nav></body></html>')

    ncx = ('<?xml version="1.0" encoding="utf-8"?>\n'
           '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">'
           f'<head><meta name="dtb:uid" content="{uid}"/><meta name="dtb:depth" content="1"/>'
           '<meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>'
           f'<docTitle><text>{esc(book_title)}</text></docTitle>'
           f'<navMap>{"".join(ncx_points)}</navMap></ncx>')

    opf = ('<?xml version="1.0" encoding="utf-8"?>\n'
           '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" '
           'xml:lang="zh-CN">'
           '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
           f'<dc:identifier id="bookid">{uid}</dc:identifier>'
           f'<dc:title>{esc(book_title)}</dc:title>'
           f'<dc:creator>{esc(author)}</dc:creator>'
           '<dc:language>zh-CN</dc:language>'
           f'<dc:date>{datetime.date.today().isoformat()}</dc:date>'
           '<dc:source>网页新闻合集</dc:source>'
           f'<meta property="dcterms:modified">{modified}</meta>{cover_meta}</metadata>'
           '<manifest>'
           '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
           '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
           '<item id="css" href="style.css" media-type="text/css"/>'
           + "".join(manifest) + cover_manifest +
           '</manifest>'
           f'<spine toc="ncx">{cover_spine}' + "".join(spine) + '</spine>'
           '</package>')

    container = ('<?xml version="1.0" encoding="utf-8"?>\n'
                 '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                 '<rootfiles><rootfile full-path="OEBPS/content.opf" '
                 'media-type="application/oebps-package+xml"/></rootfiles></container>')

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with zipfile.ZipFile(out_path, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", zipfile.ZIP_STORED)
        pages = list(chapters)
        with z.open("META-INF/container.xml", "w") as fh:
            fh.write(container.encode())
        names = ["OEBPS/style.css", "OEBPS/nav.xhtml", "OEBPS/toc.ncx", "OEBPS/content.opf"]
        contents = [CSS, nav, ncx, opf]
        for n, c in zip(names, contents):
            with z.open(n, "w") as fh:
                fh.write(c.encode("utf-8"))
        for i, page in enumerate(pages, 1):
            name = "OEBPS/cover.xhtml" if (cover_path and i == len(pages)) else f"OEBPS/c{i:03d}.xhtml"
            with z.open(name, "w") as fh:
                fh.write(page.encode("utf-8"))
        if cover_path and os.path.exists(cover_path):
            z.write(cover_path, "OEBPS/cover.png", zipfile.ZIP_DEFLATED)
    return out_path


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def read_urls(args):
    items = []
    for a in args:
        if a.startswith(("http://", "https://")):
            items.append(a)
        elif os.path.isfile(a):
            with open(a, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if "|" in line:
                        u, t = (x.strip() for x in line.split("|", 1))
                        items.append(f"{u} | {t}")
                    else:
                        items.append(line)
        else:
            sys.exit(f"既不是 URL 也不是文件: {a}")
    out = []
    for it in items:
        if "|" in it:
            u, t = (x.strip() for x in it.split("|", 1))
        else:
            u, t = it, ""
        out.append((u, t))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+", help="URL 或名单文件")
    ap.add_argument("--title", default="", help="书名")
    ap.add_argument("--author", default="网页摘编")
    ap.add_argument("--outdir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"))
    ap.add_argument("--azw3", action="store_true", help="同时用 calibre 转 AZW3")
    ap.add_argument("--no-cover", action="store_true")
    ap.add_argument("--min-chars", type=int, default=120, help="正文少于该字数视为失败")
    args = ap.parse_args()

    targets = read_urls(args.inputs)
    book_title = args.title or f"新闻摘编 {datetime.date.today().isoformat()}"
    slug = slugify(book_title)

    articles, failed = [], []
    for i, (url, override) in enumerate(targets, 1):
        print(f"[{i}/{len(targets)}] {url}")
        try:
            page = fetch(url)
            art = extract(url, page)
            if override:
                art["title"] = override
            if art["chars"] < args.min_chars:
                raise RuntimeError(f"只提取到 {art['chars']} 字，可能被墙/需登录/正文在 JS 里")
            articles.append(art)
            print(f"    ok  {art['chars']} 字 · {art['title'][:60]}")
        except Exception as exc:  # noqa: BLE001
            failed.append((url, str(exc)))
            print(f"    FAIL {exc}")

    if not articles:
        print("\n没有成功抓取任何文章，未生成文件。")
        return 1

    outdir = os.path.join(args.outdir, slug)
    epub_path = os.path.join(outdir, f"{slug}.epub")
    cover = None
    if not args.no_cover:
        cover = os.path.join(outdir, "_cover.png")
        os.makedirs(outdir, exist_ok=True)
        build_cover(cover, book_title, f"{len(articles)} 篇 · {datetime.date.today().isoformat()}")
        if not os.path.exists(cover):
            cover = None
    build_epub(articles, book_title, args.author, epub_path, cover)
    print(f"\nEPUB  {epub_path}  ({os.path.getsize(epub_path)/1024:.0f} KB)")

    if args.azw3:
        azw3 = os.path.join(outdir, f"{slug}.azw3")
        if not os.path.isfile(EBOOK_CONVERT):
            print(f"AZW3  跳过：找不到 calibre 的 ebook-convert（{EBOOK_CONVERT}）。\n"
                  "      安装 calibre，或用 NEWS2KINDLE_EBOOK_CONVERT 指定路径；EPUB 不受影响。")
        else:
            cmd = [EBOOK_CONVERT, epub_path, azw3, "--output-profile", "kindle",
                   "--title", book_title, "--authors", args.author]
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode == 0:
                print(f"AZW3  {azw3}  ({os.path.getsize(azw3)/1024:.0f} KB)")
            else:
                print("AZW3 转换失败:\n" + (r.stderr or r.stdout)[-1500:])

    if failed:
        print("\n未收录:")
        for u, why in failed:
            print(f"  - {u}\n    {why}")
    return 0 if articles else 1


if __name__ == "__main__":
    sys.exit(main())
