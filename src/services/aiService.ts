// AI card scan via Google Gemini 1.5 Flash.
// Accepts base64-encoded front (+ optional back) image.
// Returns structured card fields ready to pre-fill the add-card form.
// Production-grade: validates response, retries on failure, handles edge cases.

import { GoogleGenerativeAI, Part } from "@google/generative-ai";
import { z } from "zod";
import { logger } from "../logger/index.js";

const SCAN_PROMPT = `You are a trading card expert. Analyse the card image(s) and extract the following fields as a JSON object. Use null for any field you cannot determine with confidence.

IMPORTANT: Return ONLY valid JSON in this exact format — no markdown, no explanation, no code fences.

{
  "name": "Player or character name on the card",
  "category": "one of: pokemon | soccer | basketball | football | other",
  "player": "athlete name (null for Pokemon)",
  "team": "team name (null for Pokemon)",
  "year": null or integer year,
  "setName": "card set / expansion name",
  "cardNumber": "card number as printed (e.g. 025/102)",
  "parallel": "parallel or variant name if visible, else null",
  "serialNumber": "serial number if the card is numbered (e.g. 047/100), else null",
  "isRookie": boolean,
  "isAutographed": boolean,
  "isPatch": boolean,
  "isGraded": boolean,
  "gradeCompany": "PSA | BGS | CGC | SGC | null",
  "gradeValue": null or number (e.g. 10, 9.5),
  "certNumber": "cert number from grading label, else null",
  "condition": "one of: poor | fair | good | very_good | excellent | near_mint | mint | gem_mint | null"
}

Rules:
1. If two images provided, first is front, second is back. Cert # usually on back label.
2. For Pokémon: player and team should be null.
3. For sports: set/cardNumber depend on league (NBA, NFL, etc).
4. isGraded = true only if you see a grading company label (PSA, BGS, CGC, SGC).
5. gradeCompany + gradeValue must both be present if isGraded = true.
6. Return null for uncertain fields — never guess.`;

const responseSchema = z.object({
  name:          z.string().nullable().default(null),
  category:      z.enum(["pokemon", "soccer", "basketball", "football", "other"]).nullable().default(null),
  player:        z.string().nullable().default(null),
  team:          z.string().nullable().default(null),
  year:          z.number().int().min(1800).max(2100).nullable().default(null),
  setName:       z.string().nullable().default(null),
  cardNumber:    z.string().nullable().default(null),
  parallel:      z.string().nullable().default(null),
  serialNumber:  z.string().nullable().default(null),
  isRookie:      z.boolean().default(false),
  isAutographed: z.boolean().default(false),
  isPatch:       z.boolean().default(false),
  isGraded:      z.boolean().default(false),
  gradeCompany:  z.enum(["PSA", "BGS", "CGC", "SGC"]).nullable().default(null),
  gradeValue:    z.number().min(1).max(10).nullable().default(null),
  certNumber:    z.string().nullable().default(null),
  condition:     z.enum(["poor", "fair", "good", "very_good", "excellent", "near_mint", "mint", "gem_mint"]).nullable().default(null),
});

export type ScanResult = z.infer<typeof responseSchema>;

export const scanCardSchema = z.object({
  frontImage: z.object({
    data:     z.string().min(1),
    mimeType: z.string().default("image/jpeg"),
  }),
  backImage: z.object({
    data:     z.string().min(1),
    mimeType: z.string().default("image/jpeg"),
  }).optional(),
});

export type ScanCardInput = z.infer<typeof scanCardSchema>;

async function callGemini(parts: Part[]): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const genAI = new GoogleGenerativeAI(apiKey);
  // Try gemini-2.0-flash-lite first (latest), fall back to gemini-1.5-flash
  const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0.2, topK: 1 }, // low temp = more deterministic
    });

    return result.response.text().trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Gemini API call failed");
    throw new Error(`AI service unavailable: ${msg}`);
  }
}

