// Vendored from MangoWrite's internal metadata-resolver package at export v0.1.18 - edit upstream, not here.
import { describe, expect, it } from "vitest";

import { readMetaContents, scanTags, tagAttr } from "./html-tag.js";

describe("scanTags", () => {
  it("collects opening tags in document order", () => {
    const html = `<a href="/1">x</a> text <A HREF="/2">y</a>`;
    expect(scanTags(html, "a")).toEqual([`<a href="/1">`, `<A HREF="/2">`]);
  });

  it("does not match longer tag names sharing a prefix", () => {
    expect(scanTags("<article><meta charset=utf-8>", "a")).toEqual([]);
  });
});

describe("tagAttr", () => {
  it("reads double-quoted, single-quoted, and bare values", () => {
    expect(tagAttr(`<a href="/x" data-n=3 y='4'>`, "href")).toBe("/x");
    expect(tagAttr(`<a href="/x" data-n=3 y='4'>`, "data-n")).toBe("3");
    expect(tagAttr(`<a href="/x" data-n=3 y='4'>`, "y")).toBe("4");
  });

  it("is attribute-order agnostic and tolerates spaces around =", () => {
    expect(tagAttr(`<a data-test = "pdf-link" href='/p.pdf'>`, "href")).toBe("/p.pdf");
  });

  it("does not match attribute names containing the wanted name", () => {
    expect(tagAttr(`<meta pagename="x" content="y">`, "name")).toBeNull();
  });

  it("returns empty string for an explicitly empty value", () => {
    expect(tagAttr(`<meta name="citation_title" content="">`, "content")).toBe("");
  });
});

describe("readMetaContents", () => {
  it("reads the ACL Anthology shape: content first, unquoted name", () => {
    const html = `<meta content="https://aclanthology.org/N19-1423.pdf" name=citation_pdf_url>`;
    expect(readMetaContents(html, "citation_pdf_url")).toEqual([
      "https://aclanthology.org/N19-1423.pdf",
    ]);
  });

  it("reads the conventional shape: quoted name first", () => {
    const html = `<meta name="citation_pdf_url" content="https://x.test/a.pdf">`;
    expect(readMetaContents(html, "citation_pdf_url")).toEqual(["https://x.test/a.pdf"]);
  });

  it("matches name or property keys case-insensitively and keeps order", () => {
    const html = [
      `<meta property="citation_author" content="Liu">`,
      `<meta NAME="citation_author" content="Yin">`,
      `<meta name="citation_title" content="t">`,
    ].join("");
    expect(readMetaContents(html, "Citation_Author")).toEqual(["Liu", "Yin"]);
  });

  it("drops empty contents and leaves entity decoding to the caller", () => {
    const html = `<meta name="citation_title" content=""> <meta name="citation_title" content="A &amp; B">`;
    expect(readMetaContents(html, "citation_title")).toEqual(["A &amp; B"]);
  });

  it("finds nothing when only an unrelated key is present", () => {
    expect(readMetaContents(`<meta charset=utf-8>`, "citation_pdf_url")).toEqual([]);
  });
});
