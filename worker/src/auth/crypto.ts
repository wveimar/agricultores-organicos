import { ApiError } from '../http';
import { ALL_ROLES, JwtPayload, UserRole } from '../types';

// ─────────────────────────────── base64url ───────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  // btoa/atob trabajan con base64 clásico: hay que reponer relleno y símbolos.
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ──────────────────────────────── JWT HS256 ────────────────────────────────

/** Vida de la sesión. Corta a propósito: no hay refresh token todavía. */
const TOKEN_TTL_SECONDS = 8 * 60 * 60;

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) {
    // Fallar ruidosamente en el arranque es mejor que firmar con clave vacía.
    throw new Error('JWT_SECRET no está configurado en el entorno del Worker.');
  }
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export interface SignInput {
  readonly sub: string;
  readonly email: string;
  readonly nombre: string;
  readonly roles: readonly UserRole[];
}

export async function signJwt(input: SignInput, secret: string): Promise<{ token: string; expiresAt: number }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + TOKEN_TTL_SECONDS;

  const header = toBase64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = toBase64Url(
    encoder.encode(JSON.stringify({ ...input, iat: issuedAt, exp: expiresAt })),
  );

  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${payload}`));

  return {
    token: `${header}.${payload}.${toBase64Url(new Uint8Array(signature))}`,
    expiresAt: expiresAt * 1000,
  };
}

/**
 * Verifica firma y vigencia. Lanza 401 ante cualquier anomalía.
 *
 * Puntos que suelen fallar en implementaciones caseras y aquí sí se cubren:
 * · Se rechaza `alg: "none"` y cualquier algoritmo distinto de HS256, que es
 *   el ataque clásico de confusión de algoritmo.
 * · La comparación de la firma la hace `crypto.subtle.verify`, que es de
 *   tiempo constante; comparar cadenas con `===` filtra información por el
 *   tiempo de respuesta.
 * · Se valida `exp` **después** de la firma, para no dar pistas sobre tokens
 *   manipulados.
 */
export async function verifyJwt(token: string, secret: string): Promise<JwtPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw ApiError.unauthorized('Token con formato inválido.');
  }

  const [headerPart, payloadPart, signaturePart] = parts;

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(decoder.decode(fromBase64Url(headerPart)));
  } catch {
    throw ApiError.unauthorized('Token con cabecera ilegible.');
  }

  if (header.alg !== 'HS256') {
    throw ApiError.unauthorized('Algoritmo de token no admitido.');
  }

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    fromBase64Url(signaturePart),
    encoder.encode(`${headerPart}.${payloadPart}`),
  );

  if (!valid) {
    throw ApiError.unauthorized('Firma del token inválida.');
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(decoder.decode(fromBase64Url(payloadPart)));
  } catch {
    throw ApiError.unauthorized('Token con contenido ilegible.');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    throw ApiError.unauthorized('La sesión expiró. Vuelve a entrar.');
  }

  // Un token firmado por nosotros no debería traer roles desconocidos, pero se
  // filtra igual: si mañana se retira un rol, los tokens vivos no lo conservan.
  const roles = Array.isArray(payload.roles)
    ? payload.roles.filter((role): role is UserRole => ALL_ROLES.includes(role as UserRole))
    : [];

  return { ...payload, roles };
}

// ─────────────────────────────── Contraseñas ───────────────────────────────

/**
 * PBKDF2-SHA256. Es lo que ofrece WebCrypto en Workers; bcrypt o argon2
 * necesitarían WASM.
 *
 * 100.000 iteraciones, no las 210.000 que recomienda OWASP (2023) para
 * PBKDF2-HMAC-SHA256: es el **tope duro** que impone el runtime real de
 * Cloudflare Workers (`workerd`). Miniflare, la simulación que usa `wrangler
 * dev --local`, no aplica ese límite — por eso el login funcionaba en local y
 * fallaba con `NotSupportedError: Pbkdf2 failed: iteration counts above
 * 100000 are not supported` en cuanto se probó contra el edge real
 * (`wrangler dev --remote` o un despliegue de verdad). Solo se detecta
 * probando contra Cloudflare de verdad, no contra la simulación.
 */
const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH_BITS = 256;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    KEY_LENGTH_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/** Comparación en tiempo constante: no cortocircuita al primer byte distinto. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterationsRaw, saltRaw, hashRaw] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iterationsRaw || !saltRaw || !hashRaw) {
    return false;
  }

  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) {
    return false;
  }

  // Se rederiva con las iteraciones guardadas, no con la constante actual: así
  // subir PBKDF2_ITERATIONS no invalida las contraseñas ya existentes.
  const candidate = await derive(password, fromBase64Url(saltRaw), iterations);
  return timingSafeEqual(candidate, fromBase64Url(hashRaw));
}
