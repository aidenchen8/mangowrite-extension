// Translator registry. Selection is **content-driven** (Zotero-style
// detectWeb): we run each translator's `detect` against the page rather than
// matching the URL host — so a CNKI page proxied through a WebVPN (host
// `webvpn.<uni>.edu.cn`, not `*.cnki.net`) is still recognized. If nothing
// recognizes a scholarly item, we return null so the caller can tell the user
// "no paper found here" instead of silently capturing a generic web page.

import { baiduXueshuTranslator } from "./baidu-xueshu.js";
import { cnkiTranslator } from "./cnki.js";
import { cqvipTranslator } from "./cqvip.js";
import { dspaceTranslator } from "./dspace.js";
import { embeddedPdfTranslator } from "./embedded-pdf.js";
import { genericTranslator } from "./generic.js";
import { hostedPdfTranslator } from "./hosted-pdf.js";
import { ieeeTranslator } from "./ieee.js";
import { ncpssdTranslator } from "./ncpssd.js";
import { wanfangTranslator } from "./wanfang.js";
import { wosTranslator } from "./wos.js";
import type { Translator } from "./types.js";

/** Site-specific translators, tried in order before the generic fallback. */
export const SITE_TRANSLATORS: Translator[] = [
  cnkiTranslator,
  wanfangTranslator,
  cqvipTranslator,
  ieeeTranslator,
  wosTranslator,
  ncpssdTranslator,
  baiduXueshuTranslator,
  // DSpace 7 item pages are Angular CSR shells with zero meta tags; the
  // generic translator can't see them at all. Requires `<ds-app>` + an item
  // uuid URL, so it can't claim a non-DSpace page.
  dspaceTranslator,
  // Git-host file viewers (GitHub blob …) are HTML pages hosting a paper PDF;
  // before embedded-pdf so a viewer shell can never claim them first.
  hostedPdfTranslator,
  // Structural catch: a PDF-viewer shell (IEEE stamp.jsp, generic <iframe> PDFs).
  // Last, so a real site translator wins; its detect defers to generic when the
  // page has citation metadata.
  embeddedPdfTranslator,
];

export function pickTranslator(ctx: {
  url: string;
  html: string;
}): Translator | null {
  for (const translator of SITE_TRANSLATORS) {
    if (translator.detect(ctx)) return translator;
  }
  if (genericTranslator.detect(ctx)) return genericTranslator;
  return null;
}
