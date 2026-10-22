import { describe, expect, it, vi } from "vitest";

import { dspaceTranslator, itemUuidFromUrl } from "./dspace.js";

// GSU scholarworks.gsu.edu serves a bare Angular shell for item pages —
// 827 bytes, no meta tags at all (CSR, no SSR).
const CSR_SHELL = `<!DOCTYPE html><html><head>
  <meta charset="UTF-8"><base href="/"><title>DSpace</title>
</head><body>
  <ds-app></ds-app>
<script src="main.20269bcf5264c9b9.js" type="module"></script>
</body></html>`;

// Field shape lifted verbatim from
// scholarworks.gsu.edu/server/api/core/items/71dfb819-4230-479c-a862-eafe9cde787d.
const GSU_ITEM = {
  id: "71dfb819-4230-479c-a862-eafe9cde787d",
  uuid: "71dfb819-4230-479c-a862-eafe9cde787d",
  name: "The Influence of Racial Ethnic Match Between School Psychologists and Clients on Referral Outcomes",
  handle: "20.500.14694/3730",
  metadata: {
    "dc.contributor.author": [{ value: "Washington, Michelle" }],
    "dc.date.issued": [{ value: "2022-05-13" }],
    "dc.description.abstract": [{ value: "<p>Racial/ethnic incongruence (REI) describes a relationship.</p>" }],
    "dc.description.degree": [{ value: "Doctor of Philosophy (PhD)" }],
    "dc.identifier.doi": [{ value: "https://doi.org/10.57709/28929031" }],
    "dc.identifier.uri": [{ value: "https://hdl.handle.net/20.500.14694/3730" }],
    "dc.subject": [{ value: "school psychologist race/ethnicity" }, { value: "racial/ethnic match" }],
    "dc.title": [{ value: "The Influence of Racial Ethnic Match Between School Psychologists and Clients on Referral Outcomes" }],
    "dc.type": [],
  },
};

const GSU_PAGE_URL = "https://scholarworks.gsu.edu/items/71dfb819-4230-479c-a862-eafe9cde787d";

function restResponses(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (url: string) => {
    if (url === `/server/api/core/items/${GSU_ITEM.uuid}`) {
      return JSON.stringify(overrides.item ?? GSU_ITEM);
    }
    if (url === `/server/api/core/items/${GSU_ITEM.uuid}/bundles`) {
      return JSON.stringify(
        overrides.bundles ?? {
          _embedded: {
            bundles: [
              { name: "SOURCE", _links: { bitstreams: { href: "https://scholarworks.gsu.edu/server/api/core/bundles/0b4a/bitstreams" } } },
              { name: "ORIGINAL", _links: { bitstreams: { href: "https://scholarworks.gsu.edu/server/api/core/bundles/5bc1/bitstreams" } } },
              { name: "THUMBNAIL", _links: { bitstreams: { href: "https://scholarworks.gsu.edu/server/api/core/bundles/1cc2/bitstreams" } } },
            ],
          },
        },
      );
    }
    if (url === "/server/api/core/bundles/5bc1/bitstreams") {
      return JSON.stringify(
        overrides.bitstreams ?? {
          _embedded: {
            bitstreams: [
              { name: "WASHINGTON-DISSERTATION-2022.pdf", mimeType: "application/pdf", _links: { content: { href: "https://scholarworks.gsu.edu/server/api/core/bitstreams/aaaa/content" } } },
            ],
          },
        },
      );
    }
    throw new Error(`fetch_failed:${url}`);
  });
}

describe("itemUuidFromUrl", () => {
  it("extracts the uuid from DSpace 7 landing routes", () => {
    expect(itemUuidFromUrl(GSU_PAGE_URL)).toBe("71dfb819-4230-479c-a862-eafe9cde787d");
    expect(
      itemUuidFromUrl("https://repository.arizona.edu/entities/publication/0cadb8d5-9ee4-4941-afbc-7deafdb13346"),
    ).toBe("0cadb8d5-9ee4-4941-afbc-7deafdb13346");
  });

  it("rejects non-item paths and non-uuid segments", () => {
    expect(itemUuidFromUrl("https://scholarworks.gsu.edu/search?query=x")).toBeNull();
    expect(itemUuidFromUrl("https://shop.example.com/items/12345")).toBeNull();
  });
});

