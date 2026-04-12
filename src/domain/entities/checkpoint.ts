import type { AccountId, CheckpointId, TxId, Cents } from '@/domain/types/branded.type';

export interface Checkpoint {
  readonly id: CheckpointId;
  readonly accountId: AccountId;
  readonly balance: Cents;
  readonly referenceDate: string;
  readonly lastTransactionId: TxId;
  readonly transactionCount: number;
  readonly checksum: string;
  readonly createdAt: Date;
}