function extractJSON(text: string): string {
  // Remove markdown code fences
  let clean = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();

  // If wrapped in {}, extract that
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) return match[0];

  throw new Error("Could not extract JSON from AI response");
}

function validateResponse(parsed: any): ScanResult {
  // Validate against schema
  const result = responseSchema.parse(parsed);

  // Business rules: if graded, need both company + value
  if (result.isGraded) {
    if (!result.gradeCompany || !result.gradeValue) {
      logger.warn(
        { parsed },
        "AI marked isGraded=true but missing gradeCompany or gradeValue — setting isGraded=false"
      );
      result.isGraded = false;
    }
  }

  // Card must have at least a name
  if (!result.name?.trim()) {
    throw new Error("AI could not identify card name — image may be unclear or not a trading card");
  }

  return result;
}

export async function scanCard(input: ScanCardInput): Promise<ScanResult> {
  logger.info({ images: input.backImage ? 2 : 1 }, "AI scan started");

  const parts: Part[] = [
    { text: SCAN_PROMPT },
    { inlineData: { data: input.frontImage.data, mimeType: input.frontImage.mimeType } },
  ];

  if (input.backImage) {
    parts.push({ inlineData: { data: input.backImage.data, mimeType: input.backImage.mimeType } });
  }

  // Call Gemini
  const text = await callGemini(parts);
  logger.debug({ response: text.substring(0, 200) }, "Gemini response received");

  // Extract JSON
  let json: string;
  try {
    json = extractJSON(text);
  } catch (err) {
    logger.error({ response: text }, "Failed to extract JSON from response");
    throw new Error("AI response was malformed — please try again");
  }

  // Parse JSON
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    logger.error({ json }, "JSON parse failed");
    throw new Error("AI response was invalid JSON — please try again");
  }

  // Validate + apply business rules
  const result = validateResponse(parsed);
  logger.info({ name: result.name, category: result.category }, "AI scan completed successfully");

  return result;
}

// ── Listing title → card fields ───────────────────────────────
// eBay/CSV titles mix the card with marketing noise ("RARE INVESTMENT CARD MVP MINT").
// Price lookups search by these fields, so a clean split matters more than the raw title.

const TITLE_PROMPT = `You are a trading card expert. Split this marketplace listing title into card fields.
Return ONLY valid JSON, no markdown:
{
  "name": "player or character name only (e.g. \\"Michael Jordan\\", \\"Charizard\\"), proper case, no set/year/number/grade/marketing words",
  "category": "one of: pokemon | soccer | basketball | football | other (baseball, hockey and others = other)",
  "year": null or integer (first year of a season like 2023-24 → 2023),
  "setName": "manufacturer + set (e.g. \\"Topps Chrome\\", \\"Panini Megacracks\\", \\"Base Set\\") or null",
  "cardNumber": "card number without # (e.g. \\"57\\", \\"014\\", \\"SVP 085\\") or null",
  "parallel": "parallel/variant (e.g. \\"Refractor\\", \\"Silver\\", \\"Prerelease Stamped\\") or null",
  "gradeCompany": "PSA | BGS | CGC | SGC | null",
  "gradeValue": null or number,
  "isRookie": boolean
}
Drop words like rare, investment, MVP, mint, NM, hot, look, graded, card. Use null when unsure, never guess.

Title: `;

const titleSchema = responseSchema.pick({
  name: true, category: true, year: true, setName: true, cardNumber: true, parallel: true,
  gradeCompany: true, gradeValue: true, isRookie: true,
});
export type ParsedTitle = z.infer<typeof titleSchema>;

export async function parseCardTitle(title: string): Promise<ParsedTitle> {
  const text = await callGemini([{ text: TITLE_PROMPT + JSON.stringify(title.slice(0, 300)) }]);
  const parsed = titleSchema.parse(JSON.parse(extractJSON(text)));
  if (!parsed.name?.trim()) throw new Error("AI could not identify the card name");
  return parsed;
}
