// API administrativa — sessão por usuário (login e senha) e permissões por usuário.
// Em produção, coloque também /admin* e /api/admin/* atrás do Cloudflare Access.
import { Hono } from 'hono';
import type { Env } from './types';
import { decifrar } from './crypto';
import { criarProvider } from './pix/provider';
import { codigoReserva } from './whatsapp';
import { formatarCpf, mascararCpf } from './validacao';
import { agoraISO } from './util';
import { REGEX_URL_FOTO, salvarFoto } from './fotos';
import {
  PERMISSOES, PERMISSAO_MASTER, type Vars, encerrarSessoes, exigir, exigirSessao, hashSenha, login,
  normalizarUsuario, pode, registrar, validarForcaSenha,
} from './auth';

const admin = new Hono<{ Bindings: Env } & Vars>();

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------
admin.use('*', exigirSessao);

admin.post('/login', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? '';
  if (c.env.LOGIN_LIMITER) {
    const { success } = await c.env.LOGIN_LIMITER.limit({ key: `login:${ip}` });
    if (!success) return c.json({ ok: false, erro: { codigo: 'MUITAS_TENTATIVAS', mensagem: 'Muitas tentativas. Aguarde um minuto.' } }, 429);
  }
  const r = await login(c.env, await c.req.json().catch(() => null), ip, c.req.header('User-Agent') ?? '');
  return c.json(r.body, r.status);
});

admin.post('/logout', async (c) => {
  await c.env.DB.prepare(`DELETE FROM sessoes WHERE token_hash = ?`).bind(c.get('tokenHash')).run();
  await registrar(c, 'logout');
  return c.json({ ok: true });
});

admin.get('/me', (c) => c.json({ ok: true, data: { usuario: c.get('u'), catalogo: PERMISSOES } }));

