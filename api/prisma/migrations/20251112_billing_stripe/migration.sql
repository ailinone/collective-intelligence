-- Extend billing_profiles
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'billing_profiles'
      AND column_name = 'default_payment_method_id'
  ) THEN
    ALTER TABLE "billing_profiles"
      ADD COLUMN "default_payment_method_id" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'billing_profiles'
      AND column_name = 'stripe_customer_id'
  ) THEN
    ALTER TABLE "billing_profiles"
      ADD COLUMN "stripe_customer_id" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'billing_profiles'
      AND column_name = 'stripe_portal_url'
  ) THEN
    ALTER TABLE "billing_profiles"
      ADD COLUMN "stripe_portal_url" TEXT;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "billing_profiles_stripe_customer_id_unique"
  ON "billing_profiles" ("stripe_customer_id")
  WHERE "stripe_customer_id" IS NOT NULL;

-- Extend invoices
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invoices' AND column_name = 'hosted_invoice_url'
  ) THEN
    ALTER TABLE "invoices" ADD COLUMN "hosted_invoice_url" TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invoices' AND column_name = 'stripe_invoice_id'
  ) THEN
    ALTER TABLE "invoices" ADD COLUMN "stripe_invoice_id" TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invoices' AND column_name = 'stripe_payment_intent_id'
  ) THEN
    ALTER TABLE "invoices" ADD COLUMN "stripe_payment_intent_id" TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invoices' AND column_name = 'stripe_customer_id'
  ) THEN
    ALTER TABLE "invoices" ADD COLUMN "stripe_customer_id" TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invoices' AND column_name = 'last_synced_at'
  ) THEN
    ALTER TABLE "invoices" ADD COLUMN "last_synced_at" TIMESTAMP WITH TIME ZONE;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "invoices_stripe_invoice_id_unique"
  ON "invoices" ("stripe_invoice_id")
  WHERE "stripe_invoice_id" IS NOT NULL;

-- Extend invoice_items
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invoice_items' AND column_name = 'stripe_price_id'
  ) THEN
    ALTER TABLE "invoice_items" ADD COLUMN "stripe_price_id" TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invoice_items' AND column_name = 'billing_price_id'
  ) THEN
    ALTER TABLE "invoice_items" ADD COLUMN "billing_price_id" UUID;
  END IF;
END;
$$;

-- Extend billing_subscriptions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'billing_subscriptions' AND column_name = 'price_id'
  ) THEN
    ALTER TABLE "billing_subscriptions" ADD COLUMN "price_id" UUID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'billing_subscriptions' AND column_name = 'current_period_start'
  ) THEN
    ALTER TABLE "billing_subscriptions" ADD COLUMN "current_period_start" TIMESTAMP WITH TIME ZONE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'billing_subscriptions' AND column_name = 'current_period_end'
  ) THEN
    ALTER TABLE "billing_subscriptions" ADD COLUMN "current_period_end" TIMESTAMP WITH TIME ZONE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'billing_subscriptions' AND column_name = 'cancel_at_period_end'
  ) THEN
    ALTER TABLE "billing_subscriptions" ADD COLUMN "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'billing_subscriptions' AND column_name = 'stripe_subscription_id'
  ) THEN
    ALTER TABLE "billing_subscriptions" ADD COLUMN "stripe_subscription_id" TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'billing_subscriptions' AND column_name = 'stripe_customer_id'
  ) THEN
    ALTER TABLE "billing_subscriptions" ADD COLUMN "stripe_customer_id" TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'billing_subscriptions' AND column_name = 'stripe_status'
  ) THEN
    ALTER TABLE "billing_subscriptions" ADD COLUMN "stripe_status" TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'billing_subscriptions' AND column_name = 'stripe_default_payment_method_id'
  ) THEN
    ALTER TABLE "billing_subscriptions" ADD COLUMN "stripe_default_payment_method_id" TEXT;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "billing_subscriptions_stripe_subscription_id_unique"
  ON "billing_subscriptions" ("stripe_subscription_id")
  WHERE "stripe_subscription_id" IS NOT NULL;

-- Create billing_plans table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'billing_plans' AND table_schema = 'public'
  ) THEN
    CREATE TABLE "billing_plans" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "organization_id" UUID,
      "name" TEXT NOT NULL,
      "description" TEXT,
      "tier" TEXT,
      "status" TEXT NOT NULL DEFAULT 'active',
      "features" JSONB DEFAULT '{}'::jsonb,
      "trial_days" INTEGER,
      "stripe_product_id" TEXT,
      "metadata" JSONB DEFAULT '{}'::jsonb,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "billing_plans_stripe_product_id_unique"
  ON "billing_plans" ("stripe_product_id")
  WHERE "stripe_product_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "billing_plans_tier_status_idx"
  ON "billing_plans" ("tier", "status");

CREATE INDEX IF NOT EXISTS "billing_plans_organization_idx"
  ON "billing_plans" ("organization_id");

-- Create billing_prices table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'billing_prices' AND table_schema = 'public'
  ) THEN
    CREATE TABLE "billing_prices" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "billing_plan_id" UUID NOT NULL,
      "stripe_price_id" TEXT,
      "currency" TEXT NOT NULL DEFAULT 'USD',
      "amount" NUMERIC(14,4) NOT NULL,
      "billing_cycle" TEXT NOT NULL,
      "interval_count" INTEGER NOT NULL DEFAULT 1,
      "usage_type" TEXT NOT NULL DEFAULT 'licensed',
      "tax_behavior" TEXT,
      "active" BOOLEAN NOT NULL DEFAULT TRUE,
      "metadata" JSONB DEFAULT '{}'::jsonb,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "billing_prices_stripe_price_id_unique"
  ON "billing_prices" ("stripe_price_id")
  WHERE "stripe_price_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "billing_prices_plan_active_idx"
  ON "billing_prices" ("billing_plan_id", "active");

-- Foreign keys
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'billing_plans_organization_id_fkey'
      AND table_name = 'billing_plans'
  ) THEN
    ALTER TABLE "billing_plans"
      ADD CONSTRAINT "billing_plans_organization_id_fkey"
        FOREIGN KEY ("organization_id")
        REFERENCES "billing_profiles" ("organization_id")
        ON DELETE SET NULL
        ON UPDATE CASCADE;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'billing_prices_billing_plan_id_fkey'
      AND table_name = 'billing_prices'
  ) THEN
    ALTER TABLE "billing_prices"
      ADD CONSTRAINT "billing_prices_billing_plan_id_fkey"
        FOREIGN KEY ("billing_plan_id")
        REFERENCES "billing_plans" ("id")
        ON DELETE CASCADE
        ON UPDATE CASCADE;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'billing_subscriptions_price_id_fkey'
      AND table_name = 'billing_subscriptions'
  ) THEN
    ALTER TABLE "billing_subscriptions"
      ADD CONSTRAINT "billing_subscriptions_price_id_fkey"
        FOREIGN KEY ("price_id")
        REFERENCES "billing_prices" ("id")
        ON DELETE SET NULL
        ON UPDATE CASCADE;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'invoice_items_billing_price_id_fkey'
      AND table_name = 'invoice_items'
  ) THEN
    ALTER TABLE "invoice_items"
      ADD CONSTRAINT "invoice_items_billing_price_id_fkey"
        FOREIGN KEY ("billing_price_id")
        REFERENCES "billing_prices" ("id")
        ON DELETE SET NULL
        ON UPDATE CASCADE;
  END IF;
END;
$$;

