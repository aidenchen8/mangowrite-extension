// Vendored from MangoWrite's internal metadata-resolver package at export v0.1.18 - edit upstream, not here.
// 中文首页题录抽取器 —— 「原件自证」层的引擎。
//
// 中文期刊的排印有国标：`文章编号: 1001-2400(2012)01-0008-06` 这一串 =
// ISSN + 出版年 + 期次 + 首页页码 + 页数，一条正则白送五个字段，零外部依赖。
// 页眉（`第39卷 第1期  西安电子科技大学学报  2012年2月`）再给卷/期/刊名/年。
// 本抽取器从解析产物的首页 + 页眉页脚把这些信号全部吃下来。
//
// 信号优先级：文章编号 > 页眉 > 正文散落信号。多来源冲突时以文章编号为准
// （它是排印规范的产物，最可信）。抽不到的字段留空——不写任何占位假值。
//
// 全仓只有这一份实现：apps/api（library/parse.ts）与 apps/extension
// （metadata-extract.ts）共用。纯函数、无 IO，可在 MV3 worker 里跑。

export interface ChineseFrontmatter {
  /** 卷（页眉/散落信号原文，如 "39"、"42"）。 */
  volume?: string;
  /** 期。文章编号推导的期次剥前导零（"01"→"1"）；页眉保持印刷原文。 */
  issue?: string;
  /** 页码区间 "8-13"。文章编号给的是首页 + 页数：止页 = 首页 + 页数 − 1。 */
  page?: string;
  /** 出版年（2012）。 */
  year?: number;
  /** 刊名（页眉形态，如「西安电子科技大学学报」）。 */
  containerTitle?: string;
  /** ISSN，归一化为 XXXX-XXXX。 */
  issn?: string;
  /** 国内统一刊号，归一化为 "61-1076/TN"（不带 CN 前缀）。 */
  cnNumber?: string;
  /** 首页 DOI 标签锚定的 DOI（小写归一）。期刊级 DOI（后缀=ISSN）不排除——
   *  那是调用方（身份判定）的职责，这里如实抽取。 */
  doi?: string;
  /** 中图分类号（如 "TP391.1"）。 */
  clcNumber?: string;
  /** 文献标识码（A/B/C/D/E）。 */
  documentCode?: string;
  /** 收稿日期，归一化为 YYYY-MM-DD。 */
  receivedDate?: string;
  /** 基金项目行原文（截断到 300 字符，剥掉同行的收稿日期等后缀）。 */
  funding?: string;
  /** 作者机构（括号块，含 大学/学院/研究所 等机构关键词）。 */
  affiliations?: string[];
  /** 英文题名（中文刊几乎都印双语，可反查 OpenAlex/CrossRef 补 DOI）。 */
  englishTitle?: string;
  /** 作者拼音行（可校验中文姓名切分）。 */
  englishAuthors?: string[];
  /** 英文摘要。 */
  englishAbstract?: string;
  /** 英文关键词。 */
  englishKeywords?: string[];
}

/**
 * 首页窗口：文章编号与 DOI 的锚定范围。文章编号只在首页印；DOI 窗口化是因为
 * 参考文献条目同样印 `DOI:` 标签，全文扫会把被引文献的 DOI 当成本篇身份。
 * 其余标签锚定信号（CN/ISSN/中图分类号/收稿日期/基金项目/机构）是精确锚点、
 * 全文唯一，不受此窗口限制。
 */
const HEAD_WINDOW = 6000;

/** 各类破折号/连字符（含全角），排印实测都会出现。 */
const DASH = "[-‐‑‒–—−]";

