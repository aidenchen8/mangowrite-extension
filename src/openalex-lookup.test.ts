import { describe, expect, it, vi } from "vitest";

import { lookupOpenAlexByDoi } from "./openalex-lookup.js";

const OPENALEX_WORK = {
  display_name: "Attention Is All You Need",
  doi: "10.1234/example",
  publication_year: 2017,
  authorships: [
    { author: { display_name: "Ashish Vaswani" } },
    { author: { display_name: "Noam Shazeer" } },
  ],
  primary_location: { display_name: "NeurIPS" },
  biblio: { volume: "30", issue: "1", first_page: "5998", last_page: "6008" },
  open_access: { oa_url: "https://example.com/paper.pdf" },
  concepts: [{ display_name: "Natural language processing" }],
};

function mockFetch(response: unknown, ok = true): typeof fetch {
  return vi.fn(async () =>
    Promise.resolve({
      ok,
      json: async () => response,
    } as Response),
  ) as unknown as typeof fetch;
}

describe("lookupOpenAlexByDoi", () => {
  it("returns PartialCsl fields from a valid OpenAlex work", async () => {
    const fetchFn = mockFetch(OPENALEX_WORK);
    const result = await lookupOpenAlexByDoi("10.1234/example", { fetchFn });

    expect(result).not.toBeNull();
    expect(result!.title).toBe("Attention Is All You Need");
    expect(result!.DOI).toBe("10.1234/example");
    expect(result!.type).toBe("article-journal");
    expect(result!["container-title"]).toBe("NeurIPS");
    expect(result!.volume).toBe("30");
    expect(result!.issue).toBe("1");
    expect(result!.page).toBe("5998-6008");
    expect(result!.issued).toEqual({ "date-parts": [[2017]] });
    expect(result!.author).toEqual([
      { given: "Ashish", family: "Vaswani" },
      { given: "Noam", family: "Shazeer" },
    ]);
    expect(result!.URL).toBe("https://example.com/paper.pdf");
    expect(result!.keywords).toEqual(["Natural language processing"]);
  });

  it("builds the URL against api.openalex.org with the cleaned DOI", async () => {
    const fetchFn = mockFetch(OPENALEX_WORK);
    await lookupOpenAlexByDoi("10.1234/example", { fetchFn });

    const calledUrl = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(calledUrl).toBe("https://api.openalex.org/works/doi:10.1234%2Fexample");
  });

  it("strips doi.org prefix before querying", async () => {
    const fetchFn = mockFetch(OPENALEX_WORK);
    await lookupOpenAlexByDoi("https://doi.org/10.1234/example", { fetchFn });

    const calledUrl = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(calledUrl).toBe("https://api.openalex.org/works/doi:10.1234%2Fexample");
  });

  it("returns null when the DOI is not found (404)", async () => {
    const fetchFn = mockFetch({ error: "Not found" }, false);
    const result = await lookupOpenAlexByDoi("10.1234/missing", { fetchFn });
    expect(result).toBeNull();
  });

  it("returns null when OpenAlex returns an error body", async () => {
    const fetchFn = mockFetch({ error: "Unable to process request" });
    const result = await lookupOpenAlexByDoi("10.1234/bad", { fetchFn });
    expect(result).toBeNull();
  });

  it("returns null on network error (silent degradation)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("network error");
    }) as unknown as typeof fetch;
    const result = await lookupOpenAlexByDoi("10.1234/example", { fetchFn });
    expect(result).toBeNull();
  });

  it("returns null on timeout (abort)", async () => {
    const fetchFn = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const result = await lookupOpenAlexByDoi("10.1234/example", {
      fetchFn,
      timeoutMs: 50,
    });
    expect(result).toBeNull();
  });

  it("returns null for an empty DOI", async () => {
    const fetchFn = mockFetch(OPENALEX_WORK);
    const result = await lookupOpenAlexByDoi("   ", { fetchFn });
    expect(result).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not crash on a malformed OpenAlex response", async () => {
    const fetchFn = mockFetch("not an object");
    const result = await lookupOpenAlexByDoi("10.1234/example", { fetchFn });
    expect(result).toBeNull();
  });
});
