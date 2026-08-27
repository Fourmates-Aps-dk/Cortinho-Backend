import { db } from "../../db.js";
import { cgcCertCache, gradingCompanies } from "../../drizzle/schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../logger/index.js";
import { env } from "../config/env.js";
import { cached } from "../cache/index.js";
import { z } from "zod";

// CGC has no official public API. This goes through parse.bot, a managed
// wrapper over CGC's public cert-verification pages — not a CGC-approved
// integration, so treat upstream shape changes as expected rather than
// exceptional.
const PARSE_BASE = "https://api.parse.bot/scraper";

// ── Schemas ───────────────────────────────────────────────────

// CGC cert numbers are 10-13 digits — deliberately non-overlapping with PSA's
// 6-10, so a cert can't be ambiguous between the two graders.
export const cgcCertParamSchema = z.object({
  certNumber: z.string().regex(/^\d{10,13}$/, "CGC cert number must be 10-13 digits"),
});

export const cgcLookupQuerySchema = z.object({
  // Population is a second billed call upstream, so it stays opt-in.
  population: z.enum(["true", "false"]).default("false"),
});

export const cgcToCardSchema = z.object({
  category:          z.enum(["pokemon","soccer","basketball","football","other"]).optional(),
  purchasePrice:     z.number().min(0).optional(),
  currentValue:      z.number().min(0).optional(),
  purchaseDate:      z.string().optional(),
  acquisitionMethod: z.enum(["bought","pulled","trade","gift","other"]).optional(),
  imageUrl:          z.url().optional(),
  imageBackUrl:      z.url().optional(),
  notes:             z.string().optional(),
  isPublic:          z.boolean().optional(),
  status:            z.enum(["collection","wishlist","for_sale","sold","traded","draft"]).optional(),
});

export type CgcToCardInput = z.infer<typeof cgcToCardSchema>;

// ── Upstream response ─────────────────────────────────────────

export interface CgcImage {
  url:   string;
  title: string;   // "Obverse" | "Reverse"
}

export interface CgcCert {
  cert_number:   string;
  card_name?:    string;   // player name for sports cards
  game?:         string;   // game for TCG, manufacturer for sports
  card_set?:     string;
  card_number?:  string;
  year?:         string;
  grade?:        string;   // "PERFECT 10", "GEM MINT 10", "9.5"
  variant_1?:    string;
  variant_2?:    string;
  language?:     string;
  grader_notes?: string;   // "Unavailable" when absent
  images?:       CgcImage[];
}

export interface CgcGradeCount {
  grade: string;
  count: number;
}

export interface CgcPopulation {
  total:  number | null;
  /** Copies graded above this card. Null when its grade isn't on the ladder. */
  higher: number | null;
  /** Full descending ladder as returned upstream — we paid for it, so keep it. */
  ladder?: CgcGradeCount[];
}

export interface CgcLookupResult {
  certNumber: string;
  cached:     boolean;
  card:       CgcCardFields;
  population: CgcPopulation;
  raw:        CgcCert;
}

export interface CgcCardFields {
  name:           string;
  category:       "pokemon" | "soccer" | "basketball" | "football" | "other";
  year?:          number;
  setName?:       string;
  cardNumber?:    string;
  parallel?:      string;
  isAutographed:  boolean;
  isGraded:       true;
  gradeCompanyId: number;
  gradeValue?:    number;
  certNumber:     string;
  imageUrl?:      string;
  imageBackUrl?:  string;
  notes?:         string;
}

export class CgcError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CgcError";
  }
}

// ── Grading company ───────────────────────────────────────────

let cgcCompanyId: number | null = null;

export async function getCgcCompanyId(): Promise<number> {
  if (cgcCompanyId !== null) return cgcCompanyId;

  const row = await db.query.gradingCompanies.findFirst({
    where: eq(gradingCompanies.abbr, "CGC"),
  });
  if (!row) {
    // psaService seeds all four graders on first use; if CGC is missing the
    // table was never seeded, and guessing an id would corrupt card rows.
    throw new CgcError("CGC is not present in grading_companies", 500);
  }

  cgcCompanyId = row.id;
  return cgcCompanyId;
}

// ── Normalization ─────────────────────────────────────────────

// `game` carries the game for TCG cards but the *manufacturer* for sports
// ("Topps"), which says nothing about the sport. Check the set name too, then
// fall back to "other" rather than guessing.
const CATEGORY_MAP: Array<[RegExp, CgcCardFields["category"]]> = [
  [/BASKETBALL|NBA/i,              "basketball"],
  [/FOOTBALL|NFL/i,                "football"],
  [/SOCCER|FIFA|PREMIER LEAGUE/i,  "soccer"],
  [/POKEMON|POKÉMON|MAGIC|YU-?GI-?OH|TCG/i, "pokemon"],
];

