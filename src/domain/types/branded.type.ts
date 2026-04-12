declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

export type AccountId = Brand<string, 'AccountId'>;
export type TxId = Brand<string, 'TransactionId'>;
export type CheckpointId = Brand<string, 'CheckpointId'>;
export type Cents = Brand<number, 'Cents'>;
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;
