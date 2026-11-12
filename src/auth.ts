// Autenticação e autorização do painel administrativo.
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from './types';
import { iguaisTempoConstante, toHex } from './crypto';
import { agoraISO, log } from './util';

/** Catálogo de permissões que o MASTER pode conceder. "usuarios.gerenciar" é exclusiva do MASTER. */
export const PERMISSOES: Record<string, string> = {
  'viagens.editar': 'Cadastrar e editar viagens (roteiro, fotos, vagas, venda ativa)',
  'precos.alterar': 'Alterar preços de sinal e integral',
  'reservas.ver': 'Ver reservas e contato dos passageiros',
  'reservas.cancelar': 'Cancelar reservas e liberar vagas',
  'manifesto.exportar': 'Gerar lista ANTT/DER (CPF e RG completos)',
  'financeiro.ver': 'Ver valores recebidos e pendências de estorno',
  'financeiro.estornar': 'Registrar estornos realizados',
  'pagamentos.registrar': 'Registrar pagamentos recebidos em mãos ou por transferência',
  'despesas.editar': 'Lançar e apagar despesas da viagem (financeiro)',
  'auditoria.ver': 'Ver o registro de atividades do painel',
};
export const PERMISSAO_MASTER = 'usuarios.gerenciar';

export interface UsuarioSessao {
  id: string;
  usuario: string;
  nome: string;
  papel: 'MASTER' | 'OPERADOR';
  permissoes: string[];
  trocar_senha: boolean;
}
export type Vars = { Variables: { u: UsuarioSessao; tokenHash: string } };
type Ctx = Context<{ Bindings: Env } & Vars>;

const ITERACOES = 100_000;            // máximo suportado pelo PBKDF2 do Workers
const SESSAO_HORAS = 12;
const MAX_FALHAS = 5;
const BLOQUEIO_MIN = 15;
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// Senhas
// ---------------------------------------------------------------------------
export async function hashSenha(senha: string, saltHex?: string, iteracoes = ITERACOES) {
  const salt = saltHex ? hexParaBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const chave = await crypto.subtle.importKey('raw', enc.encode(senha), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iteracoes }, chave, 256);
  return { hash: toHex(new Uint8Array(bits)), salt: toHex(salt), iteracoes };
}

export function validarForcaSenha(senha: string): string | null {
  if (typeof senha !== 'string' || senha.length < 10) return 'A senha precisa ter pelo menos 10 caracteres';
  if (senha.length > 128) return 'Senha longa demais';
  if (!/[A-Za-z]/.test(senha) || !/\d/.test(senha)) return 'Use letras e números';
  return null;
}

function hexParaBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sha256Hex(texto: string) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(texto))));
}

