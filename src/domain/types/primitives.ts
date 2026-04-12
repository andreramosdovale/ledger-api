import { DomainError } from '@/domain/errors/domain-error';
import {
  MAX_CENTS,
  MIN_CENTS,
  ACCOUNT_ID_REGEX,
  TX_ID_REGEX,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_MAX_LENGTH,
} from '@/domain/constants';
import type { AccountId, TxId, CheckpointId, Cents, IdempotencyKey } from './branded.type';

export function cents(value: number): Cents {
  if (!Number.isInteger(value)) {
    throw new DomainError('INVALID_AMOUNT', 'Amount must be an integer (cents)', {
      value,
    });
  }
  if (value < MIN_CENTS || value > MAX_CENTS) {
    throw new DomainError('AMOUNT_OVERFLOW', 'Amount exceeds allowed limits', {
      value,
    });
  }
  return value as Cents;
}

export function addCents(a: Cents, b: Cents): Cents {
  return cents((a as number) + (b as number));
}

export function subCents(a: Cents, b: Cents): Cents {
  return cents((a as number) - (b as number));
}

export function accountId(value: string): AccountId {
  if (!ACCOUNT_ID_REGEX.test(value)) {
    throw new DomainError('INVALID_ACCOUNT_ID', 'Invalid account ID format', { value });
  }
  return value as AccountId;
}

export function txId(value: string): TxId {
  if (!TX_ID_REGEX.test(value)) {
    throw new DomainError('INVALID_TX_ID', 'Invalid transaction ID format', { value });
  }
  return value as TxId;
}

export function checkpointId(value: string): CheckpointId {
  return value as CheckpointId;
}

export function idempotencyKey(value: string): IdempotencyKey {
  if (value.length < IDEMPOTENCY_KEY_MIN_LENGTH || value.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new DomainError(
      'INVALID_IDEMPOTENCY_KEY',
      `Idempotency key must be between ${IDEMPOTENCY_KEY_MIN_LENGTH} and ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
      { length: value.length },
    );
  }
  return value as IdempotencyKey;
}
