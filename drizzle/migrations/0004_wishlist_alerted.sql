-- Wishlist alerts: when the user was last emailed for the current target (reset when the target changes)
ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "target_alerted_at" timestamp with time zone;
