export const MAX_CENTS = 999_999_999_99;
export const MIN_CENTS = -MAX_CENTS;

export const ACCOUNT_ID_REGEX = /^acc_[a-zA-Z0-9]{20}$/;
export const TX_ID_REGEX = /^tx_[a-zA-Z0-9]{20}$/;

export const IDEMPOTENCY_KEY_MIN_LENGTH = 1;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 100;