admin.post('/me/senha', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const u = c.get('u');
  const row = await c.env.DB.prepare(`SELECT senha_hash, senha_salt, senha_iteracoes FROM usuarios WHERE id = ?`).bind(u.id).first<any>();
  const atual = await hashSenha(String(b?.senha_atual ?? ''), row.senha_salt, row.senha_iteracoes);
  if (atual.hash !== row.senha_hash) return c.json(falha('SENHA_ATUAL_INCORRETA', 'Senha atual incorreta', { senha_atual: 'Incorreta' }), 400);
  const erro = validarForcaSenha(b?.nova_senha);
  if (erro) return c.json(falha('SENHA_FRACA', erro, { nova_senha: erro }), 400);
  if (b.nova_senha === b.senha_atual) return c.json(falha('SENHA_IGUAL', 'A nova senha deve ser diferente da atual', { nova_senha: 'Igual à atual' }), 400);
  const h = await hashSenha(b.nova_senha);
  await c.env.DB.prepare(`UPDATE usuarios SET senha_hash = ?, senha_salt = ?, senha_iteracoes = ?, trocar_senha = 0, atualizado_em = ? WHERE id = ?`)
    .bind(h.hash, h.salt, h.iteracoes, agoraISO(), u.id).run();
  await encerrarSessoes(c.env, u.id, c.get('tokenHash')); // derruba outros aparelhos
  await registrar(c, 'senha_alterada', u.id);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Usuários (exclusivo do MASTER)
// ---------------------------------------------------------------------------
const soMaster = exigir(PERMISSAO_MASTER);

function lerPermissoes(lista: unknown): string[] | null {
  if (!Array.isArray(lista)) return null;
  const validas = [...new Set(lista.map(String))];
  return validas.every((p) => p in PERMISSOES) ? validas : null;
}

admin.get('/usuarios', soMaster, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, usuario, nome, papel, permissoes_json, ativo, trocar_senha, ultimo_login_em, bloqueado_ate, criado_em
       FROM usuarios ORDER BY papel = 'MASTER' DESC, nome COLLATE NOCASE`,
  ).all<any>();
  return c.json({
    ok: true,
    data: results.map(({ permissoes_json, ...u }) => ({ ...u, permissoes: JSON.parse(permissoes_json), ativo: !!u.ativo, trocar_senha: !!u.trocar_senha })),
    catalogo: PERMISSOES,
  });
});

admin.post('/usuarios', soMaster, async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const campos: Record<string, string> = {};
  const usuario = normalizarUsuario(b?.usuario);
  const nome = String(b?.nome ?? '').trim();
  if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) campos.usuario = 'Use 3 a 40 letras minúsculas, números, ponto, hífen ou _';
  if (nome.length < 2 || nome.length > 80) campos.nome = 'Informe o nome';
  const permissoes = lerPermissoes(b?.permissoes);
  if (!permissoes) campos.permissoes = 'Permissões inválidas';
  const erroSenha = validarForcaSenha(b?.senha);
  if (erroSenha) campos.senha = erroSenha;
  if (Object.keys(campos).length) return c.json(falha('DADOS_INVALIDOS', 'Verifique os campos', campos), 400);
  const h = await hashSenha(b.senha);
  const id = crypto.randomUUID();
  const agora = agoraISO();
  try {
    await c.env.DB.prepare(`INSERT INTO usuarios (id, usuario, nome, papel, permissoes_json, senha_hash, senha_salt, senha_iteracoes, trocar_senha, criado_por, criado_em, atualizado_em)
                            VALUES (?, ?, ?, 'OPERADOR', ?, ?, ?, ?, 1, ?, ?, ?)`)
      .bind(id, usuario, nome, JSON.stringify(permissoes), h.hash, h.salt, h.iteracoes, c.get('u').id, agora, agora).run();
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) return c.json(falha('USUARIO_EM_USO', 'Este nome de usuário já existe', { usuario: 'Em uso' }), 409);
    throw e;
  }
  await registrar(c, 'usuario_criado', id, { usuario, permissoes });
  return c.json({ ok: true, data: { id } }, 201);
});

admin.put('/usuarios/:id', soMaster, async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const alvo = await c.env.DB.prepare(`SELECT papel, usuario, permissoes_json, ativo FROM usuarios WHERE id = ?`).bind(id).first<any>();
  if (!alvo) return c.json(falha('NAO_ENCONTRADO', 'Usuário não encontrado'), 404);
  if (alvo.papel === 'MASTER') return c.json(falha('MASTER_PROTEGIDO', 'O usuário master não pode ser alterado por aqui'), 403);
  const nome = String(b?.nome ?? '').trim();
  const permissoes = lerPermissoes(b?.permissoes);
  if (nome.length < 2 || !permissoes) return c.json(falha('DADOS_INVALIDOS', 'Verifique os campos', { ...(nome.length < 2 ? { nome: 'Informe o nome' } : {}), ...(!permissoes ? { permissoes: 'Inválidas' } : {}) }), 400);
  const ativo = b?.ativo === false ? 0 : 1;
  await c.env.DB.prepare(`UPDATE usuarios SET nome = ?, permissoes_json = ?, ativo = ?, atualizado_em = ? WHERE id = ?`)
    .bind(nome, JSON.stringify(permissoes), ativo, agoraISO(), id).run();
  if (!ativo) await encerrarSessoes(c.env, id);
  await registrar(c, 'usuario_alterado', id, {
    usuario: alvo.usuario, permissoes_antes: JSON.parse(alvo.permissoes_json), permissoes_depois: permissoes,
    ...(alvo.ativo !== ativo ? { ativo: !!ativo } : {}),
  });
  return c.json({ ok: true });
});

admin.post('/usuarios/:id/senha', soMaster, async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const alvo = await c.env.DB.prepare(`SELECT papel, usuario FROM usuarios WHERE id = ?`).bind(id).first<any>();
  if (!alvo) return c.json(falha('NAO_ENCONTRADO', 'Usuário não encontrado'), 404);
  if (alvo.papel === 'MASTER') return c.json(falha('MASTER_PROTEGIDO', 'O master troca a própria senha em "Minha senha"'), 403);
  const erro = validarForcaSenha(b?.senha);
  if (erro) return c.json(falha('SENHA_FRACA', erro, { senha: erro }), 400);
  const h = await hashSenha(b.senha);
  await c.env.DB.prepare(`UPDATE usuarios SET senha_hash = ?, senha_salt = ?, senha_iteracoes = ?, trocar_senha = 1, tentativas_falhas = 0, bloqueado_ate = NULL, atualizado_em = ? WHERE id = ?`)
    .bind(h.hash, h.salt, h.iteracoes, agoraISO(), id).run();
  await encerrarSessoes(c.env, id);
  await registrar(c, 'senha_redefinida', id, { usuario: alvo.usuario });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------
admin.get('/auditoria', exigir('auditoria.ver'), async (c) => {
  const limite = Math.min(500, Math.max(1, Number(c.req.query('limite') ?? 200)));
  const { results } = await c.env.DB.prepare(
    `SELECT a.criado_em, a.usuario, a.acao, a.alvo, a.detalhe, a.ip FROM auditoria a ORDER BY a.criado_em DESC LIMIT ?`,
  ).bind(limite).all<any>();
  return c.json({ ok: true, data: results.map((r) => ({ ...r, detalhe: r.detalhe ? JSON.parse(r.detalhe) : null })) });
});

const falha = (codigo: string, mensagem: string, campos?: Record<string, string>) =>
  ({ ok: false, erro: { codigo, mensagem, ...(campos ? { campos } : {}) } });

const SQL_OCUPACAO = `
  SUM(CASE WHEN r.status = 'CONFIRMADO' THEN 1 ELSE 0 END) AS confirmadas,
  SUM(CASE WHEN r.status = 'PENDENTE' AND r.expira_em > ?1 THEN 1 ELSE 0 END) AS pendentes,
  COALESCE(SUM(CASE WHEN r.status = 'CONFIRMADO' THEN r.valor_centavos ELSE 0 END), 0) AS arrecadado_centavos`;

// ---------------------------------------------------------------------------
// Viagens
// ---------------------------------------------------------------------------
admin.get('/viagens', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.titulo, v.destino, v.data_partida, v.data_retorno, v.total_vagas,
            v.preco_integral_centavos, v.preco_sinal_centavos, v.ativa, ${SQL_OCUPACAO}
       FROM viagens v LEFT JOIN reservas r ON r.viagem_id = v.id
      GROUP BY v.id ORDER BY v.data_partida DESC`,
  ).bind(agoraISO()).all<any>();
  const verValores = pode(c, 'financeiro.ver');
  return c.json({ ok: true, data: verValores ? results : results.map((v) => ({ ...v, arrecadado_centavos: null })) });
});

