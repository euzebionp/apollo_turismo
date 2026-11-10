// Cifragem de dados pessoais (LGPD) com Web Crypto, nativo no Workers.
// - CPF/RG: AES-256-GCM, saída = base64(iv[12] || ciphertext)
// - CPF também vira HMAC-SHA256 (hex) para busca e unicidade sem decifrar.

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function exigirChave(b64: string | undefined, nome: string): Uint8Array {
  if (!b64) throw new Error(`Secret ${nome} não configurado`);
  const bytes = b64ToBytes(b64);
  if (bytes.length !== 32) throw new Error(`${nome} deve ter 32 bytes (base64)`);
  return bytes;
}

const cacheChaves = new Map<string, Promise<CryptoKey>>();

function chaveAes(b64: string | undefined): Promise<CryptoKey> {
  const k = 'aes:' + b64;
  if (!cacheChaves.has(k)) {
    cacheChaves.set(k, crypto.subtle.importKey('raw', exigirChave(b64, 'DATA_ENC_KEY'), 'AES-GCM', false, ['encrypt', 'decrypt']));
  }
  return cacheChaves.get(k)!;
}

function chaveHmac(b64: string | undefined, nome = 'DATA_HMAC_KEY'): Promise<CryptoKey> {
  const k = 'hmac:' + b64;
  if (!cacheChaves.has(k)) {
    cacheChaves.set(k, crypto.subtle.importKey('raw', exigirChave(b64, nome), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
  }
  return cacheChaves.get(k)!;
}

export async function cifrar(texto: string, chaveB64: string | undefined): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await chaveAes(chaveB64), enc.encode(texto)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return bytesToB64(out);
}

export async function decifrar(b64: string, chaveB64: string | undefined): Promise<string> {
  const raw = b64ToBytes(b64);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await chaveAes(chaveB64), raw.slice(12));
  return dec.decode(pt);
}

export async function hashCpf(cpf: string, chaveB64: string | undefined): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await chaveHmac(chaveB64), enc.encode(cpf));
  return toHex(new Uint8Array(sig));
}

/** HMAC-SHA256 com chave em texto (usado na assinatura de webhook do Mercado Pago). */
export async function hmacHex(chaveTexto: string, mensagem: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(chaveTexto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(mensagem))));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparação em tempo constante (não vaza, pelo tempo de resposta, quantos caracteres batem). */
export function iguaisTempoConstante(a: string, b: string): boolean {
  const ea = enc.encode(a);
  const eb = enc.encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
