import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";

import { buildSingleFileHtml } from "./single-file.js";

// Node-side tests drive buildSingleFileHtml with a linkedom document; the
// CSSOM (document.styleSheets) doesn't exist there, so each test stubs the
// stylesheet list and the css text reader.

interface StubSheet {
  href: string | null;
  cssText: string;
  crossOrigin?: boolean;
  media?: string;
}

function makeDoc(html: string, sheets: StubSheet[]): {
  doc: Document;
  readSameOriginCss: (sheet: { href: string | null }) => string;
} {
  const { document } = parseHTML(html);
  const byHref = new Map(sheets.map((s) => [s.href, s]));
  // No CSSOM in linkedom: hand the builder a minimal styleSheets duck.
  Object.defineProperty(document, "styleSheets", {
    value: sheets.map((s) => ({
      href: s.href,
      media: s.media == null ? undefined : { mediaText: s.media },
    })),
    configurable: true,
  });
  const readSameOriginCss = (sheet: { href: string | null }) => {
    const stub = byHref.get(sheet.href);
    if (stub?.crossOrigin) throw new Error("SecurityError");
    return stub?.cssText ?? "";
  };
  return { doc: document as unknown as Document, readSameOriginCss };
}

const PAGE_URL = "https://example.com/post/42";

describe("buildSingleFileHtml", () => {
  it("strips scripts, noscript, iframes and inline event handlers", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head><script src="/app.js"></script></head>
       <body onclick="track()"><p onmouseover="hover()">hi</p>
       <noscript>enable js</noscript><iframe src="/ad"></iframe></body></html>`,
      [],
    );
    const out = await buildSingleFileHtml(doc, PAGE_URL, { readSameOriginCss });
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<noscript");
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onmouseover");
    expect(out).toContain("<p>hi</p>");
  });

  it("removes CSP and refresh meta tags but keeps other meta", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head>
         <meta charset="utf-8">
         <meta http-equiv="Content-Security-Policy" content="style-src 'self'">
         <meta http-equiv="refresh" content="5;url=/next">
       </head><body></body></html>`,
      [],
    );
    const out = await buildSingleFileHtml(doc, PAGE_URL, { readSameOriginCss });
    expect(out).toContain('charset="utf-8"');
    expect(out).not.toContain("Content-Security-Policy");
    expect(out).not.toContain("refresh");
  });

  it("injects an absolutized <base href> at the top of <head>", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head><title>t</title></head><body><img src="/a.png"></body></html>`,
      [],
    );
    const out = await buildSingleFileHtml(doc, PAGE_URL, { readSameOriginCss });
    expect(out).toContain(`<head><base href="${PAGE_URL}"><title>`);
  });

  it("replaces an existing relative <base> with the absolutized page base", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head><base href="/static/"></head><body></body></html>`,
      [],
    );
    const out = await buildSingleFileHtml(doc, PAGE_URL, { readSameOriginCss });
    expect(out).toContain(`<base href="https://example.com/static/">`);
    expect(out.match(/<base /g)).toHaveLength(1);
  });

  it("bakes same-origin stylesheets into in-place <style> blocks, in order", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head>
         <link rel="stylesheet" href="/first.css">
         <style>.inline-keep { color: green; }</style>
         <link rel="stylesheet" href="https://example.com/second.css" media="print">
       </head><body></body></html>`,
      [
        { href: "https://example.com/first.css", cssText: ".first { color: red; }" },
        { href: "https://example.com/second.css", cssText: ".second { color: blue; }" },
      ],
    );
    const out = await buildSingleFileHtml(doc, PAGE_URL, { readSameOriginCss });
    expect(out).not.toContain('rel="stylesheet"');
    expect(out).toContain('data-mango-inline="https://example.com/first.css"');
    expect(out).toContain('.first { color: red; }');
    expect(out).toContain('data-mango-inline="https://example.com/second.css"');
    expect(out).toContain('media="print"');
    expect(out).toContain('.second { color: blue; }');
    // Inline <style> elements are left untouched, and cascade order is kept:
    // first.css < .inline-keep < second.css in the serialized head.
    expect(out.indexOf("first.css")).toBeLessThan(out.indexOf("inline-keep"));
    expect(out.indexOf("inline-keep")).toBeLessThan(out.indexOf("second.css"));
  });

  it("fetches cross-origin stylesheets through the injected fetcher", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head><link rel="stylesheet" href="https://cdn.example.com/x.css"></head><body></body></html>`,
      [{ href: "https://cdn.example.com/x.css", cssText: "", crossOrigin: true }],
    );
    const fetched: string[] = [];
    const out = await buildSingleFileHtml(doc, PAGE_URL, {
      readSameOriginCss,
      fetchCrossOriginCss: async (href) => {
        fetched.push(href);
        return ".cdn { display: block; }";
      },
    });
    expect(fetched).toEqual(["https://cdn.example.com/x.css"]);
    expect(out).toContain(".cdn { display: block; }");
    expect(out).not.toContain('rel="stylesheet"');
  });

  it("keeps the <link> when a cross-origin fetch fails (base href fallback)", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head><link rel="stylesheet" href="https://cdn.example.com/y.css"></head><body></body></html>`,
      [{ href: "https://cdn.example.com/y.css", cssText: "", crossOrigin: true }],
    );
    const out = await buildSingleFileHtml(doc, PAGE_URL, {
      readSameOriginCss,
      fetchCrossOriginCss: async () => null,
    });
    expect(out).toContain('rel="stylesheet"');
    expect(out).toContain(`<base href="${PAGE_URL}">`);
  });

  it("never mutates the live document", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head><script src="/app.js"></script></head><body><p>hi</p></body></html>`,
      [],
    );
    await buildSingleFileHtml(doc, PAGE_URL, { readSameOriginCss });
    const liveHtml = doc.documentElement!.outerHTML;
    expect(liveHtml).toContain("<script");
    expect(liveHtml).not.toContain("<base");
  });

  it("strips javascript:/vbscript: URLs but keeps https links", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head></head><body>
         <a href="javascript:steal()">x</a>
         <a href=" JAVASCRIPT:steal()">y</a>
         <a href="https://example.com/ref">z</a>
         <form action="javascript:steal()"><p>inner</p></form>
       </body></html>`,
      [],
    );
    const out = await buildSingleFileHtml(doc, PAGE_URL, { readSameOriginCss });
    expect(out).not.toContain("javascript:");
    expect(out).toContain('href="https://example.com/ref"');
    // forms are unwrapped: the tag is gone, the children stay
    expect(out).not.toContain("<form");
    expect(out).toContain("<p>inner</p>");
  });

  it("drops media src/srcset but keeps the element and poster handling", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head></head><body>
         <video src="/v.mp4" poster="/p.png"><source src="/v.webm"><track src="/t.vtt"></video>
         <audio src="/a.mp3"></audio>
       </body></html>`,
      [],
    );
    const out = await buildSingleFileHtml(doc, PAGE_URL, { readSameOriginCss });
    expect(out).not.toContain("/v.mp4");
    expect(out).not.toContain("/v.webm");
    expect(out).not.toContain("/t.vtt");
    expect(out).not.toContain("/a.mp3");
    expect(out).toContain("<video");
    expect(out).toContain("<audio");
  });

  const PNG = "data:image/png;base64,iVBORw0KGgo=";

  it("inlines img src, the dpr-selected srcset candidate and video poster", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head></head><body>
         <img src="/a.png" srcset="/a.png 1x, /a2x.png 2x">
         <picture><source srcset="/b.webp 1x"><img src="/b.png"></picture>
         <video poster="/p.png"></video>
       </body></html>`,
      [],
    );
    const fetched: string[] = [];
    const out = await buildSingleFileHtml(doc, PAGE_URL, {
      readSameOriginCss,
      fetchImageDataUri: async (url) => {
        fetched.push(url);
        return `${PNG}?${encodeURIComponent(url)}`;
      },
    });
    // default dpr=1: only the 1x candidate of each srcset is fetched
    expect(fetched.sort()).toEqual([
      "https://example.com/a.png",
      "https://example.com/b.png",
      "https://example.com/b.webp",
      "https://example.com/p.png",
    ]);
    expect(out).not.toContain('src="/a.png"');
    expect(out).not.toContain('poster="/p.png"');
    expect(out).toContain(`src="${PNG}?${encodeURIComponent("https://example.com/a.png")}"`);
    expect(out).toContain(`poster="${PNG}?${encodeURIComponent("https://example.com/p.png")}"`);
    // the srcset keeps only the selected candidate, with its descriptor
    expect(out).toContain(`srcset="${PNG}?${encodeURIComponent("https://example.com/a.png")} 1x"`);
    expect(out).not.toContain("a2x.png");
    expect(out).not.toContain("2x");
  });

  it("picks the x-descriptor srcset candidate closest to devicePixelRatio", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head></head><body>
         <img srcset="/s.png 1x, /m.png 1.5x, /l.png 2x">
       </body></html>`,
      [],
    );
    const fetched: string[] = [];
    const out = await buildSingleFileHtml(doc, PAGE_URL, {
      readSameOriginCss,
      devicePixelRatio: 1.8,
      fetchImageDataUri: async (url) => {
        fetched.push(url);
        return `${PNG}?${encodeURIComponent(url)}`;
      },
    });
    expect(fetched).toEqual(["https://example.com/l.png"]);
    expect(out.match(/srcset="([^"]*)"/)?.[1]).toBe(
      `${PNG}?${encodeURIComponent("https://example.com/l.png")} 2x`,
    );
    expect(out).not.toContain("s.png");
    expect(out).not.toContain("m.png");
  });

  it("keeps the first srcset candidate for w descriptors regardless of dpr", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head></head><body>
         <img srcset="/a640.png 640w, /a1280.png 1280w">
       </body></html>`,
      [],
    );
    const fetched: string[] = [];
    const out = await buildSingleFileHtml(doc, PAGE_URL, {
      readSameOriginCss,
      devicePixelRatio: 3,
      fetchImageDataUri: async (url) => {
        fetched.push(url);
        return `${PNG}?${encodeURIComponent(url)}`;
      },
    });
    expect(fetched).toEqual(["https://example.com/a640.png"]);
    expect(out.match(/srcset="([^"]*)"/)?.[1]).toBe(
      `${PNG}?${encodeURIComponent("https://example.com/a640.png")} 640w`,
    );
    expect(out).not.toContain("a1280.png");
  });

  it("skips font urls at collection instead of fetching them", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head><style>
         @font-face { src: url(/f.woff2) }
         .a { background: url("/t.ttf?v=2#h") }
         .b { background: url(https://cdn.example.com/bg.png) }
       </style></head>
       <body><img src="/icon.WOFF"></body></html>`,
      [],
    );
    const fetched: string[] = [];
    const out = await buildSingleFileHtml(doc, PAGE_URL, {
      readSameOriginCss,
      fetchImageDataUri: async (url) => {
        fetched.push(url);
        return PNG;
      },
    });
    expect(fetched).toEqual(["https://cdn.example.com/bg.png"]);
    // font refs are left for the serve-side fallback, never fetched
    expect(out).toContain("url(/f.woff2)");
    expect(out).toContain("t.ttf?v=2#h");
    expect(out).toContain('src="/icon.WOFF"');
  });

  it("skips print-only stylesheets without reading or fetching them", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head>
         <link rel="stylesheet" href="/screen.css">
         <link rel="stylesheet" href="https://cdn.example.com/print.css" media="print">
         <link rel="stylesheet" href="/mixed.css" media="print, screen">
       </head><body></body></html>`,
      [
        { href: "https://example.com/screen.css", cssText: ".screen { color: red; }" },
        // cross-origin: if the builder touched it, the SecurityError would trigger the fetcher
        { href: "https://cdn.example.com/print.css", cssText: "", crossOrigin: true, media: "print" },
        { href: "https://example.com/mixed.css", cssText: ".mixed { color: blue; }", media: "print, screen" },
      ],
    );
    const fetched: string[] = [];
    const out = await buildSingleFileHtml(doc, PAGE_URL, {
      readSameOriginCss,
      fetchCrossOriginCss: async (href) => {
        fetched.push(href);
        return null;
      },
    });
    expect(fetched).toEqual([]);
    expect(out).toContain('data-mango-inline="https://example.com/screen.css"');
    // mixed media still renders on screen, so it is baked
    expect(out).toContain('data-mango-inline="https://example.com/mixed.css"');
    // the print <link> stays as-is; base href covers it like a failed fetch
    expect(out.match(/<link /g)).toHaveLength(1);
    expect(out).toContain('media="print"');
  });

  it("collects DOM images before CSS refs so content images win the inline budget", async () => {
    const bgs = Array.from({ length: 200 }, (_, i) => `.bg${i} { background: url(/bg${i}.png) }`).join("\n");
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head><style>${bgs}</style></head><body><img src="/content.png"></body></html>`,
      [],
    );
    const fetched: string[] = [];
    await buildSingleFileHtml(doc, PAGE_URL, {
      readSameOriginCss,
      fetchImageDataUri: async (url) => {
        fetched.push(url);
        return PNG;
      },
    });
    // 201 candidates, budget 200: the content img displaces the last CSS bg
    expect(fetched).toHaveLength(200);
    expect(fetched).toContain("https://example.com/content.png");
    expect(fetched).not.toContain("https://example.com/bg199.png");
  });

  it("resolves image urls against the page's own <base>", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head><base href="https://static.example.com/assets/"></head>
       <body><img src="a.png"></body></html>`,
      [],
    );
    const fetched: string[] = [];
    const out = await buildSingleFileHtml(doc, PAGE_URL, {
      readSameOriginCss,
      fetchImageDataUri: async (url) => {
        fetched.push(url);
        return PNG;
      },
    });
    expect(fetched).toEqual(["https://static.example.com/assets/a.png"]);
    expect(out).toContain(`src="${PNG}"`);
    // the stored snapshot still carries one absolutized base for parse time
    expect(out.match(/<base /g)).toHaveLength(1);
    expect(out).toContain(`<base href="https://static.example.com/assets/">`);
  });

  it("inlines url() refs in baked stylesheets against the sheet's own href", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head><link rel="stylesheet" href="/css/app.css"></head>
       <body><div class="hero"></div></body></html>`,
      [
        {
          href: "https://example.com/css/app.css",
          cssText: '.hero { background: url("../img/bg.png"); } .icon { background: url(https://cdn.example.com/i.svg); }',
        },
      ],
    );
    const out = await buildSingleFileHtml(doc, PAGE_URL, {
      readSameOriginCss,
      fetchImageDataUri: async () => PNG,
    });
    expect(out).toContain(`background: url("${PNG}")`);
    expect(out).not.toContain("../img/bg.png");
    expect(out).not.toContain("cdn.example.com");
  });

  it("inlines url() refs in inline <style> elements and style attributes", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head><style>.a { background: url(/a.png) }</style></head>
       <body><div style="background: url('/b.png')"></div></body></html>`,
      [],
    );
    const out = await buildSingleFileHtml(doc, PAGE_URL, {
      readSameOriginCss,
      fetchImageDataUri: async () => PNG,
    });
    expect(out).not.toContain("url(/a.png)");
    expect(out).not.toContain("url('/b.png')");
    // the style="" attribute is HTML-escaped on serialization (&quot;)
    expect(out.match(/data:image\/png/g)).toHaveLength(2);
  });

  it("leaves urls in place when the image fetch fails (serve-time fallback)", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head></head><body><img src="https://cdn.example.com/gone.png"></body></html>`,
      [],
    );
    const out = await buildSingleFileHtml(doc, PAGE_URL, {
      readSameOriginCss,
      fetchImageDataUri: async () => null,
    });
    expect(out).toContain('src="https://cdn.example.com/gone.png"');
  });

  it("rejects non-image data returned by the fetcher", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head></head><body><img src="/evil.png"></body></html>`,
      [],
    );
    const out = await buildSingleFileHtml(doc, PAGE_URL, {
      readSameOriginCss,
      fetchImageDataUri: async () => "data:text/html;base64,PGI+",
    });
    expect(out).toContain('src="/evil.png"');
  });

  it("shouldAbort stops new inline fetches; un-inlined urls stay for the serve-time fallback", async () => {
    const { doc, readSameOriginCss } = makeDoc(
      `<html><head></head><body>
        <img src="https://cdn.example.com/a.png">
        <img src="https://cdn.example.com/b.png">
      </body></html>`,
      [],
    );
    let fetched = 0;
    const out = await buildSingleFileHtml(doc, PAGE_URL, {
      readSameOriginCss,
      fetchImageDataUri: async () => {
        fetched++;
        // 模拟第一个请求耗时恰好跨过总时限：后续不再发起新抓取。
        return fetched === 1 ? null : `data:image/png;base64,${fetched}`;
      },
      shouldAbort: () => fetched >= 1,
    });
    expect(fetched).toBe(1);
    expect(out).toContain('src="https://cdn.example.com/a.png"');
    expect(out).toContain('src="https://cdn.example.com/b.png"');
  });
});
