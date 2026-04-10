import {
  pgTable,
  text,
  bigint,
  integer,
  timestamp,
  date,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    externalId: text('external_id').notNull().unique(),
    currency: text('currency').notNull().default('BRL'),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb('metadata').notNull().default({}),
  },
  (t) => [index('idx_accounts_status').on(t.status)],
);

export const transactions = pgTable(
  'transactions',
  {
    id: text('id').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    type: text('type').notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    description: text('description').notNull().default(''),
    idempotencyKey: text('idempotency_key').notNull(),
    requestId: text('request_id').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb('metadata').notNull().default({}),
  },
  (t) => [
    uniqueIndex('idx_tx_idempotency').on(t.idempotencyKey),
    index('idx_tx_account_created').on(t.accountId, t.createdAt),
  ],
);

export const checkpoints = pgTable(
  'checkpoints',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    balance: bigint('balance', { mode: 'number' }).notNull(),
    referenceDate: date('reference_date').notNull(),
    lastTransactionId: text('last_transaction_id').notNull(),
    transactionCount: integer('transaction_count').notNull().default(0),
    checksum: text('checksum').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_checkpoint_account_date').on(t.accountId, t.referenceDate),
    index('idx_checkpoint_account_date').on(t.accountId, t.referenceDate),
  ],
);

export const checkpointExecutions = pgTable('checkpoint_executions', {
  id: text('id').primaryKey(),
  referenceDate: date('reference_date').notNull().unique(),
  status: text('status').notNull().default('RUNNING'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  accountsTotal: integer('accounts_total').notNull().default(0),
  accountsDone: integer('accounts_done').notNull().default(0),
  errorMessage: text('error_message'),
});
