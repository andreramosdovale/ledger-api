import type { AccountId } from '@/domain/types/branded.type';
import { Currency, AccountStatus } from '../types/account.type';

export interface Account {
  readonly id: AccountId;
  readonly externalId: string;
  readonly currency: Currency;
  readonly status: AccountStatus;
  readonly createdAt: Date;
  readonly metadata: Record<string, unknown>;
}
