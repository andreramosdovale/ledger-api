import { v7 } from 'uuid';

export function generateId(prefix: 'acc' | 'tx' | 'chk' | 'exec'): string {
  return `${prefix}_${v7()}`;
}
