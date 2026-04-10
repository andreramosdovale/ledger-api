CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "accounts_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "checkpoint_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"reference_date" date NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"accounts_total" integer DEFAULT 0 NOT NULL,
	"accounts_done" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	CONSTRAINT "checkpoint_executions_reference_date_unique" UNIQUE("reference_date")
);
--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"balance" bigint NOT NULL,
	"reference_date" date NOT NULL,
	"last_transaction_id" text NOT NULL,
	"transaction_count" integer DEFAULT 0 NOT NULL,
	"checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text NOT NULL,
	"account_id" text NOT NULL,
	"type" text NOT NULL,
	"amount" bigint NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_id" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_accounts_status" ON "accounts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_checkpoint_account_date" ON "checkpoints" USING btree ("account_id","reference_date");--> statement-breakpoint
CREATE INDEX "idx_checkpoint_account_date" ON "checkpoints" USING btree ("account_id","reference_date");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tx_idempotency" ON "transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_tx_account_created" ON "transactions" USING btree ("account_id","created_at");

-- Trigger
CREATE OR REPLACE FUNCTION prevent_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER_IMMUTABLE: operacao % proibida na tabela transactions', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_no_update_transactions
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER trg_no_delete_transactions
  BEFORE DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();