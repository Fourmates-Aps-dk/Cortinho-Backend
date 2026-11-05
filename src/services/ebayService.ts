import { logger } from "../logger/index.js";
import { cached } from "../cache/index.js";

const SANDBOX = process.env.EBAY_SANDBOX === "true";
const EBAY_BASE          = SANDBOX ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
const EBAY_OAUTH_URL     = `${EBAY_BASE}/identity/v1/oauth2/token`;
const EBAY_INSIGHTS_URL  = `${EBAY_BASE}/buy/marketplace_insights/v1_beta/item_sales/search`;
const EBAY_BROWSE_URL    = `${EBAY_BASE}/buy/browse/v1/item_summary/search`;
const EBAY_ITEM_URL      = `${EBAY_BASE}/buy/browse/v1/item`;

// Category IDs for trading cards on eBay
const CATEGORY_IDS: Record<string, string> = {
  basketball: "214",
  football:   "213",
  baseball:   "212",
  soccer:     "261328",
  pokemon:    "183454",
  other:      "212",
};

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getEbayToken(): Promise<string> {
  // Use pre-generated token if provided directly
  if (process.env.EBAY_API_TOKEN) return process.env.EBAY_API_TOKEN;

  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("eBay credentials not configured (set EBAY_API_TOKEN or EBAY_CLIENT_ID+EBAY_CLIENT_SECRET)");

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(EBAY_OAUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });

  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(`eBay OAuth failed: ${data.error_description ?? res.status}`);

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  logger.info("eBay OAuth token refreshed");
  return cachedToken.token;
}

export interface PriceLookupResult {
  medianPrice: number;
  avgPrice: number;
  minPrice: number;
  maxPrice: number;
  sampleSize: number;
  currency: string;
  source: "sold" | "active";
  listings: Array<{ title: string; price: number; url: string }>;
}

export interface GradeFilter { company?: string; value?: string }

type Listing = { title: string; price: number; url: string };

// Titles that are never the card itself
const NOISE = /\b(reprint|rp|poster|art print|custom|proxy|digital|lot|you pick|pick your|choose|break|sticker|magnet)\b/i;
const ANY_GRADE = /\b(PSA|BGS|CGC|SGC|TAG|HGA)\s*\d/i;

// Keep listings that are the same card in the same grade. Raw lookups drop slabs.
export function matchListings(listings: Listing[], grade?: GradeFilter): Listing[] {
  const clean = listings.filter((l) => !NOISE.test(l.title));
  const company = grade?.company?.replace(/[^a-z]/gi, "");
  const value = grade?.value ? String(parseFloat(grade.value)).replace(".", "\\.") : "";
  const exact = company && value && value !== "NaN"
    ? clean.filter((l) => new RegExp(`\\b${company}\\s*${value}(?![\\d.])`, "i").test(l.title))
    : clean.filter((l) => !ANY_GRADE.test(l.title));
  return exact.length ? exact : clean;
}

export function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface PriceSearchParams {
  name: string;
  year?: string;
  setName?: string;
  cardNumber?: string;
  gradeCompany?: string;
  gradeValue?: string;
  category?: string;
}

