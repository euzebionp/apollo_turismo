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
  type Layout, type PontoEmbarque, jsonOu, lerInclusos, lerLayout, lerPontos, poltronasVendaveis, SQL_PAGO, sqlSeguraLugar,
  validarInclusos, validarLayout, validarPontos,
} from './viagem';
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
  SUM(CASE WHEN r.status = 'CONFIRMADO' AND r.desistencia_em IS NOT NULL THEN 1 ELSE 0 END) AS desistencias,
  COALESCE(SUM(CASE WHEN r.status = 'CONFIRMADO' THEN MAX(0, COALESCE(r.valor_total_centavos, r.valor_centavos) - ${SQL_PAGO}) ELSE 0 END), 0) AS a_receber_centavos`;

// ---------------------------------------------------------------------------
// Viagens
// ---------------------------------------------------------------------------
admin.get('/viagens', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.titulo, v.destino, v.data_partida, v.data_retorno, v.total_vagas, v.situacao,
            v.preco_integral_centavos, v.preco_sinal_centavos, v.ativa, ${SQL_OCUPACAO},
            (SELECT COALESCE(SUM(g.valor_centavos), 0) FROM pagamentos g JOIN reservas rr ON rr.id = g.reserva_id
              WHERE rr.viagem_id = v.id AND g.status_interno = 'APROVADO') AS arrecadado_centavos,
            (SELECT COALESCE(SUM(d.valor_centavos), 0) FROM despesas d WHERE d.viagem_id = v.id) AS despesas_centavos
       FROM viagens v LEFT JOIN reservas r ON r.viagem_id = v.id
      GROUP BY v.id ORDER BY v.data_partida DESC`,
  ).bind(agoraISO()).all<any>();
  const verValores = pode(c, 'financeiro.ver');
  return c.json({
    ok: true,
    data: verValores ? results : results.map((v) => ({ ...v, arrecadado_centavos: null, a_receber_centavos: null, despesas_centavos: null })),
  });
});

admin.get('/viagens/:id', async (c) => {
  const v = await c.env.DB.prepare(`SELECT * FROM viagens WHERE id = ?`).bind(c.req.param('id')).first<any>();
  if (!v) return c.json(falha('NAO_ENCONTRADA', 'Viagem não encontrada'), 404);
  const { programacao_json, fotos_json, layout_json, pontos_embarque_json, inclusos_json, ...resto } = v;
  return c.json({
    ok: true,
    data: {
      ...resto, programacao: JSON.parse(programacao_json), fotos: JSON.parse(fotos_json),
      layout: lerLayout(layout_json), pontos_embarque: lerPontos(pontos_embarque_json), inclusos: lerInclusos(inclusos_json),
    },
  });
});

interface ViagemInput {
  id: string; titulo: string; destino: string; descricao: string | null;
  data_partida: string; data_retorno: string | null; local_embarque: string | null;
  total_vagas: number; preco_integral_centavos: number; preco_sinal_centavos: number;
  programacao: unknown[]; fotos: Record<string, unknown[]>; ativa: number;
  situacao: 'RASCUNHO' | 'PUBLICADA'; layout: Layout | null; pontos: PontoEmbarque[]; inclusos: string[];
  politica_cancelamento: string | null; grupo_whatsapp: string | null; motorista_nome: string | null;
  motorista_whatsapp: string | null; veiculo_descricao: string | null;
}

