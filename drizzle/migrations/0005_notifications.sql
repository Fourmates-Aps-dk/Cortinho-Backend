-- In-app notifications (inbox) and Web Push subscriptions (one row per browser/device)
CREATE TABLE IF NOT EXISTS "notifications" (
  "id"         serial PRIMARY KEY,
  "user_id"    integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "type"       varchar(32)  NOT NULL,
  "title"      varchar(200) NOT NULL,
  "body"       varchar(500),
  "url"        varchar(500),
  "read_at"    timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_notifications_user_created" ON "notifications" ("user_id", "created_at");

CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id"         serial PRIMARY KEY,
  "user_id"    integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "endpoint"   text NOT NULL UNIQUE,
  "p256dh"     varchar(200) NOT NULL,
  "auth"       varchar(100) NOT NULL,
  "user_agent" varchar(300),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_push_subscriptions_user" ON "push_subscriptions" ("user_id");