/** XXXX-XXXX 归一化；不是 8 位（含 X）返回 null。 */
function normalizeIssn(raw: string): string | null {
  const compact = raw.replace(/[^0-9xX]/g, "").toUpperCase();
  if (compact.length !== 8) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

/**
 * CN 号（国内统一刊号）归一化为 "61-1076/TN"：剥空白/零宽字符与可选的
 * CN 前缀，分类号必须是字母开头（字母 + 至多两位字母数字）。
 *
 * 这是全仓唯一的 CN 号归一化实现——服务端（venue-matching 的 CN 阶梯、
 * ranking-import 的刊表身份键）与本抽取器共用。官方名录是手工维护的表格，
 * 实测夹带零宽字符（CSCD2026 的 ISSN 列有 U+200C）；`\s` 匹配不到零宽字符，
 * 不显式剥掉的话，一个看不见的字节就让整条刊丢掉最强身份键。
 */
export function normalizeCnNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const compact = value
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/[\s\u200B-\u200F\u2060\uFEFF]+/g, "")
    .toUpperCase()
    .replace(/^CN[:：]?/, "");
  return /^\d{2}-\d{4}\/[A-Z][A-Z0-9]{0,2}$/.test(compact) ? compact : null;
}

function plausibleYear(y: number): boolean {
  return y >= 1900 && y <= 2100;
}

// 文章编号（国标 GB 编码：ISSN(YYYY)NN-PPPP-CC，CC 是页数不是止页）

// 期次 NN 1-4 位（增刊合期可能两位以上），首页页码至多 6 位，页数 1-4 位；
// 页数后不能再跟数字或连字符（防把「-06-续」这类串错切）。
const ARTICLE_NUMBER_RE =
  /(?:[\[【]?\s*文章编号\s*[\]】]?|Article\s+ID)\s*[:：]?\s*(\d{4})\s*[-‐‑‒–—−]\s*(\d{3}[\dXx])\s*[(（]\s*(\d{4})\s*[)）]\s*(\d{1,4})\s*[-‐‑‒–—−]\s*(\d{1,6})\s*[-‐‑‒–—−]\s*(\d{1,4})(?![\d‐‑‒–—−-])/i;

interface ArticleNumberParts {
  issn: string;
  year: number;
  issue: string;
  page: string;
}

function parseArticleNumber(head: string): ArticleNumberParts | null {
  const m = head.match(ARTICLE_NUMBER_RE);
  if (!m) return null;
  const issn = normalizeIssn(`${m[1]}-${m[2]}`);
  const year = Number(m[3]);
  const issueNum = Number(m[4]);
  const first = Number(m[5]);
  const count = Number(m[6]);
  if (!issn || !plausibleYear(year)) return null;
  if (issueNum < 1 || issueNum > 999) return null;
  if (first < 1 || first > 999999) return null;
  if (count < 1 || count > 999) return null;
  return {
    issn,
    year,
    issue: String(issueNum), // 剥前导零："01" → "1"
    page: `${first}-${first + count - 1}`, // 止页 = 首页 + 页数 − 1
  };
}

// 页眉：`第39卷 第1期  西安电子科技大学学报  2012年2月`

const VOLUME_TOKEN_RE = /第\s*(\d{1,4})\s*卷/;
const ISSUE_TOKEN_RE = /第\s*(\d{1,3})\s*期/;
const YEAR_TOKEN_RE = /\b(19\d{2}|20\d{2}|21\d{2})\s*年/;

/** 刊名里不该出现的字样——出现时说明这段不是刊名而是别的题区文字。 */
const NOT_A_JOURNAL_NAME_RE =
  /摘要|关键[词字]|收稿日期|修回日期|基金项目|作者简介|中图分类号|文献标[志识]码|文章编号|DOI|ISSN|CN\s*\d|Abstract|Key\s*words|http/i;

/** 从卷/期/年同行残留里清理出刊名；不像刊名（长度/字符构成/标签）返回 null。 */
function cleanHeaderName(segment: string): string | null {
  const cleaned = segment
    .replace(/第\s*\d{1,4}\s*卷/g, " ")
    .replace(/第\s*\d{1,3}\s*期/g, " ")
    .replace(/\d{4}\s*年/g, " ")
    .replace(/\d{1,2}\s*月/g, " ")
    .replace(/[\d\s\-‐‑‒–—−,，.。:：;；/\\|·〔〕\[\]【】()（）]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 2 || cleaned.length > 30) return null;
  if (!/[一-鿿]/.test(cleaned)) return null;
  // 刊名主体必须是 CJK——夹带大段拉丁字符的多半是英文题名行。
  const cjk = (cleaned.match(/[一-鿿]/g) ?? []).length;
  const latin = (cleaned.match(/[A-Za-z]/g) ?? []).length;
  if (latin > cjk) return null;
  if (NOT_A_JOURNAL_NAME_RE.test(cleaned)) return null;
  return cleaned;
}

