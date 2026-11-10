// Armazenamento e entrega das fotos enviadas pelo painel.
// Usa o R2 (binding FOTOS) quando existir; senão guarda no D1 (tabela fotos).
import type { Env } from './types';
import { agoraISO } from './util';

export const LIMITE_BYTES = 1_800_000; // D1 aceita até 2 MB por linha
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MIME_POR_EXT: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
export const REGEX_URL_FOTO = /^\/fotos\/[0-9a-f]{32}\.(jpg|png|webp)$/;

/** Confere a assinatura do arquivo — não confia só no Content-Type enviado. */
function mimeReal(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

export type ResultadoUpload = { ok: true; url: string; id: string; tamanho: number } | { ok: false; status: 400 | 413; mensagem: string };

export async function salvarFoto(env: Env, corpo: ArrayBuffer, nomeOriginal: string | null, usuarioId: string): Promise<ResultadoUpload> {
  if (corpo.byteLength === 0) return { ok: false, status: 400, mensagem: 'Arquivo vazio' };
  if (corpo.byteLength > LIMITE_BYTES) return { ok: false, status: 413, mensagem: 'Imagem grande demais (máx. 1,8 MB depois de reduzida)' };
  const bytes = new Uint8Array(corpo);
  const mime = mimeReal(bytes);
  if (!mime) return { ok: false, status: 400, mensagem: 'Formato não suportado. Envie JPG, PNG ou WebP.' };

  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const ext = EXT[mime];
  const nome = nomeOriginal ? nomeOriginal.slice(0, 120) : null;

  if (env.FOTOS) {
    await env.FOTOS.put(`fotos/${id}.${ext}`, corpo, { httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' } });
    await env.DB.prepare(`INSERT INTO fotos (id, mime, tamanho, dados, armazenamento, nome_original, enviado_por, criado_em) VALUES (?, ?, ?, NULL, 'r2', ?, ?, ?)`)
      .bind(id, mime, corpo.byteLength, nome, usuarioId, agoraISO()).run();
  } else {
    await env.DB.prepare(`INSERT INTO fotos (id, mime, tamanho, dados, armazenamento, nome_original, enviado_por, criado_em) VALUES (?, ?, ?, ?, 'd1', ?, ?, ?)`)
      .bind(id, mime, corpo.byteLength, corpo, nome, usuarioId, agoraISO()).run();
  }
  return { ok: true, url: `/fotos/${id}.${ext}`, id, tamanho: corpo.byteLength };
}

/** GET /fotos/<id>.<ext> — público, com cache longo (a URL nunca muda de conteúdo). */
export async function servirFoto(env: Env, req: Request, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  const url = new URL(req.url);
  if (!REGEX_URL_FOTO.test(url.pathname)) return new Response('Não encontrada', { status: 404 });
  const [id, ext] = url.pathname.slice('/fotos/'.length).split('.');

  const cache = (caches as unknown as { default: Cache }).default;
  const emCache = await cache.match(req);
  if (emCache) return emCache;

  const cabecalhos = {
    'Content-Type': MIME_POR_EXT[ext],
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    ETag: `"${id}"`,
  };
  if (req.headers.get('If-None-Match') === `"${id}"`) return new Response(null, { status: 304, headers: cabecalhos });

  let corpo: ArrayBuffer | ReadableStream | null = null;
  if (env.FOTOS) {
    const obj = await env.FOTOS.get(`fotos/${id}.${ext}`);
    if (obj) corpo = obj.body;
  }
  if (!corpo) {
    const row = await env.DB.prepare(`SELECT dados FROM fotos WHERE id = ? AND armazenamento = 'd1'`).bind(id).first<{ dados: number[] | ArrayBuffer | null }>();
    if (row?.dados) corpo = row.dados instanceof ArrayBuffer ? row.dados : new Uint8Array(row.dados).buffer;
  }
  if (!corpo) return new Response('Não encontrada', { status: 404 });

  const resp = new Response(corpo, { headers: cabecalhos });
  ctx.waitUntil(cache.put(req, resp.clone()));
  return resp;
}
