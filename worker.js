// RoyalRoad → EPUB Cloudflare Worker
// Scrapes a RoyalRoad fiction and returns a well-formed EPUB file

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const DELAY_MS = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Entry point ────────────────────────────────────────────────────────────

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const storyUrl = url.searchParams.get("url");
    const startRaw = url.searchParams.get("start")?.trim();
    const endRaw = url.searchParams.get("end")?.trim();
    const startChapter = startRaw && /^\d+$/.test(startRaw) ? parseInt(startRaw, 10) : null;
    const endChapter = endRaw && /^\d+$/.test(endRaw) ? parseInt(endRaw, 10) : null;

    if (!storyUrl) {
      return new Response(
        JSON.stringify({ error: "Missing ?url= parameter" }),
        { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    // Validate it's a RoyalRoad URL
    if (!storyUrl.match(/royalroad\.com\/fiction\/\d+/i)) {
      return new Response(
        JSON.stringify({ error: "URL must be a RoyalRoad fiction URL" }),
        { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    try {
      const epub = await buildEpub(storyUrl, startChapter, endChapter);
      const filename = epub.filename;
      const epubBytes = epub.bytes;

      return new Response(epubBytes, {
        status: 200,
        headers: {
          "Content-Type": "application/epub+zip",
          "Content-Disposition": `attachment; filename="${filename}"`,
          ...CORS_HEADERS,
        },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
  },
};

// ─── Scraping ────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

function extractMeta(html) {
  const title =
    html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)?.[1] ||
    html.match(/<title>([^<]+)<\/title>/i)?.[1]?.replace(/ \| Royal Road.*$/i, "") ||
    "Unknown Title";

  const author =
    html.match(/<meta\s+property="books:author"\s+content="([^"]+)"/i)?.[1] ||
    html.match(/class="author"[^>]*>\s*(?:by\s*)?<[^>]+>([^<]+)</i)?.[1] ||
    "Unknown Author";

  const description =
    html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i)?.[1] ||
    "";

  const coverUrl =
    html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)?.[1] || null;

  return {
    title: decodeHtmlEntities(title.trim()),
    author: decodeHtmlEntities(author.trim()),
    description: decodeHtmlEntities(description.trim()),
    coverUrl,
  };
}

function extractChapterList(html) {
  const chapters = [];

  // RoyalRoad stores chapter list in a <script> tag as a JS array
  const scriptMatch = html.match(/window\.chapters\s*=\s*(\[[\s\S]*?\]);/);
  if (scriptMatch) {
    try {
      const raw = JSON.parse(scriptMatch[1]);
      for (const ch of raw) {
        if (ch.url && ch.title) {
          chapters.push({
            title: decodeHtmlEntities(ch.title.trim()),
            url: ch.url.startsWith("http") ? ch.url : `https://www.royalroad.com${ch.url}`,
          });
        }
      }
      if (chapters.length > 0) return chapters;
    } catch (_) {
      // fall through to HTML parsing
    }
  }

  // Fallback: parse chapter list from HTML table
  const chapterRowRegex =
    /<tr[^>]*data-url="([^"]+)"[^>]*>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/gi;
  let match;
  while ((match = chapterRowRegex.exec(html)) !== null) {
    const url = match[1].startsWith("http")
      ? match[1]
      : `https://www.royalroad.com${match[1]}`;
    const title = decodeHtmlEntities(stripTags(match[2]).trim());
    if (title) chapters.push({ title, url });
  }

  return chapters;
}

function extractChapterContent(html) {
  // Get the main chapter content div
  const contentMatch = html.match(
    /<div[^>]+class="[^"]*chapter-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<div|<script|<footer)/i
  );
  if (!contentMatch) {
    // Broader fallback
    const fallback = html.match(/<div[^>]+class="[^"]*chapter-content[^"]*"[^>]*>([\s\S]*)/i);
    if (!fallback) return "<p>Content could not be extracted.</p>";
    const end = fallback[1].indexOf('class="author-note"');
    return end > -1 ? fallback[1].substring(0, end) : fallback[1].substring(0, 50000);
  }

  let content = contentMatch[1];

  // Strip author notes (before and after chapter)
  content = content.replace(/<div[^>]*class="[^"]*author-note[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "");
  content = content.replace(/<div[^>]*class="[^"]*portlet[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "");

  // Strip scripts and styles
  content = content.replace(/<script[\s\S]*?<\/script>/gi, "");
  content = content.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Clean up empty paragraphs and excessive whitespace
  content = content.replace(/<p[^>]*>\s*<\/p>/gi, "");
  content = content.replace(/\n{3,}/g, "\n\n");

  return content.trim();
}

// ─── EPUB Construction ───────────────────────────────────────────────────────

