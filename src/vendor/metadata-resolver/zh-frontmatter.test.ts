// Vendored from MangoWrite's internal metadata-resolver package at export v0.1.18 - edit upstream, not here.
// 中文首页题录抽取器单测（各信号覆盖）。
// 语料形态参照真实中文期刊首页排印（西安电子科技大学学报 / 中国环境科学等）。

import { describe, expect, it } from "vitest";

import {
  extractChineseFrontmatter,
  extractChineseFrontmatterWithProvenance,
  frontmatterToCsl,
} from "./zh-frontmatter.js";

/** 一份排印齐全的中文期刊首页（页眉同行形态 + 全套标签 + 英文双语块）。 */
const FULL_FIRST_PAGE = `第39卷 第1期 西安电子科技大学学报 2012年2月

基于深度学习的图像识别研究
张 三1，李 四2
（1. 西安电子科技大学 电子工程学院，陕西 西安 710071；2. 清华大学 计算机系，北京 100084）

摘要：本文提出了一种基于深度学习的图像识别方法，实验表明该方法在公开数据集上有效。
关键词：深度学习；图像识别；卷积神经网络

中图分类号：TP391.1 文献标识码：A 文章编号：1001-2400(2012)01-0008-06
DOI:10.13328/j.cnki.jos.002345

收稿日期：2011-09-21；修回日期：2011-11-02
基金项目：国家自然科学基金资助项目(70172025)

Image Recognition via Deep Learning
ZHANG San1, LI Si2
(1. School of Electronic Engineering, Xidian University, Xi'an 710071, China)
Abstract: We propose a novel deep learning method for image recognition and evaluate it on public datasets.
Key words: deep learning; image recognition; CNN
`;

describe("extractChineseFrontmatter — 文章编号（A1）", () => {
  it("文章编号一串白送 ISSN + 年 + 期 + 首页 + 页数（止页=首页+页数-1）", () => {
    const fm = extractChineseFrontmatter("文章编号: 1001-2400(2012)01-0008-06");
    expect(fm.issn).toBe("1001-2400");
    expect(fm.year).toBe(2012);
    expect(fm.issue).toBe("1");
    expect(fm.page).toBe("8-13"); // 首页 8、页数 6
  });

  it("接受 [文章编号] 方括号形态与全角冒号/括号/连字符", () => {
    const fm = extractChineseFrontmatter("[文章编号]：1001－2400（2012）03－0100－05");
    expect(fm.issn).toBe("1001-2400");
    expect(fm.issue).toBe("3");
    expect(fm.page).toBe("100-104");
  });

  it("页数非法（0 或超界）时整条文章编号不认", () => {
    expect(extractChineseFrontmatter("文章编号: 1001-2400(2012)01-0008-00").page).toBeUndefined();
  });
});

describe("extractChineseFrontmatter — 页眉（A2）", () => {
  it("同行页眉：第39卷 第1期 刊名 2012年2月", () => {
    const fm = extractChineseFrontmatter(
      "第39卷 第1期 西安电子科技大学学报 2012年2月\n正文……",
    );
    expect(fm.volume).toBe("39");
    expect(fm.issue).toBe("1");
    expect(fm.containerTitle).toBe("西安电子科技大学学报");
    expect(fm.year).toBe(2012);
  });

  it("邻行页眉：刊名在卷期上一行，且必须在全文重复出现（页眉特征）", () => {
    const text = [
      "西安电子科技大学学报",
      "第39卷 第1期",
      "2012年2月",
      "正文第一段……",
      "西安电子科技大学学报", // 第二页页眉重复
      "第39卷 第1期",
      "正文第二段……",
    ].join("\n");
    const fm = extractChineseFrontmatter(text);
    expect(fm.volume).toBe("39");
    expect(fm.containerTitle).toBe("西安电子科技大学学报");
  });

  it("只出现一次的 CJK 短行不会被当成刊名（不是页眉）", () => {
    const fm = extractChineseFrontmatter("深度学习综述\n第39卷 第1期\n2012年2月\n正文……");
    expect(fm.containerTitle).toBeUndefined();
  });

  it("文章编号与页眉冲突时以文章编号为准", () => {
    const fm = extractChineseFrontmatter(
      "第39卷 第1期 西安电子科技大学学报 2012年2月\n文章编号: 1001-2400(2012)02-0050-04",
    );
    expect(fm.issue).toBe("2"); // 文章编号 02，不是页眉的 第1期
    expect(fm.year).toBe(2012);
    expect(fm.page).toBe("50-53");
    expect(fm.containerTitle).toBe("西安电子科技大学学报");
  });
});

