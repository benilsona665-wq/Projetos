import type { Product } from '../types';

export function normalizeBarcode(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .replace(/[\r\n\t\u0000-\u001F\u007F]/g, '')
    .trim();
}

export function findProductByBarcodeOrCode(
  products: Product[],
  rawCode: string
): Product | undefined {
  const clean = normalizeBarcode(rawCode);
  if (!clean) return undefined;

  const cleanUpper = clean.toUpperCase();

  // 1. Exact barcode match (case-insensitive for alphanumeric Code-128 / Code-39)
  const directBarcode = products.find(
    (p) => p.barcode && p.barcode.trim().toUpperCase() === cleanUpper
  );
  if (directBarcode) return directBarcode;

  // 2. UPC-A (12 digits) <-> EAN-13 (leading '0' + 12 digits) equivalence
  if (/^\d{12,13}$/.test(clean)) {
    const upcEanMatch = products.find((p) => {
      const b = (p.barcode || '').trim();
      if (!/^\d{12,13}$/.test(b)) return false;
      if (clean.length === 12 && b === `0${clean}`) return true;
      if (clean.length === 13 && clean.startsWith('0') && b === clean.slice(1)) return true;
      return false;
    });
    if (upcEanMatch) return upcEanMatch;
  }

  // 3. Exact internal product code match
  return products.find((p) => p.code.trim().toUpperCase() === cleanUpper);
}

export function fieldOrUnregistered(value: string | null | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : 'Não registado';
}