async function buildEpub(storyUrl, startChapter, endChapter) {
  // 1. Fetch story index page
  const indexHtml = await fetchPage(storyUrl);
  const meta = extractMeta(indexHtml);
  let chapters = extractChapterList(indexHtml);

  if (chapters.length === 0) {
    throw new Error("Could not find any chapters. The story may be private or the URL is wrong.");
  }

  // 2. Apply chapter range (1-indexed, inclusive)
  const start = startChapter ? Math.max(1, startChapter) : 1;
  const end = endChapter ? Math.min(endChapter, chapters.length) : chapters.length;
  chapters = chapters.slice(start - 1, end);

  if (chapters.length === 0) {
    throw new Error(`No chapters in range ${start}–${end}. Story has ${chapters.length} chapters.`);
  }

  // 3. Fetch cover image
  let coverData = null;
  let coverMime = "image/jpeg";
  if (meta.coverUrl) {
    try {
      const coverRes = await fetch(meta.coverUrl);
      if (coverRes.ok) {
        const ct = coverRes.headers.get("content-type") || "image/jpeg";
        coverMime = ct.split(";")[0].trim();
        coverData = await coverRes.arrayBuffer();
      }
    } catch (_) {
      // cover fetch failed, continue without it
    }
  }

  // 4. Fetch all chapters
  const chapterContents = [];
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    try {
      const html = await fetchPage(ch.url);
      const content = extractChapterContent(html);
      chapterContents.push({ title: ch.title, content });
    } catch (err) {
      chapterContents.push({
        title: ch.title,
        content: `<p><em>Failed to load this chapter: ${err.message}</em></p>`,
      });
    }
    if (i < chapters.length - 1) await sleep(DELAY_MS);
  }

  // 5. Build EPUB zip
  const safeTitle = meta.title.replace(/[^\w\s-]/g, "").trim();
  const safeAuthor = meta.author.replace(/[^\w\s-]/g, "").trim();
  const filename = `${safeTitle} - ${safeAuthor}.epub`
    .replace(/\s+/g, " ")
    .replace(/ - $/, "")
    .trim();

  const uid = `royalroad-${Date.now()}`;
  const epubBytes = await buildEpubZip({
    title: meta.title,
    author: meta.author,
    description: meta.description,
    uid,
    coverData,
    coverMime,
    chapters: chapterContents,
    startChapterNum: start,
  });

  return { filename, bytes: epubBytes };
}

// ─── ZIP / EPUB Packaging ────────────────────────────────────────────────────