describe("extractChineseFrontmatter — 标签锚定信号", () => {
  it("全套标签一次抽齐", () => {
    const fm = extractChineseFrontmatter(FULL_FIRST_PAGE);
    expect(fm.issn).toBe("1001-2400");
    expect(fm.volume).toBe("39");
    expect(fm.issue).toBe("1");
    expect(fm.page).toBe("8-13");
    expect(fm.year).toBe(2012);
    expect(fm.containerTitle).toBe("西安电子科技大学学报");
    expect(fm.clcNumber).toBe("TP391.1");
    expect(fm.documentCode).toBe("A");
    expect(fm.doi).toBe("10.13328/j.cnki.jos.002345");
    expect(fm.receivedDate).toBe("2011-09-21");
    expect(fm.funding).toContain("国家自然科学基金");
    // 值是 NFKC 归一化后的形态（全角逗号折成半角）。
    expect(fm.affiliations).toEqual([
      "西安电子科技大学 电子工程学院,陕西 西安 710071",
      "清华大学 计算机系,北京 100084",
    ]);
    expect(fm.englishTitle).toBe("Image Recognition via Deep Learning");
    expect(fm.englishAuthors).toEqual(["ZHANG San", "LI Si"]);
    expect(fm.englishAbstract).toContain("deep learning");
    expect(fm.englishKeywords).toEqual(["deep learning", "image recognition", "CNN"]);
  });

  it("CN 号各形态归一化（CN 61-1076/TN / CN:11-1912/N / CN61-1076/TN）", () => {
    expect(extractChineseFrontmatter("CN 61-1076/TN").cnNumber).toBe("61-1076/TN");
    expect(extractChineseFrontmatter("国内统一刊号 CN:11-1912/N").cnNumber).toBe("11-1912/N");
    expect(extractChineseFrontmatter("CN61-1076/tn").cnNumber).toBe("61-1076/TN");
  });

  it("ISSN 标签：文章编号缺席时补位，在场时以文章编号为准", () => {
    expect(extractChineseFrontmatter("ISSN 1001-2400").issn).toBe("1001-2400");
    const fm = extractChineseFrontmatter(
      "ISSN 2096-1146\n文章编号: 1001-2400(2012)01-0008-06",
    );
    expect(fm.issn).toBe("1001-2400");
  });

  it("收稿日期的中文年月日形态", () => {
    expect(extractChineseFrontmatter("收稿日期：2011 年 9 月 21 日").receivedDate).toBe(
      "2011-09-21",
    );
    expect(extractChineseFrontmatter("收稿日期: 2011.9.2").receivedDate).toBe("2011-09-02");
  });
});

describe("extractChineseFrontmatter — 散落信号（旧抽取器的三种形态不回归）", () => {
  it("西文形态 2021, 42(3): 156-168", () => {
    const fm = extractChineseFrontmatter("中国环境科学, 2021, 42(3): 156-168.");
    expect(fm.volume).toBe("42");
    expect(fm.issue).toBe("3");
    expect(fm.page).toBe("156-168");
  });

  it("裸 第N卷第N期 + 页码 156–168", () => {
    const fm = extractChineseFrontmatter("…… 第42卷第3期 …… 页码 156–168 ……");
    expect(fm.volume).toBe("42");
    expect(fm.issue).toBe("3");
    expect(fm.page).toBe("156-168");
  });
});

describe("extractChineseFrontmatter — 空与占位（A4）", () => {
  it("没有任何信号时返回空对象，一个键都不放", () => {
    expect(extractChineseFrontmatter("no bibliographic hints here")).toEqual({});
    expect(extractChineseFrontmatter("")).toEqual({});
  });
});

describe("frontmatterToCsl", () => {
  it("投影成 CSL-ish 字段：ISSN 数组化、year → issued.date-parts", () => {
    const fm = extractChineseFrontmatter(FULL_FIRST_PAGE);
    const csl = frontmatterToCsl(fm);
    expect(csl).toEqual({
      volume: "39",
      issue: "1",
      page: "8-13",
      ISSN: ["1001-2400"],
      "container-title": "西安电子科技大学学报",
      issued: { "date-parts": [[2012]] },
      DOI: "10.13328/j.cnki.jos.002345",
      cnNumber: undefined,
    });
    // 未抽到的键不应出现
    expect("cnNumber" in csl).toBe(false);
  });
});

describe("extractChineseFrontmatterWithProvenance — 字段级命中层次", () => {
  it("文章编号命中的字段记 article-number，页眉刊名记 header，标签记 labeled", () => {
    const { frontmatter, layers } = extractChineseFrontmatterWithProvenance(FULL_FIRST_PAGE);
    expect(layers.issn).toBe("article-number");
    expect(layers.year).toBe("article-number");
    expect(layers.issue).toBe("article-number");
    expect(layers.page).toBe("article-number");
    expect(layers.volume).toBe("header");
    expect(layers.containerTitle).toBe("header");
    expect(layers.doi).toBe("labeled");
    expect(layers.receivedDate).toBe("labeled");
    expect(layers.englishTitle).toBe("english-block");
    // frontmatter 与无 provenance 入口逐键相等（同一份规则）。
    expect(frontmatter).toEqual(extractChineseFrontmatter(FULL_FIRST_PAGE));
  });

  it("文章编号优先于页眉：冲突字段的层次不被页眉改写", () => {
    const text = "第39卷 第3期 某学报 2011年5月\n\n文章编号: 1001-2400(2012)01-0008-06";
    const { frontmatter, layers } = extractChineseFrontmatterWithProvenance(text);
    expect(frontmatter.year).toBe(2012); // 文章编号赢
    expect(layers.year).toBe("article-number");
    expect(layers.issue).toBe("article-number");
    expect(layers.volume).toBe("header"); // 文章编号没有卷，页眉补
  });

  it("散落信号补位记 scattered；无信号时 layers 也是空的", () => {
    const { frontmatter, layers } =
      extractChineseFrontmatterWithProvenance("…… 42(3): 156-168 ……");
    expect(frontmatter.volume).toBe("42");
    expect(layers.volume).toBe("scattered");
    expect(layers.page).toBe("scattered");
    expect(extractChineseFrontmatterWithProvenance("no hints").layers).toEqual({});
  });
});