async function ebayGet(token: string, url: string): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(url, {
    headers: {
      Authorization:             `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      "Content-Type":            "application/json",
    },
    signal: AbortSignal.timeout(4000),
  });
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 200) }; }
  return { ok: res.ok, status: res.status, data };
}

async function fetchMarketplaceInsights(token: string, query: string, categoryId: string): Promise<any[] | null> {
  const params = new URLSearchParams({ q: query, category_ids: categoryId, limit: "20" });
  const { ok, status, data } = await ebayGet(token, `${EBAY_INSIGHTS_URL}?${params}`);
  if (status === 401 || status === 403 || status === 404) return null; // scope/sandbox not available — caller will fall back
  if (!ok) throw new Error(`eBay Insights HTTP ${status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data.itemSales ?? [];
}

async function fetchBrowse(token: string, query: string, categoryId: string): Promise<any[]> {
  const params = new URLSearchParams({ q: query, category_ids: categoryId, limit: "20" });
  const { ok, status, data } = await ebayGet(token, `${EBAY_BROWSE_URL}?${params}`);
  if (!ok) throw new Error(`eBay Browse HTTP ${status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data.itemSummaries ?? [];
}

export async function searchCardPrices(
  query: string,
  category?: string,
  grade?: GradeFilter
): Promise<PriceLookupResult> {
  const token = await getEbayToken();
  const categoryId = category ? (CATEGORY_IDS[category.toLowerCase()] ?? "212") : "212";
  const parts = query.trim().split(/\s+/);

  let items: any[] = [];
  let usedQuery = query;
  let usedInsights = false;

  // Try Marketplace Insights (sold listings) first; null = not available for this token/env
  const insightsAvailable = !SANDBOX; // sandbox rarely has Insights data
  if (insightsAvailable) {
    for (let end = parts.length; end >= 2; end--) {
      const attempt = parts.slice(0, end).join(" ");
      logger.debug({ attempt, categoryId }, "eBay insights query attempt");
      const result = await fetchMarketplaceInsights(token, attempt, categoryId);
      if (result === null) {
        logger.warn("eBay Insights unavailable (401/403/404) — falling back to Browse API");
        break;
      }
      if (result.length > 0) {
        items = result;
        usedQuery = attempt;
        usedInsights = true;
        break;
      }
    }
  }

  // Fall back to Browse API (active listings) — max 4 attempts to keep latency under ~6s
  if (items.length === 0) {
    const MAX_ATTEMPTS = 4;
    const step = Math.max(1, Math.floor(parts.length / MAX_ATTEMPTS));
    const ends = Array.from({ length: MAX_ATTEMPTS }, (_, i) => Math.max(2, parts.length - i * step))
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort((a, b) => b - a);

    for (const end of ends) {
      const attempt = parts.slice(0, end).join(" ");
      logger.debug({ attempt, categoryId }, "eBay browse query attempt");
      const result = await fetchBrowse(token, attempt, categoryId);
      if (result.length > 0) {
        items = result;
        usedQuery = attempt;
        break;
      }
    }
  }

  if (items.length > 0) {
    logger.info({ usedQuery, results: items.length, source: usedInsights ? "insights" : "browse" }, "eBay search success");
  } else {
    logger.warn({ query }, "eBay: no results for any fallback");
  }

  const validListings = usedInsights
    ? items
        .map((item: any) => ({
          title: item.title as string,
          price: parseFloat(item.lastSoldPrice?.value ?? "0"),
          url:   item.itemWebUrl as string,
        }))
        .filter((l) => l.price > 0)
    : items
        .map((item: any) => ({
          title: item.title as string,
          price: parseFloat(item.price?.value ?? "0"),
          url:   item.itemWebUrl as string,
        }))
        .filter((l) => l.price > 0);

  const source = usedInsights ? "sold" : "active";
  const matched = matchListings(validListings, grade);
  if (matched.length === 0) {
    return { medianPrice: 0, avgPrice: 0, minPrice: 0, maxPrice: 0, sampleSize: 0, currency: "USD", source, listings: [] };
  }

  const prices = matched.map((l) => l.price);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const currency = usedInsights
    ? (items[0]?.lastSoldPrice?.currency ?? "USD")
    : (items[0]?.price?.currency ?? "USD");
  const round = (n: number) => Math.round(n * 100) / 100;

  return {
    medianPrice: round(median(prices)),
    avgPrice:    round(avg),
    minPrice:    Math.min(...prices),
    maxPrice:    Math.max(...prices),
    sampleSize:  prices.length,
    currency,
    source,
    listings:    [...matched].sort((a, b) => a.price - b.price).slice(0, 8),
  };
}

export const hasEbayCredentials = () =>
  Boolean(process.env.EBAY_API_TOKEN || (process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET));

// Builds the most precise query from the card fields; same card+grade is served from cache for 6h.
export function lookupPrices(p: PriceSearchParams): Promise<PriceLookupResult> {
  const query = [p.name, p.year, p.setName, p.cardNumber, p.gradeCompany, p.gradeValue].filter(Boolean).join(" ");
  return cached(`ebay:${p.category ?? ""}:${query.toLowerCase()}`, 6 * 3600, () =>
    searchCardPrices(query, p.category, { company: p.gradeCompany, value: p.gradeValue }));
}

// ── eBay listing parser ───────────────────────────────────────

export interface ListingImport {
  title:        string;
  name:         string;       // parsed card name
  year:         number | null;
  price:        number | null;
  currency:     string;
  imageUrl:     string | null;
  imageBackUrl: string | null;
  itemId:       string;
  listingUrl:   string;
  gradeCompany: string | null;
  gradeValue:   number | null;
  category:     string | null;
}

function extractItemId(url: string): string | null {
  // formats: /itm/123456789  /itm/title/123456789  /i/123456789
  const m = url.match(/\/itm\/(?:[^/]+\/)?(\d{10,14})|\/i\/(\d{10,14})/);
  return m ? (m[1] ?? m[2]) : null;
}

function inferCategory(title: string): string | null {
  const t = title.toLowerCase();
  if (/pokemon|charizard|pikachu|eevee|mewtwo/.test(t)) return "pokemon";
  if (/soccer|football uk|premier league|bundesliga|serie a|la liga/.test(t)) return "soccer";
  if (/\bnba\b|basketball/.test(t)) return "basketball";
  if (/\bnfl\b|football/.test(t)) return "football";
  return null;
}

function inferGrade(title: string): { gradeCompany: string | null; gradeValue: number | null } {
  // "PSA 9", "BGS 9.5", "CGC 8", "SGC 10"
  const m = title.match(/\b(PSA|BGS|CGC|SGC)\s+(\d+(?:\.\d)?)\b/i);
  if (!m) return { gradeCompany: null, gradeValue: null };
  return { gradeCompany: m[1].toUpperCase(), gradeValue: parseFloat(m[2]) };
}

function stripGradeAndNoise(title: string): string {
  return title
    .replace(/\b(PSA|BGS|CGC|SGC)\s+\d+(?:\.\d)?\b/gi, "")
    .replace(/\b(graded|rookie|rc|sp|ssp|holo|foil|refractor|prizm|auto|autograph|patch|rpa|numbered|\/\d+)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ── /b/ Browse product page parser ───────────────────────────

function extractBrowseSlug(url: string): { slug: string; categoryId: string } | null {
  // https://www.ebay.com/b/{slug}/{categoryId}/bn_{id}
  const m = url.match(/\/b\/([^/]+)\/(\d+)/);
  return m ? { slug: m[1], categoryId: m[2] } : null;
}

function parseBrowseSlug(slug: string): { name: string; year: string | null; cardNumber: string | null } {
  const text = slug.replace(/-/g, " ").trim();

  // Year at start: "2023-24" or "2023"
  const yearMatch = slug.match(/^(\d{4}(?:-\d{2,4})?)-/);
  const year = yearMatch ? yearMatch[1] : null;

  // Card number at end: last standalone digits segment e.g. "-64" "-211"
  const numMatch = slug.match(/-(\d{1,4})(?:-[a-zA-Z].*)?$/);
  const cardNumber = numMatch ? numMatch[1] : null;

  return { name: text, year, cardNumber };
}

async function parseBrowseProductUrl(url: string): Promise<ListingImport> {
  const browse = extractBrowseSlug(url);
  if (!browse) throw new Error("Could not parse eBay browse URL");

  const { slug, categoryId } = browse;
  const { name, year } = parseBrowseSlug(slug);

  const token = await getEbayToken();

  // Search Browse API for listings matching this product
  const params = new URLSearchParams({
    q:            name,
    category_ids: categoryId,
    limit:        "5",
  });

  const { ok, status, data } = await ebayGet(token, `${EBAY_BROWSE_URL}?${params}`);
  if (!ok) throw new Error(`eBay browse search failed: ${status}`);

  const items: any[] = data.itemSummaries ?? [];
  const first = items[0];

  const title       = first?.title ?? name;
  const price       = first?.price?.value ? parseFloat(first.price.value) : null;
  const imageUrl    = first?.image?.imageUrl ?? null;
  const listingUrl  = first?.itemWebUrl ?? url;
  const itemId      = first?.itemId ?? "";

  const { gradeCompany, gradeValue } = inferGrade(title);
  const category = inferCategory(title) ?? inferCategoryFromId(categoryId);
  const cleanName = stripGradeAndNoise(title);

  const currentYear = new Date().getFullYear();
  const yearFromTitle = title.match(/\b(19[5-9]\d|20[0-2]\d)\b/)?.[1];
  const resolvedYear = yearFromTitle ? parseInt(yearFromTitle) : (year ? parseInt(year) : null);

  logger.info({ slug, title, price, items: items.length }, "eBay browse product parsed");

  return {
    title,
    name:         cleanName || name,
    year:         resolvedYear,
    price,
    currency:     first?.price?.currency ?? "USD",
    imageUrl,
    imageBackUrl: null,
    itemId,
    listingUrl,
    gradeCompany,
    gradeValue,
    category,
  };
}

function inferCategoryFromId(categoryId: string): string | null {
  const map: Record<string, string> = {
    "214": "basketball", "213": "football", "212": "baseball",
    "261328": "soccer", "183454": "pokemon",
  };
  return map[categoryId] ?? null;
}

export async function parseEbayListing(url: string): Promise<ListingImport> {
  // Route /b/ product page URLs to the browse parser
  if (/\/b\//.test(url)) return parseBrowseProductUrl(url);

  const itemId = extractItemId(url);
  if (!itemId) throw new Error("Paste a specific eBay listing URL (/itm/) or product page URL (/b/)");

  const token = await getEbayToken();

  // eBay Browse API uses legacy ID format: v1|{itemId}|0
  const res = await fetch(`${EBAY_ITEM_URL}/v1%7C${itemId}%7C0`, {
    headers: {
      Authorization:             `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      "Content-Type":            "application/json",
    },
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as any;
    throw new Error(`eBay item fetch failed: ${err.errors?.[0]?.message ?? res.status}`);
  }

  const item = (await res.json()) as any;

  const title  = (item.title as string) ?? "";
  const price  = item.price?.value ? parseFloat(item.price.value) : null;
  const images: string[] = [
    item.image?.imageUrl,
    ...(item.additionalImages ?? []).map((i: any) => i.imageUrl),
  ].filter(Boolean);

  // Year: 4-digit number between 1950 and current year + 1
  const currentYear = new Date().getFullYear();
  const yearMatch   = title.match(/\b(19[5-9]\d|20[0-2]\d)\b/);
  const year        = yearMatch ? parseInt(yearMatch[1]) : null;

  const { gradeCompany, gradeValue } = inferGrade(title);
  const category = inferCategory(title);
  const name     = stripGradeAndNoise(title);

  logger.info({ itemId, title, year, price, gradeCompany }, "eBay listing parsed");

  return {
    title,
    name,
    year,
    price,
    currency:     item.price?.currency ?? "USD",
    imageUrl:     images[0] ?? null,
    imageBackUrl: images[1] ?? null,
    itemId,
    listingUrl:   item.itemWebUrl ?? url,
    gradeCompany,
    gradeValue,
    category,
  };
}