async function buildEpubZip({ title, author, description, uid, coverData, coverMime, chapters, startChapterNum }) {
  const files = [];

  // mimetype (must be first, uncompressed)
  files.push({ name: "mimetype", data: strToBytes("application/epub+zip"), compress: false });

  // META-INF/container.xml
  files.push({
    name: "META-INF/container.xml",
    data: strToBytes(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`),
  });

  // Cover
  const hasCover = coverData !== null;
  if (hasCover) {
    files.push({ name: "OEBPS/images/cover.jpg", data: coverData });
  }

  // Cover XHTML
  if (hasCover) {
    files.push({
      name: "OEBPS/cover.xhtml",
      data: strToBytes(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Cover</title>
<style>body{margin:0;padding:0;} img{max-width:100%;}</style>
</head>
<body><div><img src="images/cover.jpg" alt="Cover"/></div></body>
</html>`),
    });
  }

  // Title page
  files.push({
    name: "OEBPS/titlepage.xhtml",
    data: strToBytes(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXml(title)}</title>
<style>
  body { font-family: serif; text-align: center; padding: 2em; }
  h1 { font-size: 2em; margin-bottom: 0.5em; }
  h2 { font-size: 1.3em; font-weight: normal; color: #555; }
  p  { font-size: 0.95em; color: #444; margin-top: 2em; text-align: left; }
</style>
</head>
<body>
  <h1>${escapeXml(title)}</h1>
  <h2>${escapeXml(author)}</h2>
  ${description ? `<p>${escapeXml(description)}</p>` : ""}
</body>
</html>`),
  });

  // Chapter XHTML files
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const chNum = startChapterNum + i;
    files.push({
      name: `OEBPS/chapter${i + 1}.xhtml`,
      data: strToBytes(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXml(ch.title)}</title>
<style>
  body { font-family: serif; line-height: 1.7; margin: 1em 1.5em; }
  h1 { font-size: 1.4em; margin-bottom: 1.2em; border-bottom: 1px solid #ddd; padding-bottom: 0.4em; }
  p { margin: 0 0 1em 0; text-indent: 1.2em; }
  p:first-of-type { text-indent: 0; }
  img { max-width: 100%; }
</style>
</head>
<body>
  <h1>Chapter ${chNum}: ${escapeXml(ch.title)}</h1>
  ${ch.content}
</body>
</html>`),
    });
  }

  // stylesheet (referenced by OPF)
  files.push({
    name: "OEBPS/style.css",
    data: strToBytes("body { font-family: serif; }"),
  });

  // content.opf
  const manifestItems = [];
  const spineItems = [];

  if (hasCover) {
    manifestItems.push(`<item id="cover-img" href="images/cover.jpg" media-type="${escapeXml(coverMime)}" properties="cover-image"/>`);
    manifestItems.push(`<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="cover" linear="no"/>`);
  }

  manifestItems.push(`<item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml"/>`);
  spineItems.push(`<itemref idref="titlepage"/>`);

  for (let i = 0; i < chapters.length; i++) {
    manifestItems.push(`<item id="ch${i + 1}" href="chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="ch${i + 1}"/>`);
  }

  manifestItems.push(`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);
  manifestItems.push(`<item id="css" href="style.css" media-type="text/css"/>`);

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator opf:role="aut">${escapeXml(author)}</dc:creator>
    <dc:identifier id="bookid">${uid}</dc:identifier>
    <dc:language>en</dc:language>
    <dc:description>${escapeXml(description)}</dc:description>
    <dc:source>https://www.royalroad.com</dc:source>
  </metadata>
  <manifest>
    ${manifestItems.join("\n    ")}
  </manifest>
  <spine toc="ncx">
    ${spineItems.join("\n    ")}
  </spine>
</package>`;

  files.push({ name: "OEBPS/content.opf", data: strToBytes(opf) });

  // toc.ncx
  const navPoints = [];
  navPoints.push(`<navPoint id="titlepage" playOrder="1">
      <navLabel><text>${escapeXml(title)}</text></navLabel>
      <content src="titlepage.xhtml"/>
    </navPoint>`);

  for (let i = 0; i < chapters.length; i++) {
    const chNum = startChapterNum + i;
    navPoints.push(`<navPoint id="ch${i + 1}" playOrder="${i + 2}">
      <navLabel><text>Ch. ${chNum}: ${escapeXml(chapters[i].title)}</text></navLabel>
      <content src="chapter${i + 1}.xhtml"/>
    </navPoint>`);
  }

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${uid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
    ${navPoints.join("\n    ")}
  </navMap>
</ncx>`;

  files.push({ name: "OEBPS/toc.ncx", data: strToBytes(ncx) });

  // Assemble ZIP
  return buildZip(files);
}

// ─── Minimal ZIP implementation ──────────────────────────────────────────────

function strToBytes(str) {
  return new TextEncoder().encode(str);
}

function u32le(n) {
  const b = new Uint8Array(4);
  b[0] = n & 0xff; b[1] = (n >> 8) & 0xff;
  b[2] = (n >> 16) & 0xff; b[3] = (n >> 24) & 0xff;
  return b;
}

function u16le(n) {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}

function crc32(data) {
  const table = crc32Table();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let _crc32Table = null;
function crc32Table() {
  if (_crc32Table) return _crc32Table;
  _crc32Table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    _crc32Table[i] = c;
  }
  return _crc32Table;
}

function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    const src = a instanceof ArrayBuffer ? new Uint8Array(a) : a;
    out.set(src, offset);
    offset += src.byteLength;
  }
  return out;
}

async function deflate(data) {
  const ds = new DecompressionStream("deflate-raw");
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();
  const compressed = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(compressed);
}

async function buildZip(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    let data = file.data instanceof ArrayBuffer ? new Uint8Array(file.data) : file.data;
    const crc = crc32(data);
    const uncompressedSize = data.length;

    let compressedData = data;
    let method = 0; // stored

    if (file.compress !== false && data.length > 0) {
      try {
        const deflated = await deflate(data);
        if (deflated.length < data.length) {
          compressedData = deflated;
          method = 8; // deflated
        }
      } catch (_) {
        // fall back to stored
      }
    }

    const compressedSize = compressedData.length;

    // Local file header
    const local = concat(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // signature
      u16le(method === 8 ? 20 : 10),             // version needed
      u16le(0),                                   // flags
      u16le(method),                              // compression
      u16le(0), u16le(0),                         // mod time/date
      u32le(crc),
      u32le(compressedSize),
      u32le(uncompressedSize),
      u16le(nameBytes.length),
      u16le(0),                                   // extra field length
      nameBytes,
      compressedData
    );

    localHeaders.push(local);

    // Central directory header
    const central = concat(
      new Uint8Array([0x50, 0x4b, 0x01, 0x02]), // signature
      u16le(20),                                  // version made by
      u16le(method === 8 ? 20 : 10),             // version needed
      u16le(0),                                   // flags
      u16le(method),
      u16le(0), u16le(0),                         // mod time/date
      u32le(crc),
      u32le(compressedSize),
      u32le(uncompressedSize),
      u16le(nameBytes.length),
      u16le(0),                                   // extra
      u16le(0),                                   // comment
      u16le(0),                                   // disk start
      u16le(0),                                   // internal attr
      u32le(0),                                   // external attr
      u32le(offset),
      nameBytes
    );

    centralHeaders.push(central);
    offset += local.byteLength;
  }

  const centralDir = concat(...centralHeaders);
  const centralSize = centralDir.byteLength;

  const eocd = concat(
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    u16le(0), u16le(0),
    u16le(files.length),
    u16le(files.length),
    u32le(centralSize),
    u32le(offset),
    u16le(0)
  );

  return concat(...localHeaders, centralDir, eocd);
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function stripTags(str) {
  return str.replace(/<[^>]+>/g, "");
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/gi, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&nbsp;/gi, " ");
}
