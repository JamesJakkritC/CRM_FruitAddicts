/** Money helpers. Internally everything is integer satang (1 THB = 100 satang). */

export const bahtToSatang = (baht: number): number => Math.round(baht * 100);
export const satangToBaht = (satang: number): number => satang / 100;

/** Format satang as a THB string, e.g. 12550 -> "125.50". */
export const formatThb = (satang: number): string => (satang / 100).toFixed(2);

export function assertNonNegativeInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer (satang), got: ${value}`);
  }
  return value;
}