/** 纯 CJK 短行（候选刊名行）：无数字、无标签、2-20 字、CJK 占比 ≥ 80%。 */
function looksLikeBareJournalLine(line: string): string | null {
  const t = line.trim();
  if (t.length < 2 || t.length > 20) return null;
  if (/\d/.test(t)) return null;
  if (NOT_A_JOURNAL_NAME_RE.test(t)) return null;
  if (/[。，,；;：:、？?！!《》()（）]/.test(t)) return null;
  const cjk = (t.match(/[一-鿿]/g) ?? []).length;
  if (cjk / t.length < 0.8) return null;
  return t;
}

interface HeaderParts {
  volume?: string;
  issue?: string;
  year?: number;
  containerTitle?: string;
}

/**
 * 页眉抽取。卷/期/年取第一个命中的短行；刊名两种形态：
 *   1. 同行形态——卷/期 token 与刊名印在同一行（`第39卷 第1期  X学报  2012年2月`）；
 *   2. 邻行形态——卷/期单独一行、刊名印在相邻行（居中页眉被解析器拆行）。
 *      邻行采纳的硬守卫：该 CJK 短行必须在全文出现 ≥2 次（页眉每页重复，
 *      只出现一次的 CJK 行是正文，不是页眉）。
 */
function parseHeader(text: string): HeaderParts {
  const lines = text.split("\n").map((l) => l.trim());
  const out: HeaderParts = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0 || line.length > 120) continue;
    const v = line.match(VOLUME_TOKEN_RE);
    const q = line.match(ISSUE_TOKEN_RE);
    const y = line.match(YEAR_TOKEN_RE);
    if (!v && !q && !y) continue;

    if (v && !out.volume) out.volume = v[1];
    if (q && !out.issue) out.issue = q[1];
    if (y && !out.year && plausibleYear(Number(y[1]))) out.year = Number(y[1]);

    if (!out.containerTitle && (v || q)) {
      const sameLine = cleanHeaderName(line);
      if (sameLine) {
        out.containerTitle = sameLine;
      } else {
        // 邻行形态：上/下一行是纯 CJK 短行，且在全文重复出现（页眉特征）。
        for (const j of [i - 1, i + 1]) {
          const candidate = j >= 0 && j < lines.length ? looksLikeBareJournalLine(lines[j]!) : null;
          if (!candidate) continue;
          const occurrences = text.split(candidate).length - 1;
          if (occurrences >= 2) {
            out.containerTitle = candidate;
            break;
          }
        }
      }
    }
  }
  return out;
}

// 散落信号（旧版三形态卷期页抽取的兼容形态，只补缺失字段）

const normPage = (s: string) =>
  s.replace(/\s/g, "").replace(/[‐‑‒–—−]/g, "-");

/** 标签锚定的标识符串先在扫描文本里遮蔽掉——否则「文章编号: 1001-2400(…)」
 *  里的 ISSN 片段会被页码正则当成「: 1001-2400」吞掉。 */
const LABELED_IDENTIFIER_MASK_RE = new RegExp(
  `(?:[\\[【]?\\s*文章编号[\\]】]?|Article\\s+ID|ISSN|CN|DOI)\\s*[:：]?\\s*\\S+`,
  "gi",
);

