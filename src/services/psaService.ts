import { db } from "../../db.js";
import { psaCertCache, gradingCompanies } from "../../drizzle/schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../logger/index.js";
import { z } from "zod";

const PSA_BASE = "https://api.psacard.com/publicapi";

// ── Schemas ───────────────────────────────────────────────────

// PSA cert numbers are numeric, 6-10 digits.
export const certParamSchema = z.object({
  certNumber: z.string().regex(/^\d{6,10}$/, "Cert number must be 6-10 digits"),
});

// Optional overrides applied on top of the PSA-derived card fields.
export const certToCardSchema = z.object({
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

export type CertToCardInput = z.infer<typeof certToCardSchema>;

// ── PSA API response ──────────────────────────────────────────

export interface PsaCert {
  CertNumber:        string;
  SpecID?:           number;
  SpecNumber?:       string;
  LabelType?:        string;
  Year?:             string;
  Brand?:            string;
  Category?:         string;
  CardNumber?:       string;
  Subject?:          string;
  Variety?:          string;
  IsPSADNA?:         boolean;
  IsDualCert?:       boolean;
  GradeDescription?: string;
  CardGrade?:        string;
  TotalPopulation?:  number;
  PopulationHigher?: number;
}

export interface PsaLookupResult {
  certNumber:    string;
  cached:        boolean;
  card:          PsaCardFields;
  population:    { total: number | null; higher: number | null };
  raw:           PsaCert;
}

// Subset of createCardSchema that PSA can populate.
export interface PsaCardFields {
  name:          string;
  category:      "pokemon" | "soccer" | "basketball" | "football" | "other";
  year?:         number;
  setName?:      string;
  cardNumber?:   string;
  parallel?:     string;
  isAutographed: boolean;
  isGraded:      true;
  gradeCompanyId: number;
  gradeValue?:   number;
  certNumber:    string;
}

export class PsaError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PsaError";
  }
}

// ── Grading companies ─────────────────────────────────────────

// cardService.GRADE_NAME_TO_ID assumes PSA=1, BGS=2, CGC=3, SGC=4.
// The table ships empty, so seed it with those exact ids on first use.
const SEED_COMPANIES = [
  { id: 1, name: "Professional Sports Authenticator", abbr: "PSA" },
  { id: 2, name: "Beckett Grading Services",          abbr: "BGS" },
  { id: 3, name: "Certified Guaranty Company",        abbr: "CGC" },
  { id: 4, name: "Sportscard Guaranty Corporation",   abbr: "SGC" },
];

let psaCompanyId: number | null = null;

export async function getPsaCompanyId(): Promise<number> {
  if (psaCompanyId !== null) return psaCompanyId;

  const existing = await db.query.gradingCompanies.findFirst({
    where: eq(gradingCompanies.abbr, "PSA"),
  });
  if (existing) {
    psaCompanyId = existing.id;
    return psaCompanyId;
  }

  await db.insert(gradingCompanies).values(SEED_COMPANIES).onConflictDoNothing();
  // Explicit ids bypass the smallserial sequence — realign it so later
  // inserts don't collide with the seeded rows.
  await db.execute(
    "SELECT setval(pg_get_serial_sequence('grading_companies','id'), (SELECT MAX(id) FROM grading_companies))"
  );
  logger.info("Seeded grading_companies");

  const psa = await db.query.gradingCompanies.findFirst({
    where: eq(gradingCompanies.abbr, "PSA"),
  });
  if (!psa) throw new PsaError("Failed to resolve PSA grading company", 500);

  psaCompanyId = psa.id;
  return psaCompanyId;
}

// ── Normalization ─────────────────────────────────────────────

// PSA category strings → our card category enum.
const CATEGORY_MAP: Array<[RegExp, PsaCardFields["category"]]> = [
  [/TCG|POKEMON|MAGIC/i, "pokemon"],
  [/BASKETBALL/i,        "basketball"],
  [/FOOTBALL/i,          "football"],
  [/SOCCER/i,            "soccer"],
];

function mapCategory(psaCategory?: string, brand?: string): PsaCardFields["category"] {
  const haystack = `${psaCategory ?? ""} ${brand ?? ""}`;
  for (const [pattern, category] of CATEGORY_MAP) {
    if (pattern.test(haystack)) return category;
  }
  return "other";
}

