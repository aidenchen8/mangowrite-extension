import { describe, expect, it } from "vitest";

import { parseRis } from "./ris.js";

describe("parseRis", () => {
  it("maps RefMan tags to CSL fields (Chinese journal article)", () => {
    const ris = [
      "TY  - JOUR",
      "TI  - 数字化背景下非物质文化遗产的保护与利用",
      "AU  - 黄永林",
      "AU  - 谈国新",
      "JO  - 文化遗产",
      "PY  - 2015",
      "VL  - 9",
      "IS  - 1",
      "SP  - 1",
      "EP  - 10",
      "DO  - 10.1234/wh.2015.01.001",
      "AB  - 摘要内容。",
      "LA  - Chinese",
      "ER  - ",
    ].join("\n");

    const csl = parseRis(ris);
    expect(csl.type).toBe("article-journal");
    expect(csl.title).toBe("数字化背景下非物质文化遗产的保护与利用");
    expect(csl.author).toEqual([{ literal: "黄永林" }, { literal: "谈国新" }]);
    expect(csl["container-title"]).toBe("文化遗产");
    expect(csl.volume).toBe("9");
    expect(csl.issue).toBe("1");
    expect(csl.page).toBe("1-10");
    expect(csl.issued).toEqual({ "date-parts": [[2015]] });
    expect(csl.DOI).toBe("10.1234/wh.2015.01.001");
    expect(csl.language).toBe("zh");
  });

  it("splits Western 'Family, Given' authors and infers English", () => {
    const ris = ["TY  - JOUR", "TI  - A Study", "AU  - Smith, John", "PY  - 2020", "ER  -"].join(
      "\n",
    );
    const csl = parseRis(ris);
    expect(csl.author).toEqual([{ family: "Smith", given: "John" }]);
    expect(csl.language).toBe("en");
  });

  it("tolerates conference type and single page", () => {
    const csl = parseRis(["TY  - CONF", "T1  - Proc", "SP  - 42", "ER  -"].join("\n"));
    expect(csl.type).toBe("paper-conference");
    expect(csl.page).toBe("42");
  });
});
