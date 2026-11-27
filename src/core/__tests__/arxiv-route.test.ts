import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => undefined }));

import { GET } from "@/app/api/arxiv/route";

const FEED = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
<id>http://arxiv.org/abs/1706.03762v7</id><published>2017-06-12T17:57:34Z</published>
<title>Attention Is All You Need</title><summary>We propose the Transformer.</summary>
<author><name>Ashish Vaswani</name></author>
<link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
</entry></feed>`;
const ERROR_FEED = `<feed><entry><id>http://arxiv.org/api/errors#x</id><title>Error</title></entry></feed>`;

let ipCounter = 0;
function call(id: string | null, ip = `10.0.0.${++ipCounter}`): Promise<Response> {
  const url = new URL("http://localhost/api/arxiv");
  if (id !== null) url.searchParams.set("id", id);
  return GET(new Request(url, { headers: { "x-forwarded-for": ip } }));
}

describe("GET /api/arxiv", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([null, "", "  ", "nope", "https://evil.com/abs/1706.03762", "1706.03762&x=1"])(
    "returns 400 without contacting upstream for id %j",
    async (id) => {
      const res = await call(id);
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty("error");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("explains that DOIs are unsupported", async () => {
    const res = await call("10.1145/3292500.3330701");
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/DOI lookup is not supported/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a paper through the fixed upstream URL only", async () => {
    fetchMock.mockResolvedValue(new Response(FEED, { status: 200 }));
    const res = await call("https://arxiv.org/abs/1706.03762");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      title: "Attention Is All You Need",
      authors: ["Ashish Vaswani"],
      year: 2017,
      abstract: "We propose the Transformer.",
      arxivId: "1706.03762",
      pdfUrl: "https://arxiv.org/pdf/1706.03762v7",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://export.arxiv.org/api/query?id_list=1706.03762&max_results=1");
    expect(init?.redirect).toBe("manual");
    expect((init?.headers as Record<string, string>)["User-Agent"]).toMatch(/Memex/);
  });

  it("returns 404 for arXiv's Error entry", async () => {
    fetchMock.mockResolvedValue(new Response(ERROR_FEED, { status: 200 }));
    expect((await call("1706.03762")).status).toBe(404);
  });

  it("returns generic 502s for upstream failures, redirects, oversize and junk bodies", async () => {
    const secret = "SECRET-UPSTREAM-BODY";
    const cases: (() => Promise<Response> | Response)[] = [
      () => new Response(secret, { status: 500 }),
      () => new Response(secret, { status: 301, headers: { location: "https://evil.example/" } }),
      () => new Response(secret, { status: 200, headers: { "content-length": "99999999" } }),
      () => new Response("x".repeat(600 * 1024), { status: 200 }),
      () => new Response(secret, { status: 200 }),
    ];
    for (const make of cases) {
      fetchMock.mockImplementationOnce(async () => make());
      const res = await call("1706.03762");
      expect(res.status).toBe(502);
      expect(JSON.stringify(await res.json())).not.toContain(secret);
    }
    fetchMock.mockRejectedValueOnce(new Error(`connect ECONNREFUSED ${secret}`));
    const res = await call("1706.03762");
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(secret);
  });

  it("returns 504 when the upstream does not answer within the timeout", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const pending = call("1706.03762");
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).status).toBe(504);
  });

  it("rate limits a single client", async () => {
    fetchMock.mockImplementation(async () => new Response(FEED, { status: 200 }));
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await call("1706.03762", "203.0.113.9")).status);
    expect(statuses.slice(0, 12).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(12)).toEqual([429, 429]);
  });
});