const texto = (x: unknown, max: number) => String(x ?? '').trim().slice(0, max) || null;

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
  const lay = validarLayout(b?.layout);
  if (!lay.ok) campos.layout = lay.erro;
  const layout = lay.ok ? lay.layout : null;
  // Com mapa de poltronas, o total de vagas é o número de poltronas vendáveis.
  const vagas = layout ? poltronasVendaveis(layout).length : Number(b?.total_vagas);
  if (!Number.isInteger(vagas) || vagas < 1 || vagas > 200) campos.total_vagas = 'Entre 1 e 200';
  const pts = validarPontos(b?.pontos_embarque);
  if (!pts.ok) campos.pontos_embarque = pts.erro;
  const inclusos = validarInclusos(b?.inclusos);
  if (!inclusos) campos.inclusos = 'Lista inválida';
  const grupo = texto(b?.grupo_whatsapp, 200);
  if (grupo && !/^https:\/\/(chat\.whatsapp\.com|wa\.me)\/\S+$/.test(grupo)) campos.grupo_whatsapp = 'Cole o link de convite do grupo (https://chat.whatsapp.com/...)';
  const motoristaZap = String(b?.motorista_whatsapp ?? '').replace(/\D/g, '').slice(0, 13) || null;
  const situacao = b?.situacao === 'RASCUNHO' ? 'RASCUNHO' : 'PUBLICADA';
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
      situacao, layout, pontos: pts.ok ? pts.pontos : [], inclusos: inclusos ?? [],
      politica_cancelamento: texto(b?.politica_cancelamento, 3000), grupo_whatsapp: grupo,
      motorista_nome: texto(b?.motorista_nome, 120), motorista_whatsapp: motoristaZap,
      veiculo_descricao: texto(b?.veiculo_descricao, 160),
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
                            preco_integral_centavos, preco_sinal_centavos, programacao_json, fotos_json, ativa, criado_em,
                            situacao, layout_json, pontos_embarque_json, inclusos_json, politica_cancelamento, grupo_whatsapp,
                            motorista_nome, motorista_whatsapp, veiculo_descricao)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(v.id, v.titulo, v.destino, v.descricao, v.data_partida, v.data_retorno, v.local_embarque, v.total_vagas,
      v.preco_integral_centavos, v.preco_sinal_centavos, JSON.stringify(v.programacao), JSON.stringify(v.fotos), v.ativa, agoraISO(),
      ...colunasExtras(v)).run();
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) return c.json(falha('ID_EM_USO', 'Já existe uma viagem com este identificador', { id: 'Em uso' }), 409);
    throw e;
  }
  await registrar(c, 'viagem_criada', v.id, { titulo: v.titulo, vagas: v.total_vagas, sinal: v.preco_sinal_centavos, integral: v.preco_integral_centavos, situacao: v.situacao });
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
  if (antes.situacao === 'CANCELADA' || antes.situacao === 'CONCLUIDA') v.situacao = antes.situacao; // só muda pelos botões próprios
  const extrasAntes = [antes.situacao, antes.layout_json, antes.pontos_embarque_json, antes.inclusos_json, antes.politica_cancelamento,
    antes.grupo_whatsapp, antes.motorista_nome, antes.motorista_whatsapp, antes.veiculo_descricao];
  const mudouOutros = ['titulo', 'destino', 'descricao', 'data_partida', 'data_retorno', 'local_embarque', 'total_vagas', 'ativa'].some((k) => antes[k] !== (v as any)[k])
    || antes.programacao_json !== JSON.stringify(v.programacao) || antes.fotos_json !== JSON.stringify(v.fotos)
    || colunasExtras(v).some((x, i) => x !== extrasAntes[i]);
  if (mudouPreco && !pode(c, 'precos.alterar')) return c.json(falha('SEM_PERMISSAO', 'Seu usuário não pode alterar preços'), 403);
  if (mudouOutros && !pode(c, 'viagens.editar')) return c.json(falha('SEM_PERMISSAO', 'Seu usuário não pode editar dados da viagem'), 403);
  if (!mudouPreco && !mudouOutros) return c.json({ ok: true, data: { id } });
  // Reservas ativas precisam continuar com uma poltrona que exista no layout novo.
  const agora = agoraISO();
  const { results: ativas } = await c.env.DB.prepare(
    `SELECT r.poltrona FROM reservas r WHERE r.viagem_id = ?1 AND ${sqlSeguraLugar('?2')}`,
  ).bind(id, agora).all<{ poltrona: number | null }>();
  if (v.layout && ativas.length) {
    const ok = new Set(poltronasVendaveis(v.layout));
    const fora = ativas.filter((r) => r.poltrona !== null && !ok.has(r.poltrona)).map((r) => r.poltrona);
    if (fora.length) return c.json(falha('POLTRONA_EM_USO', `As poltronas ${fora.join(', ')} têm reserva e não podem sair do mapa nem ser bloqueadas`, { layout: 'Poltrona com reserva' }), 409);
  }
  if (v.situacao === 'RASCUNHO' && antes.situacao !== 'RASCUNHO' && ativas.length) {
    return c.json(falha('TEM_RESERVAS', 'Uma viagem com reservas não pode voltar a rascunho. Pause as vendas ou cancele a viagem.'), 409);
  }
  // Não deixa reduzir as vagas abaixo do que já está ocupado. Preços novos valem só para reservas novas.
  const res = await c.env.DB.prepare(
    `UPDATE viagens SET titulo = ?2, destino = ?3, descricao = ?4, data_partida = ?5, data_retorno = ?6, local_embarque = ?7,
            total_vagas = ?8, preco_integral_centavos = ?9, preco_sinal_centavos = ?10,
            programacao_json = ?11, fotos_json = ?12, ativa = ?13,
            situacao = ?15, layout_json = ?16, pontos_embarque_json = ?17, inclusos_json = ?18, politica_cancelamento = ?19,
            grupo_whatsapp = ?20, motorista_nome = ?21, motorista_whatsapp = ?22, veiculo_descricao = ?23
      WHERE id = ?1
        AND ?8 >= (SELECT COUNT(*) FROM reservas r WHERE r.viagem_id = ?1
                     AND (r.status = 'CONFIRMADO' OR (r.status = 'PENDENTE' AND r.expira_em > ?14)))`,
  ).bind(id, v.titulo, v.destino, v.descricao, v.data_partida, v.data_retorno, v.local_embarque, v.total_vagas,
    v.preco_integral_centavos, v.preco_sinal_centavos, JSON.stringify(v.programacao), JSON.stringify(v.fotos), v.ativa, agora,
    ...colunasExtras(v)).run();
  if (!res.meta.changes) {
    const existe = await c.env.DB.prepare(`SELECT 1 FROM viagens WHERE id = ?`).bind(id).first();
    if (!existe) return c.json(falha('NAO_ENCONTRADA', 'Viagem não encontrada'), 404);
    return c.json(falha('VAGAS_INSUFICIENTES', 'O total de vagas não pode ser menor que as vagas já ocupadas', { total_vagas: 'Abaixo da ocupação atual' }), 409);
  }
  await registrar(c, mudouPreco ? 'preco_alterado' : 'viagem_alterada', id, {
    ...(mudouPreco ? { sinal: [antes.preco_sinal_centavos, v.preco_sinal_centavos], integral: [antes.preco_integral_centavos, v.preco_integral_centavos] } : {}),
    ...(antes.total_vagas !== v.total_vagas ? { vagas: [antes.total_vagas, v.total_vagas] } : {}),
    ...(antes.ativa !== v.ativa ? { a_venda: !!v.ativa } : {}),
    ...(antes.situacao !== v.situacao ? { situacao: v.situacao } : {}),
    ...(antes.pontos_embarque_json !== JSON.stringify(v.pontos) ? { embarque_alterado: true } : {}),
  });
  return c.json({ ok: true, data: { id } });
});