// "GEM MT 10" → 10, "NM-MT 8" → 8, "AUTHENTIC" → undefined.
function parseGrade(cardGrade?: string): number | undefined {
  if (!cardGrade) return undefined;
  const match = cardGrade.match(/(\d+(?:\.\d)?)\s*$/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return value >= 1 && value <= 10 ? value : undefined;
}

function parseYear(year?: string): number | undefined {
  if (!year) return undefined;
  // PSA sometimes returns ranges like "1998-99" — take the leading year.
  const match = year.match(/\d{4}/);
  if (!match) return undefined;
  const value = Number(match[0]);
  return value >= 1800 && value <= 2100 ? value : undefined;
}

function isAutograph(cert: PsaCert): boolean {
  if (cert.IsPSADNA) return true;
  const haystack = `${cert.LabelType ?? ""} ${cert.Variety ?? ""} ${cert.Brand ?? ""} ${cert.Subject ?? ""}`;
  return /\bAUTO(GRAPH)?\b/i.test(haystack);
}

export async function toCardFields(cert: PsaCert): Promise<PsaCardFields> {
  // Subject is the player/character. Fall back to brand so name is never empty.
  const name = (cert.Subject?.trim() || cert.Brand?.trim() || `PSA cert ${cert.CertNumber}`).slice(0, 256);

  return {
    name,
    category:       mapCategory(cert.Category, cert.Brand),
    year:           parseYear(cert.Year),
    setName:        cert.Brand?.trim() || undefined,
    cardNumber:     cert.CardNumber?.trim() || undefined,
    parallel:       cert.Variety?.trim() || undefined,
    isAutographed:  isAutograph(cert),
    isGraded:       true,
    gradeCompanyId: await getPsaCompanyId(),
    gradeValue:     parseGrade(cert.CardGrade ?? cert.GradeDescription),
    certNumber:     cert.CertNumber,
  };
}

// ── Lookup ────────────────────────────────────────────────────

export function isPsaConfigured(): boolean {
  return Boolean(process.env.PSA_API_TOKEN);
}

async function fetchFromPsa(certNumber: string): Promise<PsaCert> {
  const token = process.env.PSA_API_TOKEN;
  if (!token) throw new PsaError("PSA lookup not configured on this server", 503);

  let res: Response;
  try {
    res = await fetch(`${PSA_BASE}/cert/GetByCertNumber/${certNumber}`, {
      headers: { Authorization: `bearer ${token}` },
      signal:  AbortSignal.timeout(15_000),
    });
  } catch (err) {
    logger.error({ err, certNumber }, "PSA request failed");
    throw new PsaError("PSA service unreachable", 502);
  }

  if (res.status === 401) {
    throw new PsaError("PSA rejected the API token", 502);
  }
  if (res.status === 403) {
    // PSA issues tokens freely but gates the API behind a separate account
    // approval — surface their message so the cause is obvious.
    const detail = await res.text().catch(() => "");
    logger.error({ certNumber, detail }, "PSA denied API access");
    throw new PsaError(
      "PSA denied API access for this token. The account needs PSA API approval.",
      502
    );
  }
  if (res.status === 429) {
    throw new PsaError("PSA rate limit reached. Try again later.", 429);
  }
  if (!res.ok) {
    throw new PsaError(`PSA returned ${res.status}`, 502);
  }

  const body = (await res.json()) as { PSACert?: PsaCert };
  // PSA answers unknown certs with 200 and an empty/zeroed PSACert.
  if (!body.PSACert || !body.PSACert.CertNumber || body.PSACert.CertNumber === "0") {
    throw new PsaError(`No PSA record for cert ${certNumber}`, 404);
  }

  return body.PSACert;
}

/**
 * Look up a PSA cert, cache-aside on psa_cert_cache.
 * Cert data is immutable once graded, so cached rows never expire.
 */
export async function lookupCert(certNumber: string): Promise<PsaLookupResult> {
  const hit = await db.query.psaCertCache.findFirst({
    where: eq(psaCertCache.certNumber, certNumber),
  });

  let cert: PsaCert;
  let cached = false;

  if (hit) {
    cert = hit.resultJson as PsaCert;
    cached = true;
  } else {
    cert = await fetchFromPsa(certNumber);
    await db
      .insert(psaCertCache)
      .values({ certNumber, resultJson: cert })
      .onConflictDoNothing();
    logger.info({ certNumber }, "PSA cert cached");
  }

  return {
    certNumber,
    cached,
    card:       await toCardFields(cert),
    population: {
      total:  cert.TotalPopulation ?? null,
      higher: cert.PopulationHigher ?? null,
    },
    raw: cert,
  };
}