admin.get('/viagens/:id', async (c) => {
  const v = await c.env.DB.prepare(`SELECT * FROM viagens WHERE id = ?`).bind(c.req.param('id')).first<any>();
  if (!v) return c.json(falha('NAO_ENCONTRADA', 'Viagem não encontrada'), 404);
  const { programacao_json, fotos_json, ...resto } = v;
  return c.json({ ok: true, data: { ...resto, programacao: JSON.parse(programacao_json), fotos: JSON.parse(fotos_json) } });
});

interface ViagemInput {
  id: string; titulo: string; destino: string; descricao: string | null;
  data_partida: string; data_retorno: string | null; local_embarque: string | null;
  total_vagas: number; preco_integral_centavos: number; preco_sinal_centavos: number;
  programacao: unknown[]; fotos: Record<string, unknown[]>; ativa: number;
}

function validarViagem(b: any, criando: boolean): { ok: true; v: ViagemInput } | { ok: false; campos: Record<string, string> } {
  const campos: Record<string, string> = {};
  const id = String(b?.id ?? '').trim().toLowerCase();
  if (criando && !/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) campos.id = 'Use letras minúsculas, números e hífen (3 a 64)';
  const titulo = String(b?.titulo ?? '').trim();
  if (titulo.length < 3 || titulo.length > 120) campos.titulo = 'Título obrigatório';
  const destino = String(b?.destino ?? '').trim();
  if (destino.length < 2 || destino.length > 120) campos.destino = 'Destino obrigatório';
  const iso = (s: unknown) => { const d = new Date(String(s ?? '')); return isNaN(d.getTime()) ? null : d.toISOString(); };
  const partida = iso(b?.data_partida);
  if (!partida) campos.data_partida = 'Data/hora inválida';
  const retorno = b?.data_retorno ? iso(b.data_retorno) : null;
  if (b?.data_retorno && !retorno) campos.data_retorno = 'Data/hora inválida';
  if (partida && retorno && retorno < partida) campos.data_retorno = 'Retorno antes da partida';
  const vagas = Number(b?.total_vagas);
  if (!Number.isInteger(vagas) || vagas < 1 || vagas > 200) campos.total_vagas = 'Entre 1 e 200';
  const integral = Number(b?.preco_integral_centavos);
  const sinal = Number(b?.preco_sinal_centavos);
  if (!Number.isInteger(integral) || integral < 100) campos.preco_integral_centavos = 'Preço inválido';
  if (!Number.isInteger(sinal) || sinal < 100) campos.preco_sinal_centavos = 'Sinal inválido';
  if (Number.isInteger(integral) && Number.isInteger(sinal) && sinal > integral) campos.preco_sinal_centavos = 'Sinal maior que o integral';
  const programacao = Array.isArray(b?.programacao) ? b.programacao : null;
  if (!programacao) campos.programacao = 'Programação inválida';
  const f = b?.fotos ?? {};
  const fotos = { veiculo: f.veiculo ?? [], hospedagem: f.hospedagem ?? [], destino: f.destino ?? [] };
  if (![fotos.veiculo, fotos.hospedagem, fotos.destino].every(Array.isArray)) campos.fotos = 'Fotos inválidas';
  for (const lista of Object.values(fotos) as any[]) {
    if (Array.isArray(lista) && lista.some((x) => { const u = String(x?.url ?? ''); return !/^https:\/\/\S+$/.test(u) && !REGEX_URL_FOTO.test(u); })) campos.fotos = 'Foto inválida: envie um arquivo ou use um link https://';
  }
  if (Object.keys(campos).length) return { ok: false, campos };
  return {
    ok: true,
    v: {
      id, titulo, destino,
      descricao: String(b?.descricao ?? '').trim() || null,
      data_partida: partida!, data_retorno: retorno,
      local_embarque: String(b?.local_embarque ?? '').trim() || null,
      total_vagas: vagas, preco_integral_centavos: integral, preco_sinal_centavos: sinal,
      programacao: programacao!, fotos, ativa: b?.ativa === false || b?.ativa === 0 ? 0 : 1,
    },
  };
}