function colunasExtras(v: ViagemInput) {
  return [v.situacao, v.layout ? JSON.stringify(v.layout) : null, JSON.stringify(v.pontos), JSON.stringify(v.inclusos),
    v.politica_cancelamento, v.grupo_whatsapp, v.motorista_nome, v.motorista_whatsapp, v.veiculo_descricao] as const;
}

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
            r.poltrona, r.ponto_embarque_id, r.ponto_embarque_nome, r.desistencia_em, r.desistencia_motivo,
            COALESCE(r.valor_total_centavos, r.valor_centavos) AS valor_total_centavos, ${SQL_PAGO} AS pago_centavos,
            p.nome_completo, p.cpf_final, p.telefone,
            (SELECT status_interno FROM pagamentos g WHERE g.reserva_id = r.id ORDER BY g.criado_em DESC LIMIT 1) AS pagamento,
            (SELECT COUNT(*) FROM pagamentos g WHERE g.reserva_id = r.id AND g.tipo = 'SALDO' AND g.status_interno = 'AGUARDANDO') AS pix_saldo_aguardando,
            (SELECT GROUP_CONCAT(m.tipo) FROM mensagens_abertas m WHERE m.reserva_id = r.id) AS mensagens
       FROM reservas r JOIN passageiros p ON p.id = r.passageiro_id
      WHERE r.viagem_id = ? ORDER BY r.criado_em DESC`,
  ).bind(c.req.param('id')).all<any>();
  const verValores = pode(c, 'financeiro.ver') || pode(c, 'pagamentos.registrar');
  return c.json({
    ok: true,
    data: results.map(({ cpf_final, mensagens, ...r }) => ({
      ...r, codigo: codigoReserva(r.id), cpf: mascararCpf(cpf_final), mensagens: mensagens ? String(mensagens).split(',') : [],
      saldo_centavos: Math.max(0, r.valor_total_centavos - r.pago_centavos),
      ...(verValores ? {} : { pago_centavos: null }),
    })),
  });
});

admin.post('/reservas/:id/cancelar', exigir('reservas.cancelar'), async (c) => {
  const id = c.req.param('id');
  const agora = agoraISO();
  const r = await c.env.DB.prepare(`UPDATE reservas SET status = 'CANCELADO' WHERE id = ? AND status IN ('PENDENTE', 'CONFIRMADO') RETURNING desistencia_em`)
    .bind(id).first<{ desistencia_em: string | null }>();
  if (!r) return c.json(falha('NAO_CANCELAVEL', 'Reserva não encontrada ou já encerrada'), 409);
  // Tudo o que já foi pago (sinal, saldo, pagamentos à mão) vai para Pendências como estorno a fazer.
  const est = await c.env.DB.prepare(`UPDATE pagamentos SET status_interno = 'ESTORNAR', observacao = ?, atualizado_em = ?
                                       WHERE reserva_id = ? AND status_interno = 'APROVADO'`)
    .bind(r.desistencia_em ? 'Desistência aprovada' : 'Cancelada pelo admin', agora, id).run();
  const estornar = (est.meta.changes ?? 0) > 0;
  await cancelarPixAguardando(c.env, id, agora);
  await registrar(c, r.desistencia_em ? 'desistencia_aprovada' : 'reserva_cancelada', id, { codigo: codigoReserva(id), estornar });
  return c.json({ ok: true, data: { estornar } });
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

  const viagem = await c.env.DB.prepare(`SELECT id, titulo, destino, data_partida, data_retorno, local_embarque, total_vagas, veiculo_descricao, motorista_nome FROM viagens WHERE id = ?`)
    .bind(viagemId).first<any>();
  if (!viagem) return c.json(falha('NAO_ENCONTRADA', 'Viagem não encontrada'), 404);

  const { results } = await c.env.DB.prepare(
    `SELECT p.nome_completo, p.cpf_cifrado, p.rg_cifrado, p.orgao_emissor, p.telefone, r.status, r.tipo_pagamento, r.id AS reserva_id,
            r.poltrona, r.ponto_embarque_nome
       FROM reservas r JOIN passageiros p ON p.id = r.passageiro_id
      WHERE r.viagem_id = ?1 AND (?2 = 'TODOS' OR r.status = ?2)
      ORDER BY r.poltrona IS NULL, r.poltrona, p.nome_completo COLLATE NOCASE`,
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
    poltrona: p.poltrona,
    embarque: p.ponto_embarque_nome,
  })));

  await registrar(c, 'manifesto_exportado', viagemId, { status, formato, quantidade: passageiros.length });

  if (formato === 'csv') {
    const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const linhas = [
      ['Nº', 'Poltrona', 'Nome completo', 'CPF', 'RG', 'Órgão emissor', 'Telefone', 'Embarque', 'Status'].map(esc).join(';'),
      ...passageiros.map((p) => [p.ordem, p.poltrona, p.nome, p.cpf, p.rg, p.orgao_emissor, p.telefone, p.embarque, p.status].map(esc).join(';')),
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

// ---------------------------------------------------------------------------
// Ciclo de vida da viagem: duplicar, cancelar e concluir
// ---------------------------------------------------------------------------
/** Cancela no gateway os Pix ainda aguardando pagamento desta reserva. */
async function cancelarPixAguardando(env: Env, reservaId: string, agora: string) {
  const { results } = await env.DB.prepare(
    `UPDATE pagamentos SET status_interno = 'CANCELADO', atualizado_em = ? WHERE reserva_id = ? AND status_interno = 'AGUARDANDO'
     RETURNING gateway_payment_id, gateway`,
  ).bind(agora, reservaId).all<{ gateway_payment_id: string; gateway: string }>();
  const provider = results.length ? criarProvider(env) : null;
  await Promise.allSettled(results.filter((p) => p.gateway !== 'manual').map((p) => provider!.cancelar(p.gateway_payment_id)));
}

admin.post('/viagens/:id/duplicar', exigir('viagens.editar'), async (c) => {
  const origem = await c.env.DB.prepare(`SELECT * FROM viagens WHERE id = ?`).bind(c.req.param('id')).first<any>();
  if (!origem) return c.json(falha('NAO_ENCONTRADA', 'Viagem não encontrada'), 404);
  const b = await c.req.json().catch(() => ({}));
  const id = String(b?.id ?? '').trim().toLowerCase();
  const partida = new Date(String(b?.data_partida ?? ''));
  const campos: Record<string, string> = {};
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) campos.id = 'Use letras minúsculas, números e hífen (3 a 64)';
  if (isNaN(partida.getTime())) campos.data_partida = 'Data/hora inválida';
  else if (partida.getTime() <= Date.now()) campos.data_partida = 'A nova saída precisa ser no futuro';
  if (Object.keys(campos).length) return c.json(falha('DADOS_INVALIDOS', 'Verifique os campos', campos), 400);

  // Tudo anda junto com a nova saída: retorno e horários dos pontos de embarque.
  const delta = partida.getTime() - new Date(origem.data_partida).getTime();
  const mover = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + delta).toISOString() : null);
  const pontos = lerPontos(origem.pontos_embarque_json).map((p) => ({ ...p, horario: mover(p.horario) }));
  try {
    await c.env.DB.prepare(
      `INSERT INTO viagens (id, titulo, destino, descricao, data_partida, data_retorno, local_embarque, total_vagas,
                            preco_integral_centavos, preco_sinal_centavos, programacao_json, fotos_json, ativa, criado_em,
                            situacao, layout_json, pontos_embarque_json, inclusos_json, politica_cancelamento, veiculo_descricao)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'RASCUNHO', ?, ?, ?, ?, ?)`,
    ).bind(id, origem.titulo, origem.destino, origem.descricao, partida.toISOString(), mover(origem.data_retorno), origem.local_embarque,
      origem.total_vagas, origem.preco_integral_centavos, origem.preco_sinal_centavos, origem.programacao_json, origem.fotos_json,
      agoraISO(), origem.layout_json, JSON.stringify(pontos), origem.inclusos_json, origem.politica_cancelamento, origem.veiculo_descricao).run();
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) return c.json(falha('ID_EM_USO', 'Já existe uma viagem com este endereço', { id: 'Em uso' }), 409);
    throw e;
  }
  await registrar(c, 'viagem_duplicada', id, { origem: origem.id });
  return c.json({ ok: true, data: { id } }, 201);
});

admin.post('/viagens/:id/cancelar', exigir('viagens.editar'), exigir('reservas.cancelar'), async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const motivo = String(b?.motivo ?? '').trim().slice(0, 500);
  if (motivo.length < 3) return c.json(falha('DADOS_INVALIDOS', 'Informe o motivo do cancelamento', { motivo: 'Obrigatório' }), 400);
  const agora = agoraISO();
  const v = await c.env.DB.prepare(`UPDATE viagens SET situacao = 'CANCELADA', ativa = 0, motivo_cancelamento = ? WHERE id = ? AND situacao <> 'CANCELADA' RETURNING id`)
    .bind(motivo, id).first();
  if (!v) return c.json(falha('NAO_CANCELAVEL', 'Viagem não encontrada ou já cancelada'), 409);
  const { results: canceladas } = await c.env.DB.prepare(
    `UPDATE reservas SET status = 'CANCELADO' WHERE viagem_id = ? AND status IN ('PENDENTE', 'CONFIRMADO') RETURNING id`,
  ).bind(id).all<{ id: string }>();
  const est = await c.env.DB.prepare(
    `UPDATE pagamentos SET status_interno = 'ESTORNAR', observacao = 'Viagem cancelada: ' || ?, atualizado_em = ?
      WHERE status_interno = 'APROVADO' AND reserva_id IN (SELECT id FROM reservas WHERE viagem_id = ?)`,
  ).bind(motivo, agora, id).run();
  for (const r of canceladas) await cancelarPixAguardando(c.env, r.id, agora);
  await registrar(c, 'viagem_cancelada', id, { reservas: canceladas.length, estornos: est.meta.changes ?? 0 });
  return c.json({ ok: true, data: { reservas: canceladas.length, estornos: est.meta.changes ?? 0 } });
});

admin.post('/viagens/:id/concluir', exigir('viagens.editar'), async (c) => {
  const id = c.req.param('id');
  const res = await c.env.DB.prepare(`UPDATE viagens SET situacao = 'CONCLUIDA', ativa = 0 WHERE id = ? AND situacao = 'PUBLICADA' AND data_partida <= ?`)
    .bind(id, agoraISO()).run();
  if (!res.meta.changes) return c.json(falha('NAO_PERMITIDO', 'Só dá para concluir uma viagem publicada que já saiu'), 409);
  await registrar(c, 'viagem_concluida', id);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Pagamentos à mão e desistências
// ---------------------------------------------------------------------------
admin.post('/reservas/:id/pagamento-manual', exigir('pagamentos.registrar'), async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const valor = Number(b?.valor_centavos);
  const recebido = new Date(String(b?.recebido_em ?? ''));
  const obs = String(b?.observacao ?? '').trim().slice(0, 200) || null;
  const r = await c.env.DB.prepare(
    `SELECT r.status, COALESCE(r.valor_total_centavos, r.valor_centavos) AS total, ${SQL_PAGO} AS pago,
            (SELECT COUNT(*) FROM pagamentos g WHERE g.reserva_id = r.id AND g.status_interno = 'AGUARDANDO') AS aguardando
       FROM reservas r WHERE r.id = ?`,
  ).bind(id).first<{ status: string; total: number; pago: number; aguardando: number }>();
  if (!r) return c.json(falha('NAO_ENCONTRADA', 'Reserva não encontrada'), 404);
  if (r.status !== 'CONFIRMADO') return c.json(falha('NAO_PERMITIDO', 'Só dá para registrar pagamento em reserva confirmada'), 409);
  if (r.aguardando) return c.json(falha('PIX_AGUARDANDO', 'Esta reserva tem um Pix aguardando pagamento. Espere ele vencer (até 1 hora) antes de marcar o pagamento à mão.'), 409);
  const saldo = r.total - r.pago;
  const campos: Record<string, string> = {};
  if (!Number.isInteger(valor) || valor < 1) campos.valor_centavos = 'Valor inválido';
  else if (valor > saldo) campos.valor_centavos = `O saldo desta reserva é ${(saldo / 100).toFixed(2).replace('.', ',')}`;
  if (isNaN(recebido.getTime()) || recebido.getTime() > Date.now() + 86_400_000) campos.recebido_em = 'Data inválida';
  if (Object.keys(campos).length) return c.json(falha('DADOS_INVALIDOS', 'Verifique os campos', campos), 400);
  const agora = agoraISO();
  const u = c.get('u');
  await c.env.DB.prepare(
    `INSERT INTO pagamentos (id, reserva_id, gateway, gateway_payment_id, status_gateway, status_interno, valor_centavos, tipo,
                             observacao, recebido_em, registrado_por, criado_em, atualizado_em)
     VALUES (?1, ?2, 'manual', ?3, 'manual', 'APROVADO', ?4, 'MANUAL', ?5, ?6, ?7, ?8, ?8)`,
  ).bind(crypto.randomUUID(), id, `manual:${crypto.randomUUID()}`, valor, obs, recebido.toISOString(), u.usuario, agora).run();
  await registrar(c, 'pagamento_manual', id, { codigo: codigoReserva(id), valor });
  return c.json({ ok: true, data: { saldo_centavos: saldo - valor } }, 201);
});

admin.post('/reservas/:id/desistencia/recusar', exigir('reservas.cancelar'), async (c) => {
  const id = c.req.param('id');
  const res = await c.env.DB.prepare(`UPDATE reservas SET desistencia_em = NULL, desistencia_motivo = NULL WHERE id = ? AND desistencia_em IS NOT NULL`).bind(id).run();
  if (!res.meta.changes) return c.json(falha('NAO_ENCONTRADA', 'Pedido de desistência não encontrado'), 404);
  await registrar(c, 'desistencia_recusada', id, { codigo: codigoReserva(id) });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Fila de mensagens do WhatsApp: o painel abre a conversa pronta e marca como aberta.
// ---------------------------------------------------------------------------
const TIPOS_MSG = ['LINK', 'LEMBRETE', 'MUDANCA', 'COBRANCA'];

admin.post('/mensagens', exigir('reservas.ver'), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const tipo = String(b?.tipo ?? '');
  if (!TIPOS_MSG.includes(tipo)) return c.json(falha('DADOS_INVALIDOS', 'Tipo de mensagem inválido'), 400);
  const res = await c.env.DB.prepare(
    `INSERT INTO mensagens_abertas (reserva_id, tipo, aberta_em, usuario_id) SELECT id, ?2, ?3, ?4 FROM reservas WHERE id = ?1
     ON CONFLICT (reserva_id, tipo) DO UPDATE SET aberta_em = excluded.aberta_em, usuario_id = excluded.usuario_id`,
  ).bind(String(b?.reserva_id ?? ''), tipo, agoraISO(), c.get('u').id).run();
  if (!res.meta.changes) return c.json(falha('NAO_ENCONTRADA', 'Reserva não encontrada'), 404);
  return c.json({ ok: true });
});

admin.delete('/viagens/:id/mensagens/:tipo', exigir('reservas.ver'), async (c) => {
  const tipo = c.req.param('tipo');
  if (!TIPOS_MSG.includes(tipo)) return c.json(falha('DADOS_INVALIDOS', 'Tipo de mensagem inválido'), 400);
  await c.env.DB.prepare(`DELETE FROM mensagens_abertas WHERE tipo = ? AND reserva_id IN (SELECT id FROM reservas WHERE viagem_id = ?)`)
    .bind(tipo, c.req.param('id')).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Cobranças: quem ainda deve, em todas as viagens que não terminaram
// ---------------------------------------------------------------------------
admin.get('/cobrancas', exigir('financeiro.ver'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM (
       SELECT r.id, r.poltrona, r.desistencia_em, COALESCE(r.valor_total_centavos, r.valor_centavos) AS total, ${SQL_PAGO} AS pago,
              (SELECT MAX(m.aberta_em) FROM mensagens_abertas m WHERE m.reserva_id = r.id AND m.tipo = 'COBRANCA') AS cobrado_em,
              (SELECT COUNT(*) FROM pagamentos g WHERE g.reserva_id = r.id AND g.tipo = 'SALDO' AND g.status_interno = 'AGUARDANDO') AS pix_aguardando,
              p.nome_completo, p.telefone, v.id AS viagem_id, v.titulo, v.data_partida
         FROM reservas r JOIN passageiros p ON p.id = r.passageiro_id JOIN viagens v ON v.id = r.viagem_id
        WHERE r.status = 'CONFIRMADO' AND v.situacao = 'PUBLICADA'
     ) WHERE total > pago ORDER BY data_partida, nome_completo COLLATE NOCASE`,
  ).all<any>();
  return c.json({ ok: true, data: results.map((x) => ({ ...x, saldo_centavos: x.total - x.pago, codigo: codigoReserva(x.id) })) });
});

