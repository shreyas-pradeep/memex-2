import { connection } from "next/server";
import { buildArxivQueryUrl, isDoiLike, parseArxivAtom, parseArxivId } from "@/core/arxiv";

/**
 * arXiv resolver route.
 *
 * GET /api/arxiv?id=<arXiv id or arxiv.org URL>
 *   200 { title, authors, year?, abstract, arxivId, pdfUrl }
 *   400 { error }  missing, invalid or DOI-like id (never reaches upstream)
 *   404 { error }  arXiv has no such paper
 *   429 { error }  per-IP rate limit
 *   502 { error }  upstream failure, redirect, oversize or unparsable response
 *   504 { error }  upstream timeout
 *
 * Security: the upstream URL is fixed to https://export.arxiv.org/api/query and
 * carries only the id that `parseArxivId` validated, built with URLSearchParams.
 * No user string is forwarded, redirects are not followed, the body is capped and
 * upstream bodies and errors are never returned or logged.
 */
const UPSTREAM_TIMEOUT_MS = 10_000;
/** Largest upstream body accepted (a single-entry Atom feed is a few KB). */
const MAX_BODY_BYTES = 512 * 1024;
const USER_AGENT = "Memex-2/0.1 (research archive; arXiv metadata resolver)";

/** Per client IP, in memory per instance: keeps the shared upstream etiquette. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 12;
const hits = new Map<string, number[]>();

function rateLimited(ip: string, now: number): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 1000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(k);
  }
  return false;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

class UpstreamError extends Error {
  constructor(readonly status: 502 | 504) {
    super("upstream");
  }
}

/** Reads at most `MAX_BODY_BYTES` of text; throws `UpstreamError(502)` when the body is larger. */
async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new UpstreamError(502);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new UpstreamError(502);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function fetchAtom(id: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(buildArxivQueryUrl(id), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/atom+xml, application/xml" },
      redirect: "manual", // a redirect (to any host) is treated as a failure
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new UpstreamError(502);
    return await readCapped(res);
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(controller.signal.aborted ? 504 : 502);
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request: Request): Promise<Response> {
  await connection(); // depends on the request, never prerendered
  const raw = new URL(request.url).searchParams.get("id");
  if (raw === null || raw.trim() === "") return json({ error: "Missing `id` parameter." }, 400);
  const id = parseArxivId(raw);
  if (id === undefined) {
    return json(
      {
        error: isDoiLike(raw)
          ? "DOI lookup is not supported yet. Use an arXiv id or URL."
          : "Not a valid arXiv id or URL.",
      },
      400,
    );
  }
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(ip, Date.now())) return json({ error: "Too many requests. Try again shortly." }, 429);

  let xml: string;
  try {
    xml = await fetchAtom(id);
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : 502;
    return json({ error: status === 504 ? "arXiv timed out." : "arXiv is unavailable." }, status);
  }
  const parsed = parseArxivAtom(xml);
  if (parsed.kind === "not-found") return json({ error: "No arXiv paper found for that id." }, 404);
  if (parsed.kind === "malformed") return json({ error: "arXiv returned an unreadable response." }, 502);
  const { paper } = parsed;
  return json({ ...paper, arxivId: id });
}