admin.post('/viagens', exigir('viagens.editar'), async (c) => {
  const val = validarViagem(await c.req.json().catch(() => null), true);
  if (!val.ok) return c.json(falha('DADOS_INVALIDOS', 'Verifique os campos', val.campos), 400);
  const v = val.v;
  try {
    await c.env.DB.prepare(
      `INSERT INTO viagens (id, titulo, destino, descricao, data_partida, data_retorno, local_embarque, total_vagas,
                            preco_integral_centavos, preco_sinal_centavos, programacao_json, fotos_json, ativa, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(v.id, v.titulo, v.destino, v.descricao, v.data_partida, v.data_retorno, v.local_embarque, v.total_vagas,
      v.preco_integral_centavos, v.preco_sinal_centavos, JSON.stringify(v.programacao), JSON.stringify(v.fotos), v.ativa, agoraISO()).run();
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) return c.json(falha('ID_EM_USO', 'Já existe uma viagem com este identificador', { id: 'Em uso' }), 409);
    throw e;
  }
  await registrar(c, 'viagem_criada', v.id, { titulo: v.titulo, vagas: v.total_vagas, sinal: v.preco_sinal_centavos, integral: v.preco_integral_centavos });
  return c.json({ ok: true, data: { id: v.id } }, 201);
});

admin.put('/viagens/:id', async (c) => {
  const id = c.req.param('id');
  const val = validarViagem(await c.req.json().catch(() => null), false);
  if (!val.ok) return c.json(falha('DADOS_INVALIDOS', 'Verifique os campos', val.campos), 400);
  const v = val.v;
  const antes = await c.env.DB.prepare(`SELECT * FROM viagens WHERE id = ?`).bind(id).first<any>();
  if (!antes) return c.json(falha('NAO_ENCONTRADA', 'Viagem não encontrada'), 404);
  const mudouPreco = antes.preco_integral_centavos !== v.preco_integral_centavos || antes.preco_sinal_centavos !== v.preco_sinal_centavos;
  const mudouOutros = ['titulo', 'destino', 'descricao', 'data_partida', 'data_retorno', 'local_embarque', 'total_vagas', 'ativa'].some((k) => antes[k] !== (v as any)[k])
    || antes.programacao_json !== JSON.stringify(v.programacao) || antes.fotos_json !== JSON.stringify(v.fotos);
  if (mudouPreco && !pode(c, 'precos.alterar')) return c.json(falha('SEM_PERMISSAO', 'Seu usuário não pode alterar preços'), 403);
  if (mudouOutros && !pode(c, 'viagens.editar')) return c.json(falha('SEM_PERMISSAO', 'Seu usuário não pode editar dados da viagem'), 403);
  if (!mudouPreco && !mudouOutros) return c.json({ ok: true, data: { id } });
  // Não deixa reduzir as vagas abaixo do que já está ocupado. Preços novos valem só para reservas novas.
  const res = await c.env.DB.prepare(
    `UPDATE viagens SET titulo = ?2, destino = ?3, descricao = ?4, data_partida = ?5, data_retorno = ?6, local_embarque = ?7,
            total_vagas = ?8, preco_integral_centavos = ?9, preco_sinal_centavos = ?10,
            programacao_json = ?11, fotos_json = ?12, ativa = ?13
      WHERE id = ?1
        AND ?8 >= (SELECT COUNT(*) FROM reservas r WHERE r.viagem_id = ?1
                     AND (r.status = 'CONFIRMADO' OR (r.status = 'PENDENTE' AND r.expira_em > ?14)))`,
  ).bind(id, v.titulo, v.destino, v.descricao, v.data_partida, v.data_retorno, v.local_embarque, v.total_vagas,
    v.preco_integral_centavos, v.preco_sinal_centavos, JSON.stringify(v.programacao), JSON.stringify(v.fotos), v.ativa, agoraISO()).run();
  if (!res.meta.changes) {
    const existe = await c.env.DB.prepare(`SELECT 1 FROM viagens WHERE id = ?`).bind(id).first();
    if (!existe) return c.json(falha('NAO_ENCONTRADA', 'Viagem não encontrada'), 404);
    return c.json(falha('VAGAS_INSUFICIENTES', 'O total de vagas não pode ser menor que as vagas já ocupadas', { total_vagas: 'Abaixo da ocupação atual' }), 409);
  }
  await registrar(c, mudouPreco ? 'preco_alterado' : 'viagem_alterada', id, {
    ...(mudouPreco ? { sinal: [antes.preco_sinal_centavos, v.preco_sinal_centavos], integral: [antes.preco_integral_centavos, v.preco_integral_centavos] } : {}),
    ...(antes.total_vagas !== v.total_vagas ? { vagas: [antes.total_vagas, v.total_vagas] } : {}),
    ...(antes.ativa !== v.ativa ? { a_venda: !!v.ativa } : {}),
  });
  return c.json({ ok: true, data: { id } });
});

// ---------------------------------------------------------------------------
// Fotos (upload do computador). O navegador reduz a imagem antes de enviar.
// ---------------------------------------------------------------------------
admin.post('/fotos', exigir('viagens.editar'), async (c) => {
  const tamanho = Number(c.req.header('Content-Length') ?? 0);
  if (tamanho > 2_000_000) return c.json(falha('MUITO_GRANDE', 'Imagem grande demais (máx. 1,8 MB depois de reduzida)'), 413);
  let nome: string | null = null;
  try { nome = decodeURIComponent(c.req.header('X-Nome-Arquivo') ?? '') || null; } catch { /* nome opcional */ }
  const r = await salvarFoto(c.env, await c.req.arrayBuffer(), nome, c.get('u').id);
  if (!r.ok) return c.json(falha('FOTO_INVALIDA', r.mensagem), r.status);
  await registrar(c, 'foto_enviada', r.id, { tamanho: r.tamanho });
  return c.json({ ok: true, data: { url: r.url } }, 201);
});

// ---------------------------------------------------------------------------
// Reservas e pagamentos
// ---------------------------------------------------------------------------
admin.get('/viagens/:id/reservas', exigir('reservas.ver'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.status, r.tipo_pagamento, r.valor_centavos, r.criado_em, r.expira_em, r.confirmado_em,
            p.nome_completo, p.cpf_final, p.telefone,
            (SELECT status_interno FROM pagamentos g WHERE g.reserva_id = r.id ORDER BY g.criado_em DESC LIMIT 1) AS pagamento
       FROM reservas r JOIN passageiros p ON p.id = r.passageiro_id
      WHERE r.viagem_id = ? ORDER BY r.criado_em DESC`,
  ).bind(c.req.param('id')).all<any>();
  return c.json({
    ok: true,
    data: results.map(({ cpf_final, ...r }) => ({ ...r, codigo: codigoReserva(r.id), cpf: mascararCpf(cpf_final) })),
  });
});

admin.post('/reservas/:id/cancelar', exigir('reservas.cancelar'), async (c) => {
  const id = c.req.param('id');
  const agora = agoraISO();
  const r = await c.env.DB.prepare(`UPDATE reservas SET status = 'CANCELADO' WHERE id = ? AND status IN ('PENDENTE', 'CONFIRMADO')
                                     RETURNING pix_txid, (SELECT status_interno FROM pagamentos WHERE reserva_id = reservas.id
                                       ORDER BY criado_em DESC LIMIT 1) AS pagamento`)
    .bind(id).first<{ pix_txid: string | null; pagamento: string | null }>();
  if (!r) return c.json(falha('NAO_CANCELAVEL', 'Reserva não encontrada ou já encerrada'), 409);
  if (r.pagamento === 'APROVADO') {
    await c.env.DB.prepare(`UPDATE pagamentos SET status_interno = 'ESTORNAR', observacao = 'Cancelada pelo admin', atualizado_em = ?
                             WHERE reserva_id = ? AND status_interno = 'APROVADO'`).bind(agora, id).run();
  } else if (r.pix_txid) {
    try { await criarProvider(c.env).cancelar(r.pix_txid); } catch { /* best-effort */ }
    await c.env.DB.prepare(`UPDATE pagamentos SET status_interno = 'CANCELADO', atualizado_em = ? WHERE reserva_id = ? AND status_interno = 'AGUARDANDO'`)
      .bind(agora, id).run();
  }
  await registrar(c, 'reserva_cancelada', id, { codigo: codigoReserva(id), estornar: r.pagamento === 'APROVADO' });
  return c.json({ ok: true, data: { estornar: r.pagamento === 'APROVADO' } });
});

admin.get('/pendencias', exigir('financeiro.ver'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT g.id, g.gateway, g.gateway_payment_id, g.status_interno, g.valor_centavos, g.observacao, g.atualizado_em,
            r.id AS reserva_id, r.status AS status_reserva, v.titulo, p.nome_completo, p.telefone
       FROM pagamentos g JOIN reservas r ON r.id = g.reserva_id
       JOIN viagens v ON v.id = r.viagem_id JOIN passageiros p ON p.id = r.passageiro_id
      WHERE g.status_interno IN ('ESTORNAR', 'DIVERGENTE') ORDER BY g.atualizado_em DESC`,
  ).all<any>();
  return c.json({ ok: true, data: results.map((x) => ({ ...x, codigo: codigoReserva(x.reserva_id) })) });
});

admin.post('/pagamentos/:id/estornado', exigir('financeiro.estornar'), async (c) => {
  const res = await c.env.DB.prepare(`UPDATE pagamentos SET status_interno = 'ESTORNADO', observacao = COALESCE(observacao, '') || ' | Estorno registrado pelo admin', atualizado_em = ?
                                       WHERE id = ? AND status_interno IN ('ESTORNAR', 'DIVERGENTE')`)
    .bind(agoraISO(), c.req.param('id')).run();
  if (!res.meta.changes) return c.json(falha('NAO_ENCONTRADO', 'Pendência não encontrada'), 404);
  await registrar(c, 'estorno_registrado', c.req.param('id'));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Manifesto de passageiros (ANTT / DER) — dados decifrados, acesso registrado em log
// ---------------------------------------------------------------------------
admin.get('/passageiros/:viagem_id', exigir('manifesto.exportar'), async (c) => {
  const viagemId = c.req.param('viagem_id');
  const status = (c.req.query('status') ?? 'CONFIRMADO').toUpperCase();
  const formato = (c.req.query('formato') ?? 'json').toLowerCase();
  const statusValidos = ['CONFIRMADO', 'PENDENTE', 'EXPIRADO', 'CANCELADO', 'TODOS'];
  if (!statusValidos.includes(status)) return c.json(falha('FILTRO_INVALIDO', `status deve ser um de ${statusValidos.join(', ')}`), 400);

  const viagem = await c.env.DB.prepare(`SELECT id, titulo, destino, data_partida, data_retorno, local_embarque, total_vagas FROM viagens WHERE id = ?`)
    .bind(viagemId).first<any>();
  if (!viagem) return c.json(falha('NAO_ENCONTRADA', 'Viagem não encontrada'), 404);

  const { results } = await c.env.DB.prepare(
    `SELECT p.nome_completo, p.cpf_cifrado, p.rg_cifrado, p.orgao_emissor, p.telefone, r.status, r.tipo_pagamento, r.id AS reserva_id
       FROM reservas r JOIN passageiros p ON p.id = r.passageiro_id
      WHERE r.viagem_id = ?1 AND (?2 = 'TODOS' OR r.status = ?2)
      ORDER BY p.nome_completo COLLATE NOCASE`,
  ).bind(viagemId, status).all<any>();

  const passageiros = await Promise.all(results.map(async (p, i) => ({
    ordem: i + 1,
    nome: p.nome_completo,
    cpf: formatarCpf(await decifrar(p.cpf_cifrado, c.env.DATA_ENC_KEY)),
    rg: await decifrar(p.rg_cifrado, c.env.DATA_ENC_KEY),
    orgao_emissor: p.orgao_emissor,
    telefone: p.telefone,
    status: p.status,
    tipo_pagamento: p.tipo_pagamento,
    codigo: codigoReserva(p.reserva_id),
  })));

  await registrar(c, 'manifesto_exportado', viagemId, { status, formato, quantidade: passageiros.length });

  if (formato === 'csv') {
    const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const linhas = [
      ['Nº', 'Nome completo', 'CPF', 'RG', 'Órgão emissor', 'Telefone', 'Status'].map(esc).join(';'),
      ...passageiros.map((p) => [p.ordem, p.nome, p.cpf, p.rg, p.orgao_emissor, p.telefone, p.status].map(esc).join(';')),
    ];
    return new Response('﻿' + linhas.join('\r\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="manifesto-${viagemId}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true, data: { viagem, passageiros } });
});

export default admin;