// ---------------------------------------------------------------------------
// Financeiro da viagem: recebido, a receber, despesas e resultado
// ---------------------------------------------------------------------------
const CATEGORIAS = ['FRETAMENTO', 'HOSPEDAGEM', 'ALIMENTACAO', 'PASSEIOS', 'GUIA', 'SEGURO', 'TAXAS', 'OUTROS'];

admin.get('/viagens/:id/financeiro', exigir('financeiro.ver'), async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const [v, valores, despesas] = await Promise.all([
    db.prepare(`SELECT id, titulo, data_partida, situacao, total_vagas, preco_integral_centavos FROM viagens WHERE id = ?`).bind(id).first<any>(),
    db.prepare(
      `SELECT
         (SELECT COALESCE(SUM(g.valor_centavos), 0) FROM pagamentos g JOIN reservas r ON r.id = g.reserva_id WHERE r.viagem_id = ?1 AND g.status_interno = 'APROVADO') AS recebido,
         (SELECT COALESCE(SUM(g.valor_centavos), 0) FROM pagamentos g JOIN reservas r ON r.id = g.reserva_id WHERE r.viagem_id = ?1 AND g.status_interno IN ('ESTORNAR', 'DIVERGENTE')) AS a_estornar,
         (SELECT COALESCE(SUM(MAX(0, COALESCE(r.valor_total_centavos, r.valor_centavos) - ${SQL_PAGO})), 0) FROM reservas r WHERE r.viagem_id = ?1 AND r.status = 'CONFIRMADO') AS a_receber,
         (SELECT COUNT(*) FROM reservas r WHERE r.viagem_id = ?1 AND r.status = 'CONFIRMADO') AS confirmadas`,
    ).bind(id).first<any>(),
    db.prepare(`SELECT id, categoria, descricao, valor_centavos, data, criado_por, criado_em FROM despesas WHERE viagem_id = ? ORDER BY COALESCE(data, criado_em)`).bind(id).all<any>(),
  ]);
  if (!v) return c.json(falha('NAO_ENCONTRADA', 'Viagem não encontrada'), 404);
  const totalDespesas = despesas.results.reduce((s, d) => s + d.valor_centavos, 0);
  return c.json({
    ok: true,
    data: {
      viagem: v, ...valores, despesas: despesas.results, total_despesas: totalDespesas,
      resultado: valores.recebido - totalDespesas,
      resultado_previsto: valores.recebido + valores.a_receber - totalDespesas,
    },
  });
});

