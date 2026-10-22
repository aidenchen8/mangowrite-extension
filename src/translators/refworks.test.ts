import { describe, expect, it } from "vitest";

import { parseRefworks } from "./refworks.js";

describe("parseRefworks", () => {
  // CNKI's ShowExport spelling.
  it("reads CNKI's tags", () => {
    const csl = parseRefworks(
      ["RT Journal Article", "T1 某研究", "A1 张三;李四", "JF 计算机学报", "YR 2023", "SP 100", "OP 112"].join("\n"),
    );
    expect(csl.title).toBe("某研究");
    expect(csl.author).toEqual([{ literal: "张三" }, { literal: "李四" }]);
    expect(csl.page).toBe("100-112");
  });

  // CQVIP suffixes the same document types with " Article". Matching exactly
  // would silently file a conference paper as a journal article.
  it("maps CQVIP's ` Article`-suffixed types onto the same CSL types", () => {
    expect(parseRefworks("RT Conference Proceeding Article\nT1 x").type).toBe("paper-conference");
    expect(parseRefworks("RT Dissertation Article\nT1 x").type).toBe("thesis");
    expect(parseRefworks("RT Journal Article\nT1 x").type).toBe("article-journal");
  });

  it("falls back to article-journal for an unknown type", () => {
    expect(parseRefworks("RT Sound Recording\nT1 x").type).toBe("article-journal");
  });

  // The tag/value separator is a single space. RIS's ` - ` form matches nothing,
  // which is exactly how the CQVIP translator was silently returning empty.
  it("does not parse RIS lines", () => {
    expect(parseRefworks("TY  - JOUR\nTI  - 某研究").title).toBeUndefined();
  });
});
