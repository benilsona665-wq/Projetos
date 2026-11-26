// Auth token and lock flag are held exclusively in JS memory so private credentials
// never persist in browser localStorage/sessionStorage across reloads or shared counters.
let memoryToken: string | null = null;
let memoryLocked = false;

export function getStoredToken(): string | null {
  return memoryToken;
}

export function setStoredToken(token: string | null): void {
  memoryToken = token;
}

export function getStoredLocked(): boolean {
  return memoryLocked;
}

export function setStoredLocked(locked: boolean): void {
  memoryLocked = locked;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  shortages?: Array<{ productId: string; productName: string; requested: number; available: number }>;

  constructor(
    message: string,
    status: number,
    code?: string,
    shortages?: Array<{ productId: string; productName: string; requested: number; available: number }>
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.shortages = shortages;
  }
}

export async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  if (
    method !== 'GET' &&
    method !== 'HEAD' &&
    typeof navigator !== 'undefined' &&
    navigator.onLine === false
  ) {
    throw new ApiError(
      'Sem ligação à internet. Vendas, compras, devoluções e alterações de stock estão bloqueadas no modo offline.',
      0,
      'OFFLINE_BLOCKED'
    );
  }

  const token = getStoredToken();
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(url, { ...options, headers, cache: 'no-store' });
  const text = await res.text();
  let data: any = null;
  let parseFailed = false;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
      parseFailed = true;
    }
  }

  if (!res.ok) {
    throw new ApiError(
      data?.error || `Erro na comunicação com o servidor (${res.status}).`,
      res.status,
      data?.code,
      data?.shortages
    );
  }

  if (res.status === 204) {
    return undefined as T;
  }

  if (parseFailed) {
    throw new ApiError(
      'O servidor devolveu uma resposta inválida (não JSON). Se o servidor acabou de reiniciar ou a ligação foi interrompida, recarregue a página e tente novamente.',
      res.status,
      'INVALID_SERVER_RESPONSE'
    );
  }

  if (data === null || data === undefined) {
    throw new ApiError(
      'O servidor devolveu uma resposta vazia. Recarregue a página e tente novamente.',
      res.status,
      'EMPTY_SERVER_RESPONSE'
    );
  }

  return data as T;
}

