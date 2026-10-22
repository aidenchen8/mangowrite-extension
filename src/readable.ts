// readable main-content extraction for webpage snapshots.
//
// We capture two artifacts: the raw single-file HTML (archival "view original")
// and the readable main content, which the server's HTML adapter turns into the
// CoreDoc block stream (annotations/AI anchor to block_uid, never to raw HTML).
// This is a lightweight Readability-style heuristic — pick the most likely main
// container — kept string-based so it runs in the MV3 worker and unit-tests.

/** Extract the main article HTML: prefer <article>/<main>, else strip chrome. */
export function extractReadableHtml(html: string): string {
  const article = firstBlock(html, "article");
  if (article && textLength(article) > 200) return article;

  const main = firstBlock(html, "main");
  if (main && textLength(main) > 200) return main;

  // Fallback: body with scripts/styles/nav/header/footer/aside removed.
  const body = firstBlock(html, "body") ?? html;
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, "")
    .trim();
}

/** Plain-text length of an HTML fragment (for picking the richest container). */
export function textLength(html: string): number {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().length;
}

function firstBlock(html: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  return html.match(re)?.[1] ?? null;
}