export function normalizarUsuario(u: unknown) {
  return String(u ?? '').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------
export async function auditar(env: Env, u: { id: string; usuario: string } | null, acao: string, alvo: string | null, detalhe: unknown, ip?: string | null) {
  await env.DB.prepare(`INSERT INTO auditoria (id, usuario_id, usuario, acao, alvo, detalhe, ip, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), u?.id ?? null, u?.usuario ?? null, acao, alvo, detalhe == null ? null : JSON.stringify(detalhe), ip ?? null, agoraISO())
    .run();
}
export const registrar = (c: Ctx, acao: string, alvo: string | null = null, detalhe: unknown = null) =>
  auditar(c.env, c.get('u'), acao, alvo, detalhe, c.req.header('CF-Connecting-IP'));

// ---------------------------------------------------------------------------
// Login / sessão
// ---------------------------------------------------------------------------
interface UsuarioRow {
  id: string; usuario: string; nome: string; papel: 'MASTER' | 'OPERADOR'; permissoes_json: string;
  senha_hash: string; senha_salt: string; senha_iteracoes: number; trocar_senha: number; ativo: number;
  tentativas_falhas: number; bloqueado_ate: string | null;
}

/** Cria o MASTER no primeiro login, a partir dos secrets. Depois disso os secrets são ignorados. */
async function bootstrapMaster(env: Env, usuario: string, senha: string): Promise<boolean> {
  const existe = await env.DB.prepare(`SELECT 1 FROM usuarios WHERE papel = 'MASTER'`).first();
  if (existe || !env.MASTER_USUARIO || !env.MASTER_SENHA) return false;
  if (normalizarUsuario(env.MASTER_USUARIO) !== usuario || !iguaisTempoConstante(senha, env.MASTER_SENHA)) return false;
  const h = await hashSenha(senha);
  const agora = agoraISO();
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(`INSERT INTO usuarios (id, usuario, nome, papel, permissoes_json, senha_hash, senha_salt, senha_iteracoes, criado_em, atualizado_em)
                          VALUES (?, ?, 'Administrador master', 'MASTER', '[]', ?, ?, ?, ?, ?)`)
      .bind(id, usuario, h.hash, h.salt, h.iteracoes, agora, agora).run();
  } catch { return false; } // outro login simultâneo já criou
  await auditar(env, { id, usuario }, 'master_criado', id, null);
  log('master_criado', { usuario });
  return true;
}

export async function login(env: Env, body: any, ip: string, ua: string) {
  const usuario = normalizarUsuario(body?.usuario);
  const senha = String(body?.senha ?? '');
  const falha = { status: 401 as const, body: { ok: false, erro: { codigo: 'LOGIN_INVALIDO', mensagem: 'Usuário ou senha incorretos' } } };
  if (!usuario || !senha || senha.length > 128) return falha;

  await bootstrapMaster(env, usuario, senha);

  const row = await env.DB.prepare(`SELECT * FROM usuarios WHERE usuario = ?`).bind(usuario).first<UsuarioRow>();
  const agora = agoraISO();
  if (!row) {
    await hashSenha(senha); // mesmo custo de tempo: não revela se o usuário existe
    await auditar(env, null, 'login_falhou', null, { usuario }, ip);
    return falha;
  }
  if (row.bloqueado_ate && row.bloqueado_ate > agora) {
    return { status: 429 as const, body: { ok: false, erro: { codigo: 'BLOQUEADO', mensagem: `Muitas tentativas. Tente novamente após ${BLOQUEIO_MIN} minutos.` } } };
  }
  const h = await hashSenha(senha, row.senha_salt, row.senha_iteracoes);
  if (!iguaisTempoConstante(h.hash, row.senha_hash) || !row.ativo) {
    const falhas = row.tentativas_falhas + 1;
    const bloqueio = falhas >= MAX_FALHAS ? new Date(Date.now() + BLOQUEIO_MIN * 60_000).toISOString() : null;
    await env.DB.prepare(`UPDATE usuarios SET tentativas_falhas = ?, bloqueado_ate = ? WHERE id = ?`)
      .bind(bloqueio ? 0 : falhas, bloqueio, row.id).run();
    await auditar(env, row, row.ativo ? 'login_falhou' : 'login_usuario_inativo', row.id, bloqueio ? { bloqueado: true } : null, ip);
    return falha;
  }

  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const expira = new Date(Date.now() + SESSAO_HORAS * 3600_000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sessoes (token_hash, usuario_id, criado_em, expira_em, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(await sha256Hex(token), row.id, agora, expira, ip, ua.slice(0, 200)),
    env.DB.prepare(`UPDATE usuarios SET tentativas_falhas = 0, bloqueado_ate = NULL, ultimo_login_em = ? WHERE id = ?`).bind(agora, row.id),
    env.DB.prepare(`DELETE FROM sessoes WHERE expira_em < ?`).bind(agora),
  ]);
  await auditar(env, row, 'login', row.id, null, ip);
  return { status: 200 as const, body: { ok: true, data: { token, expira_em: expira, usuario: paraSessao(row) } } };
}

function paraSessao(r: UsuarioRow): UsuarioSessao {
  return {
    id: r.id, usuario: r.usuario, nome: r.nome, papel: r.papel,
    permissoes: r.papel === 'MASTER' ? [...Object.keys(PERMISSOES), PERMISSAO_MASTER] : JSON.parse(r.permissoes_json).filter((p: string) => p in PERMISSOES),
    trocar_senha: !!r.trocar_senha,
  };
}

/** Exige sessão válida em todas as rotas do painel, exceto /login. */
export const exigirSessao: MiddlewareHandler<{ Bindings: Env } & Vars> = async (c, next) => {
  if (c.req.path.endsWith('/login')) return next();
  const auth = c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const naoAutorizado = () => c.json({ ok: false, erro: { codigo: 'NAO_AUTORIZADO', mensagem: 'Faça login novamente' } }, 401);
  if (!/^[0-9a-f]{64}$/.test(token)) return naoAutorizado();
  const tokenHash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT u.* FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.token_hash = ? AND s.expira_em > ? AND u.ativo = 1`,
  ).bind(tokenHash, agoraISO()).first<UsuarioRow>();
  if (!row) return naoAutorizado();
  const u = paraSessao(row);
  c.set('u', u);
  c.set('tokenHash', tokenHash);
  // Quem precisa trocar a senha só acessa /me e /logout até trocar.
  if (u.trocar_senha && !/\/(me|me\/senha|logout)$/.test(c.req.path)) {
    return c.json({ ok: false, erro: { codigo: 'TROCAR_SENHA', mensagem: 'Defina uma nova senha para continuar' } }, 403);
  }
  await next();
};

export function pode(c: Ctx, permissao: string) {
  return c.get('u').permissoes.includes(permissao);
}

/** Middleware de rota: exige a permissão informada. */
export const exigir = (permissao: string): MiddlewareHandler<{ Bindings: Env } & Vars> => async (c, next) => {
  if (!pode(c, permissao)) {
    return c.json({ ok: false, erro: { codigo: 'SEM_PERMISSAO', mensagem: 'Seu usuário não tem permissão para esta ação', permissao } }, 403);
  }
  await next();
};

export async function encerrarSessoes(env: Env, usuarioId: string, excetoHash?: string) {
  await env.DB.prepare(`DELETE FROM sessoes WHERE usuario_id = ? AND token_hash <> ?`).bind(usuarioId, excetoHash ?? '').run();
}
