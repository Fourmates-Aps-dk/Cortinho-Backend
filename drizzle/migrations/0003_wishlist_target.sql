-- Wishlist price alerts: the price a user wants to pay for a wishlist card
ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "target_price" numeric(12, 2);