function parseScattered(text: string): { volume?: string; issue?: string; page?: string } {
  const scan = text.replace(LABELED_IDENTIFIER_MASK_RE, " ");
  const out: { volume?: string; issue?: string; page?: string } = {};
  // 42(3): 156-168（维普/西文形态）
  const vip = scan.match(
    new RegExp(`(\\d{1,4})\\s*\\(\\s*(\\d{1,3})\\s*\\)\\s*[:：]\\s*(\\d{1,6}(?:\\s*${DASH}\\s*\\d{1,6})?)`),
  );
  if (vip) {
    out.volume = vip[1];
    out.issue = vip[2];
    out.page = normPage(vip[3]!);
  }
  if (!out.page) {
    const pg = scan.match(
      new RegExp(`(?:[:：]|页码?|pp?\\.?\\s*)\\s*(\\d{1,6}\\s*${DASH}\\s*\\d{1,6})`, "i"),
    );
    if (pg) out.page = normPage(pg[1]!);
  }
  return out;
}

// 标签锚定信号
//
// 标签本身是精确锚点（文章编号/CN/ISSN/中图分类号/收稿日期/基金项目只在本篇
// 首页出现一次，页脚重复的值相同），所以不限窗口、全文扫描——服务端喂的是
// MinerU 解析文本，插件喂的是落地页 stripped text（首页信号可能被导航噪声
// 推出固定窗口）。唯一例外是 DOI：参考文献条目也印 `DOI:` 标签，必须窗口化。

function parseLabeled(
  scan: string,
  head: string,
): Pick<
  ChineseFrontmatter,
  "issn" | "cnNumber" | "doi" | "clcNumber" | "documentCode" | "receivedDate" | "funding" | "affiliations"
