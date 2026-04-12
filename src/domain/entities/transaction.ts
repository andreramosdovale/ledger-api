import type { AccountId, TxId, Cents, IdempotencyKey } from '@/domain/types/branded.type';
import { TransactionType } from '../types/transaction.type';

export interface Transaction {
  readonly id: TxId;
  readonly accountId: AccountId;
  readonly type: TransactionType;
  readonly amount: Cents;
  readonly description: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly requestId: string;
  readonly createdAt: Date;
  readonly metadata: Record<string, unknown>;
}