describe("dspaceTranslator", () => {
  it("detects the CSR shell on an item route, nothing else", () => {
    expect(dspaceTranslator.detect({ url: GSU_PAGE_URL, html: CSR_SHELL })).toBe(true);
    // SSR deployments render the same tag — also recognized.
    expect(
      dspaceTranslator.detect({ url: GSU_PAGE_URL, html: CSR_SHELL.replace("<ds-app></ds-app>", "<ds-app><div>…rendered…</div></ds-app>") }),
    ).toBe(true);
    // Shell without an item route (home/search pages) → no.
    expect(dspaceTranslator.detect({ url: "https://scholarworks.gsu.edu/home", html: CSR_SHELL })).toBe(false);
    // Item route without the DSpace shell → no.
    expect(dspaceTranslator.detect({ url: GSU_PAGE_URL, html: "<html><body>shop</body></html>" })).toBe(false);
  });

  it("maps the REST item to CSL and the ORIGINAL bitstream to a pdf attachment", async () => {
    const fetchText = restResponses();
    const { metadata, identifier, attachments } = await dspaceTranslator.extract({
      url: GSU_PAGE_URL,
      html: CSR_SHELL,
      fetchText,
    });

    expect(metadata.type).toBe("thesis");
    expect(metadata.title).toContain("The Influence of Racial Ethnic Match");
    expect(metadata.author).toEqual([{ family: "Washington", given: "Michelle" }]);
    expect(metadata.issued).toEqual({ "date-parts": [[2022, 5, 13]] });
    expect(metadata.DOI).toBe("10.57709/28929031");
    expect(metadata.abstract).toBe("Racial/ethnic incongruence (REI) describes a relationship.");
    expect(metadata.keywords).toEqual(["school psychologist race/ethnicity", "racial/ethnic match"]);
    expect(identifier).toBe("10.57709/28929031");
    expect(attachments).toEqual([
      {
        kind: "pdf",
        url: "https://scholarworks.gsu.edu/server/api/core/bitstreams/aaaa/content",
        mime: "application/pdf",
        filename: "WASHINGTON-DISSERTATION-2022.pdf",
      },
    ]);
    expect(fetchText).toHaveBeenCalledWith(
      `/server/api/core/items/${GSU_ITEM.uuid}`,
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("degrades to metadata-only when bundles/bitstreams are unreachable", async () => {
    const { attachments } = await dspaceTranslator.extract({
      url: GSU_PAGE_URL,
      html: CSR_SHELL,
      fetchText: vi.fn(async (url: string) => {
        if (url.endsWith("/bundles")) throw new Error("fetch_failed:403");
        return JSON.stringify(GSU_ITEM);
      }),
    });
    expect(attachments).toEqual([]);
  });

  it("fails the capture when the item record itself is unreachable", async () => {
    await expect(
      dspaceTranslator.extract({
        url: GSU_PAGE_URL,
        html: CSR_SHELL,
        fetchText: vi.fn(async () => {
          throw new Error("fetch_failed:404");
        }),
      }),
    ).rejects.toThrow("fetch_failed:404");
  });

  it("skips non-pdf bitstreams (license text first in the bundle)", async () => {
    const fetchText = restResponses({
      bitstreams: {
        _embedded: {
          bitstreams: [
            { name: "license.txt", mimeType: "text/plain", _links: { content: { href: "https://scholarworks.gsu.edu/server/api/core/bitstreams/bbbb/content" } } },
            { name: "thesis.pdf", mimeType: "application/pdf", _links: { content: { href: "https://scholarworks.gsu.edu/server/api/core/bitstreams/cccc/content" } } },
          ],
        },
      },
    });
    const { attachments } = await dspaceTranslator.extract({
      url: GSU_PAGE_URL,
      html: CSR_SHELL,
      fetchText,
    });
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.url).toBe("https://scholarworks.gsu.edu/server/api/core/bitstreams/cccc/content");
  });
});