admin.post('/viagens/:id/despesas', exigir('despesas.editar'), async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const campos: Record<string, string> = {};
  const categoria = String(b?.categoria ?? '');
  const descricao = String(b?.descricao ?? '').trim().slice(0, 160);
  const valor = Number(b?.valor_centavos);
  const data = b?.data ? new Date(String(b.data)) : null;
  if (!CATEGORIAS.includes(categoria)) campos.categoria = 'Escolha a categoria';
  if (descricao.length < 2) campos.descricao = 'Descreva a despesa';
  if (!Number.isInteger(valor) || valor < 1 || valor > 100_000_000) campos.valor_centavos = 'Valor inválido';
  if (data && isNaN(data.getTime())) campos.data = 'Data inválida';
  if (Object.keys(campos).length) return c.json(falha('DADOS_INVALIDOS', 'Verifique os campos', campos), 400);
  const existe = await c.env.DB.prepare(`SELECT 1 FROM viagens WHERE id = ?`).bind(id).first();
  if (!existe) return c.json(falha('NAO_ENCONTRADA', 'Viagem não encontrada'), 404);
  const despesaId = crypto.randomUUID();
  await c.env.DB.prepare(`INSERT INTO despesas (id, viagem_id, categoria, descricao, valor_centavos, data, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(despesaId, id, categoria, descricao, valor, data ? data.toISOString() : null, c.get('u').usuario, agoraISO()).run();
  await registrar(c, 'despesa_lancada', id, { categoria, valor });
  return c.json({ ok: true, data: { id: despesaId } }, 201);
});

admin.delete('/despesas/:id', exigir('despesas.editar'), async (c) => {
  const d = await c.env.DB.prepare(`DELETE FROM despesas WHERE id = ? RETURNING viagem_id, categoria, valor_centavos`).bind(c.req.param('id')).first<any>();
  if (!d) return c.json(falha('NAO_ENCONTRADA', 'Despesa não encontrada'), 404);
  await registrar(c, 'despesa_apagada', d.viagem_id, { categoria: d.categoria, valor: d.valor_centavos });
  return c.json({ ok: true });
});

export default admin;

