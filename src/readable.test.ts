import { describe, expect, it } from "vitest";

import { extractReadableHtml, textLength } from "./readable.js";

describe("extractReadableHtml", () => {
  it("prefers <article> main content", () => {
    const body = "x".repeat(300);
    const html = `<body><nav>menu</nav><article><p>${body}</p></article><footer>f</footer></body>`;
    const readable = extractReadableHtml(html);
    expect(readable).toContain(body);
    expect(readable).not.toContain("menu");
  });

  it("falls back to body with chrome stripped", () => {
    const body = "y".repeat(300);
    const html = `<body><script>bad()</script><nav>menu</nav><div>${body}</div></body>`;
    const readable = extractReadableHtml(html);
    expect(readable).toContain(body);
    expect(readable).not.toContain("bad()");
    expect(readable).not.toContain("menu");
  });
});

describe("textLength", () => {
  it("counts visible text only", () => {
    expect(textLength("<p>hello <b>world</b></p>")).toBe("hello world".length);
  });
});