function mapCategory(game?: string, cardSet?: string): CgcCardFields["category"] {
  const haystack = `${game ?? ""} ${cardSet ?? ""}`;
  for (const [pattern, category] of CATEGORY_MAP) {
    if (pattern.test(haystack)) return category;
  }
  return "other";
}

// "PERFECT 10" → 10, "GEM MINT 10" → 10, "9.5" → 9.5, "AUTHENTIC" → undefined.
function parseGrade(grade?: string): number | undefined {
  if (!grade) return undefined;
  const match = grade.match(/(\d+(?:\.\d)?)\s*$/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return value >= 1 && value <= 10 ? value : undefined;
}

function parseYear(year?: string): number | undefined {
  if (!year) return undefined;
  const match = year.match(/\d{4}/);
  if (!match) return undefined;
  const value = Number(match[0]);
  return value >= 1800 && value <= 2100 ? value : undefined;
}

function isAutograph(cert: CgcCert): boolean {
  const haystack = `${cert.variant_1 ?? ""} ${cert.variant_2 ?? ""} ${cert.grader_notes ?? ""} ${cert.card_name ?? ""}`;
  return /\b(AUTO(GRAPH)?|SIGNATURE|SIGNED)\b/i.test(haystack);
}

function findImage(images: CgcImage[] | undefined, title: string): string | undefined {
  return images?.find((i) => i.title?.toLowerCase() === title.toLowerCase())?.url;
}

// CGC reports "Unavailable" rather than omitting empty grader notes.
function cleanNotes(cert: CgcCert): string | undefined {
  const parts: string[] = [];
  if (cert.grader_notes && !/^unavailable$/i.test(cert.grader_notes.trim())) {
    parts.push(cert.grader_notes.trim());
  }
  // No language column on cards — keep it here rather than lose it.
  if (cert.language && !/^english$/i.test(cert.language.trim())) {
    parts.push(`Language: ${cert.language.trim()}`);
  }
  return parts.length ? parts.join(" · ") : undefined;
}

export async function toCardFields(cert: CgcCert): Promise<CgcCardFields> {
  const name = (cert.card_name?.trim() || cert.card_set?.trim() || `CGC cert ${cert.cert_number}`).slice(0, 256);
  const parallel = [cert.variant_1, cert.variant_2]
    .map((v) => v?.trim())
    .filter(Boolean)
    .join(" ") || undefined;

  return {
    name,
    category:       mapCategory(cert.game, cert.card_set),
    year:           parseYear(cert.year),
    setName:        cert.card_set?.trim() || undefined,
    cardNumber:     cert.card_number?.trim() || undefined,
    parallel:       parallel?.slice(0, 128),
    isAutographed:  isAutograph(cert),
    isGraded:       true,
    gradeCompanyId: await getCgcCompanyId(),
    gradeValue:     parseGrade(cert.grade),
    certNumber:     cert.cert_number,
    imageUrl:       findImage(cert.images, "Obverse"),
    imageBackUrl:   findImage(cert.images, "Reverse"),
    notes:          cleanNotes(cert),
  };
}

// ── Upstream calls ────────────────────────────────────────────

export function isCgcConfigured(): boolean {
  return Boolean(env.PARSE_API_KEY && env.PARSE_CGC_SCRAPER_ID);
}

// Measured against the live scraper: lookup_cert 14-27s, get_card_population
// 27-64s (and it returns 500s under load). These are page scrapes upstream, not
// API reads, so the budgets are generous and per-endpoint.
const TIMEOUT_MS: Record<string, number> = {
  lookup_cert:         60_000,
  get_card_population: 90_000,
};

// Observed failure mode: roughly one call in four stalls ~60s and returns 500,
// while an immediate retry succeeds in ~14s. Looks like a cold scrape upstream.
// One retry converts that from a user-visible error into a slow success.
const MAX_ATTEMPTS = 2;

async function parseBotGet<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const apiKey    = env.PARSE_API_KEY;
  const scraperId = env.PARSE_CGC_SCRAPER_ID;
  if (!apiKey || !scraperId) throw new CgcError("CGC lookup not configured on this server", 503);

  const url = new URL(`${PARSE_BASE}/${scraperId}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let lastError: CgcError = new CgcError("CGC lookup failed", 502);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "X-API-Key": apiKey },
        signal:  AbortSignal.timeout(TIMEOUT_MS[endpoint] ?? 60_000),
      });
    } catch (err) {
      logger.warn({ err, endpoint, attempt }, "parse.bot request failed");
      lastError = new CgcError("CGC lookup service unreachable", 502);
      continue;   // timeouts are the retryable case
    }

    // Terminal — retrying can't help and each attempt costs a credit.
    if (res.status === 401 || res.status === 403) {
      throw new CgcError("parse.bot rejected the API key", 502);
    }
    if (res.status === 402) {
      throw new CgcError("parse.bot credits exhausted", 502);
    }
    if (res.status === 429) {
      throw new CgcError("CGC lookup rate limit reached. Try again later.", 429);
    }

    if (res.status >= 500) {
      logger.warn({ endpoint, attempt, status: res.status }, "parse.bot 5xx — retrying");
      lastError = new CgcError(`CGC lookup service returned ${res.status}`, 502);
      continue;
    }
    if (!res.ok) {
      throw new CgcError(`CGC lookup service returned ${res.status}`, 502);
    }

    const body = (await res.json()) as { status?: string; data?: T; error?: string };
    if (body.status !== "success" || !body.data) {
      throw new CgcError(body.error || "CGC lookup returned no data", 502);
    }
    return body.data;
  }

  throw lastError;
}

async function fetchCert(certNumber: string): Promise<CgcCert> {
  const cert = await parseBotGet<CgcCert>("lookup_cert", { cert_number: certNumber });
  if (!cert?.cert_number) {
    throw new CgcError(`No CGC record for cert ${certNumber}`, 404);
  }
  return cert;
}

const EMPTY_POPULATION: CgcPopulation = { total: null, higher: null };

// Population is reported as a descending ladder ("Perfect 10", "Pristine 10",
// "Gem Mint 10", "Mint+ 9.5", "9", …) with no count-higher field, so we derive
// it: everything above this card's own rung.
//
// Matching is by label first because the three distinct 10-tiers all reduce to
// the number 10 — a numeric match alone would be ambiguous. The numeric tail is
// only a fallback for rungs like "9" where the label IS the number.
function countHigher(ladder: CgcGradeCount[], grade: string | undefined): number | null {
  if (!grade || ladder.length === 0) return null;

  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const target = norm(grade);

  let index = ladder.findIndex((r) => norm(r.grade) === target);

  if (index === -1) {
    const targetNum = grade.match(/(\d+(?:\.\d)?)\s*$/)?.[1];
    if (targetNum) {
      index = ladder.findIndex((r) => r.grade.match(/(\d+(?:\.\d)?)\s*$/)?.[1] === targetNum);
    }
  }
  if (index === -1) return null;

  return ladder.slice(0, index).reduce((sum, r) => sum + (r.count || 0), 0);
}

interface CgcPopulationResponse {
  population_total?: number;
  grade_ladder?: CgcGradeCount[];
}

/**
 * Population is a separate billed call AND a slow one (~27s upstream), so it is
 * cached for a day. Unlike cert data it does change — more copies get graded —
 * which is why it lives in the TTL cache rather than cgc_cert_cache.
 */
async function fetchPopulation(certNumber: string, grade: string | undefined): Promise<CgcPopulation> {
  try {
    return await cached<CgcPopulation>(`cgc:pop:${certNumber}`, 86_400, async () => {
      const data = await parseBotGet<CgcPopulationResponse>("get_card_population", {
        cert_number: certNumber,
      });
      const ladder = Array.isArray(data.grade_ladder) ? data.grade_ladder : [];
      return {
        total:  typeof data.population_total === "number" ? data.population_total : null,
        higher: countHigher(ladder, grade),
        ...(ladder.length > 0 && { ladder }),
      };
    });
  } catch (err) {
    // A population failure must not sink the cert lookup itself.
    logger.warn({ err, certNumber }, "CGC population lookup failed — returning nulls");
    return EMPTY_POPULATION;
  }
}

/**
 * Look up a CGC cert, cache-aside on cgc_cert_cache.
 * Cert data is immutable once graded, so cached rows never expire. Population
 * is not cached — it changes as more copies are graded.
 */
export async function lookupCert(
  certNumber: string,
  opts: { population?: boolean } = {}
): Promise<CgcLookupResult> {
  const hit = await db.query.cgcCertCache.findFirst({
    where: eq(cgcCertCache.certNumber, certNumber),
  });

  let cert: CgcCert;
  let cached = false;

  if (hit) {
    cert = hit.resultJson as CgcCert;
    cached = true;
  } else {
    cert = await fetchCert(certNumber);
    await db
      .insert(cgcCertCache)
      .values({ certNumber, resultJson: cert })
      .onConflictDoNothing();
    logger.info({ certNumber }, "CGC cert cached");
  }


  const [card, population] = await Promise.all([
    toCardFields(cert),
    opts.population ? fetchPopulation(certNumber, cert.grade) : Promise.resolve(EMPTY_POPULATION),
  ]);

  return { certNumber, cached, card, population, raw: cert };
}