> {
  const out: ReturnType<typeof parseLabeled> = {};

  // ISSN 1001-2400（允许无冒号；同页可能印 print/online 两个，取第一个）
  const issnM = scan.match(new RegExp(`\\bISSN\\s*[:：]?\\s*(\\d{4}\\s*${DASH}\\s*\\d{3}[\\dXx])`, "i"));
  const issn = issnM ? normalizeIssn(issnM[1]!) : null;
  if (issn) out.issn = issn;

  // CN 61-1076/TN（国内统一刊号：CN 61-1076/TN / CN:11-1912/N / CN61-1076/TN）
  const cnM = scan.match(new RegExp(`\\bCN\\s*[:：]?\\s*(\\d{2}\\s*${DASH}\\s*\\d{4}\\s*\\/\\s*[A-Za-z0-9]{1,4})`));
  const cn = cnM ? normalizeCnNumber(cnM[1]!) : null;
  if (cn) out.cnNumber = cn;

  // DOI:10.13328/j.cnki.jos.xxx（CNKI 系刊常印）。标签锚定 + 首页窗口——参考
  // 文献条目同样印 DOI 标签，窗口化防止把被引文献的 DOI 当成本篇身份。
  const doiM = head.match(/\bDOI\s*[:：]?\s*(10\.\d{4,}(?:\.\d+)*\/[^\s;；,，。)\]]+)/i);
  if (doiM) out.doi = doiM[1]!.replace(/[.。\]\)]+$/g, "").toLowerCase();

  // 中图分类号：TP391.1 / R73 / G64（可有多个，取第一个）
  const clcM = scan.match(/中图分类号\s*[:：]?\s*([A-Z]{1,2}[\dA-Z.]*)/);
  if (clcM) out.clcNumber = clcM[1];

  // 文献标识码：A/B/C/D/E
  const docM = scan.match(/文献标[志识]码\s*[:：]?\s*([A-E])\b/);
  if (docM) out.documentCode = docM[1];

  // 收稿日期：2011-09-21 / 2011 年 9 月 21 日 / 2011.09.21 / 2011/09/21
  const recvM = scan.match(
    new RegExp(
      `收稿日期\\s*[:：]?\\s*(\\d{4})\\s*(?:${DASH}|年|[./])\\s*(\\d{1,2})\\s*(?:${DASH}|月|[./])\\s*(\\d{1,2})\\s*日?`,
    ),
  );
  if (recvM) {
    const [, y, mo, d] = recvM;
    out.receivedDate = `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }

  // 基金项目：国家自然科学基金资助项目(70172025)——剥掉同行的收稿日期等后缀
  const fundM = scan.match(/基金项目\s*[:：]?\s*([^\n]{2,300})/);
  if (fundM) {
    const line = fundM[1]!
      .split(/收稿日期|修回日期|作者简介|通讯作者|联系方式/)[0]!
      .trim()
      .replace(/[.。;；\s]+$/g, "");
    if (line.length >= 2) out.funding = line;
  }

  // 作者机构：首页括号块，含机构关键词。典型形态是一个括号里装多家：
  // （1. 西安电子科技大学 电子工程学院，陕西 西安 710071；2. 清华大学 计算机系，北京 100084）
  const affiliations: string[] = [];
  const pushAffiliation = (raw: string) => {
    const block = raw.replace(/^\d+\s*[.、]?\s*/, "").trim();
    if (block.length < 4) return;
    if (!/(大学|学院|研究所|研究院|实验室|中心|医院|公司|集团|学系)/.test(block)) return;
    if (affiliations.some((a) => a === block)) return;
    affiliations.push(block);
  };
  for (const m of scan.matchAll(/[（(]\s*([^（）()\n]{4,300}?)\s*[)）]/g)) {
    for (const part of m[1]!.split(/[;；]\s*(?=\d+\s*[.、]?)/)) pushAffiliation(part);
    if (affiliations.length >= 4) break;
  }
  if (affiliations.length > 0) out.affiliations = affiliations.slice(0, 4);

  return out;
}

// 英文双语块（常印在首页底部或全文末尾，不限首页窗口）

/** 拉丁主导行：字母里 ≥70% 是拉丁字符（允许数字、空格、标点）。 */
function isLatinDominant(line: string): boolean {
  const letters = line.match(/[A-Za-z一-鿿]/g) ?? [];
  if (letters.length < 3) return false;
  const latin = (line.match(/[A-Za-z]/g) ?? []).length;
  return latin / letters.length >= 0.7;
}

/** 作者拼音行形态：`ZHANG San, LI Si` / `Zhang San, Li Si1,2`——逗号分隔的名字串。 */
function looksLikePinyinAuthors(line: string): boolean {
  const t = line.trim().replace(/\d+/g, "");
  if (!t.includes(",") && !t.includes("，")) return false;
  if (!isLatinDominant(t)) return false;
  if (t.length > 200) return false;
  // 机构行（University/Institute/...）不是作者。
  if (/\b(University|Institute|School|College|Laboratory|Academy|Department|China)\b/i.test(t)) {
    return false;
  }
  // 每个逗号分段应是 1-4 个首字母大写（或全大写）的词——`School of ...` 里
  // 的 "of" 小写，正好把机构残片挡在门外。
  const parts = t.split(/[,，]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 12) return false;
  return parts.every((p) => {
    const words = p.split(/\s+/).filter(Boolean);
    return (
      words.length >= 1 &&
      words.length <= 4 &&
      words.every((w) => /^[A-Z][A-Za-z.'-]*$/.test(w))
    );
  });
}

function parseEnglishBlock(text: string): Pick<
  ChineseFrontmatter,
  "englishTitle" | "englishAuthors" | "englishAbstract" | "englishKeywords"
> {
  const out: ReturnType<typeof parseEnglishBlock> = {};

  // 英文摘要：Abstract: ... 到 Key words / 中图分类号 / 下一个 CJK 段。
  const absM = text.match(/\bAbstract\s*[:：]\s*([\s\S]{20,1500}?)(?=\bKey\s*words?\s*[:：]|\bCLC\b|中图分类号|$)/i);
  if (absM) {
    const abs = absM[1]!.replace(/\s+/g, " ").trim();
    // 摘要主体必须是拉丁文本（防止把中文摘要抓进来）。
    if (isLatinDominant(abs)) out.englishAbstract = abs;
  }

  // 英文关键词：Key words: xxx; yyy; zzz
  const kwM = text.match(/\bKey\s*words?\s*[:：]?\s*([^\n]{2,400})/i);
  if (kwM) {
    const line = kwM[1]!.split(/中图分类号|文献标[志识]码|CLC|文章编号|DOI/i)[0]!;
    const kws = line
      .split(/[;；]/)
      .map((k) => k.trim().replace(/[.。;；]+$/g, "").trim())
      .filter((k) => k.length >= 2 && k.length <= 60 && isLatinDominant(k));
    if (kws.length > 0) out.englishKeywords = kws.slice(0, 12);
  }

  // 英文题名与作者拼音：Abstract 标签之前的连续拉丁行。典型排印（自下而上）：
  //   [英文题名 1-2 行] [作者拼音行] [英文机构行] Abstract: ...
  // 从 Abstract 向前收集拉丁主导行，倒序里最像拼音行的记为作者，其前为题名。
  if (absM && absM.index != null) {
    const before = text.slice(Math.max(0, absM.index - 1200), absM.index);
    const latinLines = before
      .split("\n")
      .map((l) => l.trim())
      // 标签行（DOI/ISSN/中图分类号…）是拉丁主导但不是题名，剔掉。
      .filter((l) => !/(?:^|\s)(DOI|ISSN|CN|CLC)\s*[:：]?|文章编号|中图分类号|文献标[志识]码|收稿日期|基金项目/i.test(l))
      .filter((l) => l.length >= 4 && l.length <= 300 && isLatinDominant(l));
    // 倒序找拼音行（最靠近 Abstract 的那条）。
    let authorIdx = -1;
    for (let i = latinLines.length - 1; i >= 0; i--) {
      if (looksLikePinyinAuthors(latinLines[i]!)) {
        authorIdx = i;
        break;
      }
    }
    if (authorIdx >= 0) {
      out.englishAuthors = latinLines[authorIdx]!
        .split(/[,，]/)
        .map((a) => a.trim().replace(/\d+/g, "").trim())
        .filter(Boolean);
      latinLines.splice(authorIdx, 1);
    }
    // 机构行（含 Univ./Inst. 等）从题名候选里剔掉。
    const titleLines = latinLines.filter(
      (l) => !/\b(University|Institute|College|School|Academy|Laboratory|Academia|Ltd\.?|Corp\.?)\b/i.test(l),
    );
    // 题名取最后 1-2 行（多行题名的第二行紧跟第一行）。
    const picked = titleLines.slice(-2);
    if (picked.length > 0) {
      const title = picked.join(" ").replace(/\s+/g, " ").trim().replace(/[.。;；]+$/g, "");
      if (title.length >= 8) out.englishTitle = title;
    }
  }

  return out;
}

// 主入口

/**
 * 字段级命中层次分布：记录每个产出字段由哪一层
 * 信号给出。评测线据此报「文章编号 / 页眉 / 散落信号 / 标签锚定 / 英文块
 * 各贡献了多少」——这是决定「下一分往哪加」的分布，不是调试噪音。
 */
export type FrontmatterFieldLayer =
  | "article-number"
  | "header"
  | "scattered"
  | "labeled"
  | "english-block";

export type FrontmatterFieldLayers = Partial<
  Record<keyof ChineseFrontmatter, FrontmatterFieldLayer>
>;

/**
 * 带字段级命中层次的抽取入口（与 extractChineseFrontmatter 同一份规则，
 * 评测线用；生产链路不需要层次信息时用 extractChineseFrontmatter）。
 */
export function extractChineseFrontmatterWithProvenance(text: string): {
  frontmatter: ChineseFrontmatter;
  layers: FrontmatterFieldLayers;
} {
  const scan = text.normalize("NFKC").slice(0, 50_000);
  const head = scan.slice(0, HEAD_WINDOW);
  const out: ChineseFrontmatter = {};
  const layers: FrontmatterFieldLayers = {};

  // 1. 文章编号：一条正则白送 ISSN + 年 + 期 + 首页 + 页数。
  const an = parseArticleNumber(head);
  if (an) {
    out.issn = an.issn;
    out.year = an.year;
    out.issue = an.issue;
    out.page = an.page;
    layers.issn = "article-number";
    layers.year = "article-number";
    layers.issue = "article-number";
    layers.page = "article-number";
  }

  // 2. 页眉：只补文章编号没给的字段（冲突以文章编号为准）。
  const header = parseHeader(scan);
  if (header.volume !== undefined) layers.volume = "header";
  out.volume = header.volume;
  if (out.issue === undefined && header.issue !== undefined) layers.issue = "header";
  out.issue ??= header.issue;
  if (out.year === undefined && header.year !== undefined) layers.year = "header";
  out.year ??= header.year;
  if (header.containerTitle !== undefined) layers.containerTitle = "header";
  out.containerTitle = header.containerTitle;

  // 3. 散落信号（42(3): 156-168 / 页码 156-168）：最后补位。
  const scattered = parseScattered(head);
  if (out.volume === undefined && scattered.volume !== undefined) layers.volume = "scattered";
  out.volume ??= scattered.volume;
  if (out.issue === undefined && scattered.issue !== undefined) layers.issue = "scattered";
  out.issue ??= scattered.issue;
  if (out.page === undefined && scattered.page !== undefined) layers.page = "scattered";
  out.page ??= scattered.page;

  // 4. 标签锚定信号。ISSN 若文章编号已给则标签不覆盖。
  const labeled = parseLabeled(scan, head);
  if (out.issn === undefined && labeled.issn !== undefined) layers.issn = "labeled";
  out.issn ??= labeled.issn;
  out.cnNumber = labeled.cnNumber;
  out.doi = labeled.doi;
  out.clcNumber = labeled.clcNumber;
  out.documentCode = labeled.documentCode;
  out.receivedDate = labeled.receivedDate;
  out.funding = labeled.funding;
  out.affiliations = labeled.affiliations;
  for (const k of [
    "cnNumber",
    "doi",
    "clcNumber",
    "documentCode",
    "receivedDate",
    "funding",
    "affiliations",
  ] as const) {
    if (out[k] !== undefined) layers[k] = "labeled";
  }

  // 5. 英文双语块（不限首页）。
  const english = parseEnglishBlock(scan);
  Object.assign(out, english);
  for (const k of Object.keys(english) as Array<keyof ChineseFrontmatter>) {
    if (english[k as keyof typeof english] !== undefined) layers[k] = "english-block";
  }

  // 清掉 undefined，保持「抽不到 = 键不存在」的契约。
  for (const k of Object.keys(out) as Array<keyof ChineseFrontmatter>) {
    if (out[k] === undefined) delete out[k];
  }
  return { frontmatter: out, layers };
}

/**
 * 从中文文献的解析文本（首页 + 页眉页脚，调用方通常喂前 ~50k 字符）抽取
 * 首页题录。优先级：文章编号 > 页眉 > 散落信号；冲突以文章编号为准。
 * 纯函数、无 IO；抽不到的字段一律缺省，不写占位值。
 *
 * 匹配在 NFKC 归一化副本上做：全角数字/括号/连字符（１２３／（）／－）一律
 * 折叠成半角形态再抽，抽出的值本身就是干净的归一形态。
 */
export function extractChineseFrontmatter(text: string): ChineseFrontmatter {
  return extractChineseFrontmatterWithProvenance(text).frontmatter;
}

/**
 * 把抽取结果投影成 CSL-ish 字段，供 works 回填 / source 快照 / 插件 PartialCsl
 * 直接消费。只含身份与引用字段；机构、基金、英文块等补充信号不在此投影里。
 */
export function frontmatterToCsl(fm: ChineseFrontmatter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (fm.volume) out.volume = fm.volume;
  if (fm.issue) out.issue = fm.issue;
  if (fm.page) out.page = fm.page;
  if (fm.issn) out.ISSN = [fm.issn];
  if (fm.containerTitle) out["container-title"] = fm.containerTitle;
  if (fm.year) out.issued = { "date-parts": [[fm.year]] };
  if (fm.doi) out.DOI = fm.doi;
  if (fm.cnNumber) out.cnNumber = fm.cnNumber;
  return out;
}
