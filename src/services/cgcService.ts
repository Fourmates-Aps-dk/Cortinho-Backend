import { db } from "../../db.js";
import { cgcCertCache, gradingCompanies } from "../../drizzle/schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../logger/index.js";
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
  imageUrl:          z.string().url().optional(),
  imageBackUrl:      z.string().url().optional(),
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

export interface CgcPopulation {
  total:  number | null;
  higher: number | null;
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
  return Boolean(process.env.PARSE_API_KEY && process.env.PARSE_CGC_SCRAPER_ID);
}

async function parseBotGet<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const apiKey    = process.env.PARSE_API_KEY;
  const scraperId = process.env.PARSE_CGC_SCRAPER_ID;
  if (!apiKey || !scraperId) throw new CgcError("CGC lookup not configured on this server", 503);

  const url = new URL(`${PARSE_BASE}/${scraperId}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "X-API-Key": apiKey },
      signal:  AbortSignal.timeout(20_000),
    });
  } catch (err) {
    logger.error({ err, endpoint }, "parse.bot request failed");
    throw new CgcError("CGC lookup service unreachable", 502);
  }

  if (res.status === 401 || res.status === 403) {
    throw new CgcError("parse.bot rejected the API key", 502);
  }
  if (res.status === 402) {
    throw new CgcError("parse.bot credits exhausted", 502);
  }
  if (res.status === 429) {
    throw new CgcError("CGC lookup rate limit reached. Try again later.", 429);
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

async function fetchCert(certNumber: string): Promise<CgcCert> {
  const cert = await parseBotGet<CgcCert>("lookup_cert", { cert_number: certNumber });
  if (!cert?.cert_number) {
    throw new CgcError(`No CGC record for cert ${certNumber}`, 404);
  }
  return cert;
}

/**
 * Population is a separate billed call, and its payload isn't part of the
 * documented cert schema — probe defensively and degrade to nulls rather than
 * failing the whole lookup over a shape change.
 */
async function fetchPopulation(certNumber: string): Promise<CgcPopulation> {
  try {
    const data = await parseBotGet<Record<string, unknown>>("get_card_population", {
      cert_number: certNumber,
    });
    const num = (...keys: string[]): number | null => {
      for (const k of keys) {
        const v = data[k];
        if (typeof v === "number") return v;
        if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
      }
      return null;
    };
    return {
      total:  num("total_population", "total", "total_graded", "population"),
      higher: num("count_higher", "higher", "graded_higher"),
    };
  } catch (err) {
    logger.warn({ err, certNumber }, "CGC population lookup failed — returning nulls");
    return { total: null, higher: null };
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

  const population = opts.population
    ? await fetchPopulation(certNumber)
    : { total: null, higher: null };

  return {
    certNumber,
    cached,
    card: await toCardFields(cert),
    population,
    raw: cert,
  };
}
