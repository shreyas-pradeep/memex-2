import { connection } from "next/server";
import { sanitizeGhostSuggestions } from "@/core/ghost-engine";
import {
  GHOST_LIMITS,
  GHOST_SYSTEM_PROMPT,
  buildGhostUserPrompt,
  extractGeminiText,
  parseGhostModelText,
  validateGhostRequest,
} from "@/core/ghost-live";

/**
 * Live Ghost route.
 *
 * GET  /api/ghost  -> { live: boolean }  (is a server-side GEMINI_API_KEY configured; never the key)
 * POST /api/ghost  -> body { nodes, existingEdges }, optional header `x-gemini-api-key`
 *   200 { source: "live", discoveries: GhostDiscovery[] }  Gemini produced at least one valid bridge
 *   200 { source: "none" }  no key, upstream failure, timeout, bad JSON or nothing valid.
 *                           The client then runs the local engine (it owns the dismissed list).
 *   400 { error }           invalid or oversized input
 *
 * Upstream error bodies and keys are never logged or returned.
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
/** Tried in order; GEMINI_MODEL (if set) goes first. */
const DEFAULT_MODELS = ["gemini-2.0-flash", "gemini-1.5-flash"] as const;
const UPSTREAM_TIMEOUT_MS = 12_000;
const MAX_KEY_CHARS = 200;

/** Server-key rate limit (per client IP), in memory per instance: protects the owner's quota. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
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

export async function GET(): Promise<Response> {
  await connection(); // read the environment per request, not at build time
  return json({ live: Boolean(process.env.GEMINI_API_KEY?.trim()) });
}

async function callGemini(model: string, key: string, userPrompt: string): Promise<unknown[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: GHOST_SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.4,
          maxOutputTokens: 1200,
        },
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const text = extractGeminiText(await res.json());
    return text === null ? null : parseGhostModelText(text);
  } catch {
    return null; // network error, abort or bad JSON: deliberately silent
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  if (raw.length > GHOST_LIMITS.maxBodyChars) return json({ error: "Request too large." }, 400);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Body is not valid JSON." }, 400);
  }
  const parsed = validateGhostRequest(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const userKey = request.headers.get("x-gemini-api-key")?.trim() ?? "";
  if (userKey.length > MAX_KEY_CHARS) return json({ error: "Invalid API key header." }, 400);
  const serverKey = process.env.GEMINI_API_KEY?.trim() ?? "";
  const key = userKey || serverKey;
  if (key === "") return json({ source: "none" });

  if (!userKey) {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (rateLimited(ip, Date.now())) return json({ source: "none" });
  }

  const prompt = buildGhostUserPrompt(parsed.nodes, parsed.edges);
  const configured = process.env.GEMINI_MODEL?.trim();
  const models = configured ? [configured, ...DEFAULT_MODELS] : [...DEFAULT_MODELS];
  for (const model of [...new Set(models)]) {
    const suggestions = await callGemini(model, key, prompt);
    if (suggestions === null) continue;
    const discoveries = sanitizeGhostSuggestions(suggestions, parsed.nodes, parsed.edges, {
      discoveredAt: new Date().toISOString(),
    });
    if (discoveries.length > 0) return json({ source: "live", discoveries });
    break; // model answered but nothing usable: do not spend another call
  }
  return json({ source: "none" });
}
