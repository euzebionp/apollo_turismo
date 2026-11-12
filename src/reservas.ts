// Regras de negócio: criar reserva (trava de vaga), processar webhook, expirar pendentes.
import type { Env, ReservaRow, ViagemRow } from './types';
import type { DadosReserva } from './validacao';
import { cifrar, decifrar, hashCpf } from './crypto';
import { criarProvider, GatewayError } from './pix/provider';
import { codigoReserva, enviarConfirmacaoWhatsApp } from './whatsapp';
import { agoraISO, log } from './util';
import { lerLayout, lerPontos, poltronasVendaveis, SQL_PAGO } from './viagem';

export interface Resposta { status: number; body: Record<string, unknown> }

const erro = (status: number, codigo: string, mensagem: string, extra: Record<string, unknown> = {}): Resposta =>
  ({ status, body: { ok: false, erro: { codigo, mensagem, ...extra } } });

function payloadReserva(r: ReservaRow, retomada = false) {
  return {
    ok: true,
    data: {
      reserva_id: r.id,
      codigo: codigoReserva(r.id),
      status: r.status,
      tipo_pagamento: r.tipo_pagamento,
      valor_centavos: r.valor_centavos,
      expira_em: r.expira_em,
      retomada,
      pix: { copia_e_cola: r.pix_copia_cola, qr_base64: r.pix_qr_base64, qr_mime: r.pix_qr_mime },
    },
  };
}

// ---------------------------------------------------------------------------
// Turnstile
// ---------------------------------------------------------------------------
export async function verificarTurnstile(env: Env, token: string, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) {
    if (env.AMBIENTE === 'production') throw new Error('TURNSTILE_SECRET não configurado');
    return true; // desenvolvimento local sem Turnstile
  }
  if (!token) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const json = await res.json<{ success: boolean }>();
  return json.success === true;
}

// ---------------------------------------------------------------------------
// POST /api/reservar
// ---------------------------------------------------------------------------
export async function criarReserva(env: Env, d: DadosReserva): Promise<Resposta> {
  const agora = new Date();
  const agoraIso = agora.toISOString();
  const minutos = Number(env.RESERVA_MINUTOS || 15);
  const expiraEm = new Date(agora.getTime() + minutos * 60_000).toISOString();
  const reservaId = crypto.randomUUID();
  const db = env.DB;

  // Confere poltrona, ponto de embarque e política antes de travar a vaga.
  const viagem = await db.prepare(`SELECT layout_json, pontos_embarque_json, politica_cancelamento, situacao FROM viagens WHERE id = ?`)
    .bind(d.viagem_id).first<Pick<ViagemRow, 'layout_json' | 'pontos_embarque_json' | 'politica_cancelamento' | 'situacao'>>();
  if (!viagem || viagem.situacao !== 'PUBLICADA') return erro(404, 'VIAGEM_INDISPONIVEL', 'Viagem não encontrada ou fora de venda.');
  const layout = lerLayout(viagem.layout_json);
  if (layout) {
    if (d.poltrona === null) return erro(400, 'DADOS_INVALIDOS', 'Escolha a sua poltrona no mapa.', { campos: { poltrona: 'Escolha uma poltrona' } });
    if (!poltronasVendaveis(layout).includes(d.poltrona)) return erro(400, 'DADOS_INVALIDOS', 'Esta poltrona não está disponível.', { campos: { poltrona: 'Poltrona indisponível' } });
  }
  const poltrona = layout ? d.poltrona : null;
  const pontos = lerPontos(viagem.pontos_embarque_json);
  const ponto = pontos.find((p) => p.id === d.ponto_embarque_id) ?? null;
  if (pontos.length && !ponto) return erro(400, 'DADOS_INVALIDOS', 'Escolha onde você vai embarcar.', { campos: { ponto_embarque_id: 'Escolha o ponto de embarque' } });
  const politica = viagem.politica_cancelamento?.trim() || null;
  if (politica && !d.aceite_politica) return erro(400, 'DADOS_INVALIDOS', 'É preciso aceitar a política de cancelamento.', { campos: { aceite_politica: 'Necessário' } });

  const [cpfHash, cpfCifrado, rgCifrado] = await Promise.all([
    hashCpf(d.cpf, env.DATA_HMAC_KEY),
    cifrar(d.cpf, env.DATA_ENC_KEY),
    cifrar(d.rg, env.DATA_ENC_KEY),
  ]);

  const stmts = [
    // 1) Arrumação: pendentes vencidas desta viagem deixam de travar o índice único do passageiro.
    db.prepare(`UPDATE reservas SET status = 'EXPIRADO'
                 WHERE viagem_id = ?1 AND status = 'PENDENTE' AND expira_em <= ?2`).bind(d.viagem_id, agoraIso),
    // 2) Upsert do passageiro (dados do manifesto ANTT/DER).
    db.prepare(`INSERT INTO passageiros (id, nome_completo, cpf_hash, cpf_cifrado, cpf_final, rg_cifrado,
                                         orgao_emissor, telefone, email, consentimento_em, criado_em, atualizado_em)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10)
                ON CONFLICT (cpf_hash) DO UPDATE SET
                  nome_completo = excluded.nome_completo, cpf_cifrado = excluded.cpf_cifrado,
                  rg_cifrado = excluded.rg_cifrado, orgao_emissor = excluded.orgao_emissor,
                  telefone = excluded.telefone, email = excluded.email,
                  consentimento_em = excluded.consentimento_em, atualizado_em = excluded.atualizado_em`)
      .bind(crypto.randomUUID(), d.nome, cpfHash, cpfCifrado, d.cpf.slice(-2), rgCifrado,
            d.orgao_emissor, d.telefone, d.email, agoraIso),
    // 3) Trava da vaga: contagem e inserção no MESMO comando (sem janela de corrida).
    // A poltrona única é garantida pelo índice idx_poltrona_ativa.
    db.prepare(`INSERT INTO reservas (id, viagem_id, passageiro_id, tipo_pagamento, valor_centavos, status, expira_em, criado_em,
                                      poltrona, ponto_embarque_id, ponto_embarque_nome, valor_total_centavos, politica_aceita)
                SELECT ?1, v.id, (SELECT id FROM passageiros WHERE cpf_hash = ?2), ?3,
                       CASE ?3 WHEN 'SINAL' THEN v.preco_sinal_centavos ELSE v.preco_integral_centavos END,
                       'PENDENTE', ?4, ?5, ?7, ?8, ?9, v.preco_integral_centavos, ?10
                  FROM viagens v
                 WHERE v.id = ?6 AND v.ativa = 1 AND v.situacao = 'PUBLICADA' AND v.data_partida > ?5
                   AND (SELECT COUNT(*) FROM reservas r
                         WHERE r.viagem_id = v.id
                           AND (r.status = 'CONFIRMADO' OR (r.status = 'PENDENTE' AND r.expira_em > ?5)))
                       < v.total_vagas`)
      .bind(reservaId, cpfHash, d.tipo_pagamento, expiraEm, agoraIso, d.viagem_id, poltrona, ponto?.id ?? null, ponto?.nome ?? null, politica),
  ];

  let inseriu = false;
  try {
    const res = await db.batch(stmts); // atômico
    inseriu = (res[2].meta.changes ?? 0) === 1;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes('UNIQUE') && msg.includes('poltrona')) {
      return erro(409, 'POLTRONA_OCUPADA', `A poltrona ${poltrona} acabou de ser reservada por outra pessoa. Escolha outra.`, { campos: { poltrona: 'Ocupada' } });
    }
    if (msg.includes('UNIQUE')) return retomarReservaExistente(env, cpfHash, d.viagem_id, agoraIso);
    throw e;
  }

  if (!inseriu) {
    const v = await db.prepare(`SELECT ativa, data_partida, situacao FROM viagens WHERE id = ?`).bind(d.viagem_id)
      .first<{ ativa: number; data_partida: string; situacao: string }>();
    if (!v || !v.ativa || v.situacao !== 'PUBLICADA') return erro(404, 'VIAGEM_INDISPONIVEL', 'Viagem não encontrada ou fora de venda.');
    if (v.data_partida <= agoraIso) return erro(410, 'VENDAS_ENCERRADAS', 'As vendas desta viagem foram encerradas.');
    log('reserva_esgotada', { viagem_id: d.viagem_id });
    return erro(409, 'ESGOTADO', 'As vagas desta viagem acabaram. Fale com a agência para entrar na lista de espera.');
  }

  const reserva = (await db.prepare(`SELECT r.*, v.titulo FROM reservas r JOIN viagens v ON v.id = r.viagem_id WHERE r.id = ?`)
    .bind(reservaId).first<ReservaRow & { titulo: string }>())!;

  // Cobrança Pix no gateway. Se falhar, a vaga é liberada na hora.
  const provider = criarProvider(env);
  let cobranca;
  try {
    cobranca = await provider.criarCobranca({
      reservaId,
      valorCentavos: reserva.valor_centavos,
      descricao: `${env.AGENCIA_NOME} - ${reserva.titulo} - ${reserva.tipo_pagamento === 'SINAL' ? 'Sinal' : 'Integral'} - ${codigoReserva(reservaId)}`,
      expiraEm: new Date(expiraEm),
      pagador: { nome: d.nome, cpf: d.cpf, email: d.email, telefone: d.telefone },
    });
  } catch (e: any) {
    await db.prepare(`UPDATE reservas SET status = 'CANCELADO' WHERE id = ?`).bind(reservaId).run();
    log('gateway_falhou', { reserva_id: reservaId, provider: provider.nome, erro: String(e?.message), detalhe: e instanceof GatewayError ? e.detalhe : undefined });
    return erro(502, 'GATEWAY_INDISPONIVEL', 'Não foi possível gerar o Pix agora. Tente novamente em instantes.');
  }

  await db.batch([
    db.prepare(`UPDATE reservas SET pix_txid = ?2, pix_copia_cola = ?3, pix_qr_base64 = ?4, pix_qr_mime = ?5 WHERE id = ?1`)
      .bind(reservaId, cobranca.paymentId, cobranca.copiaECola, cobranca.qrBase64, cobranca.qrMime),
    db.prepare(`INSERT INTO pagamentos (id, reserva_id, gateway, gateway_payment_id, status_gateway, valor_centavos, criado_em, atualizado_em)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`)
      .bind(crypto.randomUUID(), reservaId, provider.nome, cobranca.paymentId, cobranca.statusGateway, reserva.valor_centavos, agoraIso),
  ]);

  log('reserva_criada', { reserva_id: reservaId, viagem_id: d.viagem_id, tipo: d.tipo_pagamento });
  return {
    status: 201,
    body: payloadReserva({
      ...reserva, pix_txid: cobranca.paymentId, pix_copia_cola: cobranca.copiaECola,
      pix_qr_base64: cobranca.qrBase64, pix_qr_mime: cobranca.qrMime,
    }),
  };
}

/** O mesmo CPF já tem reserva ativa nesta viagem: devolve o Pix pendente em vez de criar outro. */
async function retomarReservaExistente(env: Env, cpfHash: string, viagemId: string, agoraIso: string): Promise<Resposta> {
  const r = await env.DB.prepare(
    `SELECT r.* FROM reservas r JOIN passageiros p ON p.id = r.passageiro_id
      WHERE p.cpf_hash = ? AND r.viagem_id = ? AND r.status IN ('PENDENTE', 'CONFIRMADO')`,
  ).bind(cpfHash, viagemId).first<ReservaRow>();
  if (r?.status === 'CONFIRMADO') {
    return erro(409, 'JA_CONFIRMADA', 'Este CPF já tem uma reserva confirmada nesta viagem.', { codigo: codigoReserva(r.id) });
  }
  if (r && r.pix_copia_cola && r.expira_em > agoraIso) return { status: 200, body: payloadReserva(r, true) };
  return erro(409, 'RESERVA_EM_ANDAMENTO', 'Já existe uma reserva em andamento para este CPF. Aguarde alguns instantes.');
}

// ---------------------------------------------------------------------------
// POST /api/webhook/pix
// ---------------------------------------------------------------------------
export async function processarWebhook(env: Env, req: Request, enfileirar: (reservaId: string) => Promise<void>): Promise<Resposta> {
  const provider = criarProvider(env);
  const corpo = await req.text();
  const val = await provider.validarWebhook(req, corpo);
  if (!val) {
    log('webhook_rejeitado', { provider: provider.nome });
    return erro(401, 'NAO_AUTORIZADO', 'Assinatura inválida');
  }

  const db = env.DB;
  const jaVisto = await db.prepare(`SELECT 1 FROM webhook_eventos WHERE id = ?`).bind(val.eventoId).first();
  if (jaVisto) return { status: 200, body: { ok: true, duplicado: true } };

  // Nunca confiamos no corpo do webhook: consultamos o pagamento na API do gateway.
  const consulta = await provider.consultar(val.paymentId); // se falhar → 500 e o gateway reenvia
  const agora = agoraISO();

  const pag = await db.prepare(`SELECT p.*, r.valor_centavos AS valor_reserva, r.status AS status_reserva
                                  FROM pagamentos p JOIN reservas r ON r.id = p.reserva_id
                                 WHERE p.gateway_payment_id = ?`)
    .bind(consulta.paymentId).first<any>();

  if (!pag) {
    log('webhook_pagamento_desconhecido', { payment_id: consulta.paymentId });
    await registrarEvento(env, val.eventoId, agora);
    return { status: 200, body: { ok: true, ignorado: true } };
  }

  await db.prepare(`UPDATE pagamentos SET status_gateway = ?, atualizado_em = ? WHERE id = ?`)
    .bind(consulta.statusGateway, agora, pag.id).run();

  if (consulta.status !== 'APROVADO') {
    if (consulta.status === 'ESTORNADO') {
      await db.prepare(`UPDATE pagamentos SET status_interno = 'ESTORNADO', atualizado_em = ? WHERE id = ?`).bind(agora, pag.id).run();
    }
    await registrarEvento(env, val.eventoId, agora);
    return { status: 200, body: { ok: true, status: consulta.status } };
  }

  if (consulta.valorCentavos < pag.valor_centavos) {
    await marcarPagamento(env, pag.id, 'DIVERGENTE', `Pago ${consulta.valorCentavos} < esperado ${pag.valor_centavos}`, agora);
    log('pagamento_divergente', { reserva_id: pag.reserva_id });
    await registrarEvento(env, val.eventoId, agora);
    return { status: 200, body: { ok: true, divergente: true } };
  }

  // Pix do saldo: a vaga já é do passageiro; só registra o valor (ou manda estornar se a reserva caiu).
  if (pag.tipo === 'SALDO') {
    if (pag.status_reserva === 'CONFIRMADO') {
      await marcarPagamento(env, pag.id, 'APROVADO', null, agora);
      log('saldo_pago', { reserva_id: pag.reserva_id });
    } else {
      await marcarPagamento(env, pag.id, 'ESTORNAR', `Saldo pago com reserva ${pag.status_reserva}`, agora);
      log('ALERTA_estorno_necessario', { reserva_id: pag.reserva_id, payment_id: consulta.paymentId });
    }
    await registrarEvento(env, val.eventoId, agora);
    return { status: 200, body: { ok: true, saldo: true } };
  }

  // Confirma se a reserva ainda é válida OU (pagamento tardio) se ainda houver vaga.
  let confirmou = false;
  try {
    const res = await db.prepare(
      `UPDATE reservas SET status = 'CONFIRMADO', confirmado_em = ?2
        WHERE id = ?1 AND status IN ('PENDENTE', 'EXPIRADO')
          AND (SELECT COUNT(*) FROM reservas o
                WHERE o.viagem_id = reservas.viagem_id AND o.id <> reservas.id
                  AND (o.status = 'CONFIRMADO' OR (o.status = 'PENDENTE' AND o.expira_em > ?2)))
              < (SELECT total_vagas FROM viagens WHERE id = reservas.viagem_id)`,
    ).bind(pag.reserva_id, agora).run();
    confirmou = (res.meta.changes ?? 0) === 1;
  } catch (e: any) {
    if (!String(e?.message).includes('UNIQUE')) throw e; // passageiro já tem outra reserva ativa
  }

  if (confirmou) {
    await marcarPagamento(env, pag.id, 'APROVADO', null, agora);
    await enfileirar(pag.reserva_id);
    log('reserva_confirmada', { reserva_id: pag.reserva_id, tardio: pag.status_reserva === 'EXPIRADO' });
  } else {
    const atual = await db.prepare(`SELECT status FROM reservas WHERE id = ?`).bind(pag.reserva_id).first<{ status: string }>();
    if (atual?.status === 'CONFIRMADO') {
      await marcarPagamento(env, pag.id, 'APROVADO', null, agora);
    } else {
      await marcarPagamento(env, pag.id, 'ESTORNAR', `Pago com reserva ${atual?.status} e sem vaga disponível`, agora);
      log('ALERTA_estorno_necessario', { reserva_id: pag.reserva_id, payment_id: consulta.paymentId });
    }
  }

  await registrarEvento(env, val.eventoId, agora);
  return { status: 200, body: { ok: true, confirmado: confirmou } };
}

async function registrarEvento(env: Env, id: string, agora: string) {
  await env.DB.prepare(`INSERT OR IGNORE INTO webhook_eventos (id, recebido_em) VALUES (?, ?)`).bind(id, agora).run();
}

async function marcarPagamento(env: Env, id: string, status: string, obs: string | null, agora: string) {
  await env.DB.prepare(`UPDATE pagamentos SET status_interno = ?, observacao = COALESCE(?, observacao), atualizado_em = ? WHERE id = ?`)
    .bind(status, obs, agora, id).run();
}

// ---------------------------------------------------------------------------
// Cron: expira pendentes vencidas e cancela a cobrança no gateway
// ---------------------------------------------------------------------------
export async function expirarPendentes(env: Env): Promise<number> {
  const agora = agoraISO();
  const { results } = await env.DB.prepare(
    `UPDATE reservas SET status = 'EXPIRADO'
      WHERE status = 'PENDENTE' AND expira_em <= ?
      RETURNING id, pix_txid`,
  ).bind(agora).all<{ id: string; pix_txid: string | null }>();

  await expirarPixSaldo(env, agora);
  if (!results.length) return 0;
  const provider = criarProvider(env);
  await Promise.allSettled(results.filter((r) => r.pix_txid).map(async (r) => {
    try {
      await provider.cancelar(r.pix_txid!);
      await env.DB.prepare(`UPDATE pagamentos SET status_interno = 'CANCELADO', atualizado_em = ?
                             WHERE gateway_payment_id = ? AND status_interno = 'AGUARDANDO'`).bind(agora, r.pix_txid).run();
    } catch (e: any) {
      // Já pago ou já expirado no gateway: o webhook trata o pagamento tardio.
      log('cancelamento_gateway_falhou', { reserva_id: r.id, erro: String(e?.message) });
    }
  }));
  log('reservas_expiradas', { quantidade: results.length });
  return results.length;
}

export async function enviarOuEnfileirar(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, reservaId: string) {
  if (env.WHATSAPP_QUEUE) {
    await env.WHATSAPP_QUEUE.send({ reservaId });
  } else {
    ctx.waitUntil(enviarConfirmacaoWhatsApp(env, reservaId).catch((e) => log('whatsapp_falhou', { reserva_id: reservaId, erro: String(e?.message) })));
  }
}

// ---------------------------------------------------------------------------
// Pix do saldo (página da reserva)
// ---------------------------------------------------------------------------
const SALDO_PIX_MINUTOS = 60;

export async function gerarPixSaldo(env: Env, reservaId: string): Promise<Resposta> {
  const db = env.DB;
  const agora = agoraISO();
  const r = await db.prepare(
    `SELECT r.id, r.status, r.valor_total_centavos, ${SQL_PAGO} AS pago, v.titulo, v.data_partida, v.situacao,
            p.nome_completo, p.cpf_cifrado, p.email, p.telefone
       FROM reservas r JOIN viagens v ON v.id = r.viagem_id JOIN passageiros p ON p.id = r.passageiro_id
      WHERE r.id = ?`,
  ).bind(reservaId).first<any>();
  if (!r) return erro(404, 'NAO_ENCONTRADA', 'Reserva não encontrada');
  if (r.status !== 'CONFIRMADO' || r.situacao === 'CANCELADA') return erro(409, 'SEM_SALDO', 'Esta reserva não aceita pagamento agora.');
  const saldo = (r.valor_total_centavos ?? 0) - r.pago;
  if (saldo <= 0) return erro(409, 'QUITADA', 'Esta reserva já está quitada.');

  // Reaproveita um Pix de saldo ainda válido e com o mesmo valor.
  const existente = await db.prepare(
    `SELECT gateway_payment_id, valor_centavos, pix_copia_cola, pix_qr_base64, pix_qr_mime, expira_em FROM pagamentos
      WHERE reserva_id = ? AND tipo = 'SALDO' AND status_interno = 'AGUARDANDO' AND expira_em > ? ORDER BY criado_em DESC LIMIT 1`,
  ).bind(reservaId, agora).first<any>();
  if (existente && existente.valor_centavos === saldo) return { status: 200, body: { ok: true, data: pixSaldo(existente) } };

  const expiraEm = new Date(Date.now() + SALDO_PIX_MINUTOS * 60_000);
  const provider = criarProvider(env);
  let cobranca;
  try {
    cobranca = await provider.criarCobranca({
      reservaId,
      valorCentavos: saldo,
      descricao: `${env.AGENCIA_NOME} - ${r.titulo} - Saldo - ${codigoReserva(reservaId)}`,
      expiraEm,
      pagador: { nome: r.nome_completo, cpf: await decifrar(r.cpf_cifrado, env.DATA_ENC_KEY), email: r.email, telefone: r.telefone },
    });
  } catch (e: any) {
    log('gateway_falhou', { reserva_id: reservaId, provider: provider.nome, saldo: true, erro: String(e?.message) });
    return erro(502, 'GATEWAY_INDISPONIVEL', 'Não foi possível gerar o Pix agora. Tente novamente em instantes.');
  }
  await db.prepare(
    `INSERT INTO pagamentos (id, reserva_id, gateway, gateway_payment_id, status_gateway, valor_centavos, tipo,
                             pix_copia_cola, pix_qr_base64, pix_qr_mime, expira_em, criado_em, atualizado_em)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'SALDO', ?7, ?8, ?9, ?10, ?11, ?11)`,
  ).bind(crypto.randomUUID(), reservaId, provider.nome, cobranca.paymentId, cobranca.statusGateway, saldo,
    cobranca.copiaECola, cobranca.qrBase64, cobranca.qrMime, expiraEm.toISOString(), agora).run();
  log('pix_saldo_gerado', { reserva_id: reservaId });
  return {
    status: 201,
    body: { ok: true, data: pixSaldo({ valor_centavos: saldo, pix_copia_cola: cobranca.copiaECola,
      pix_qr_base64: cobranca.qrBase64, pix_qr_mime: cobranca.qrMime, expira_em: expiraEm.toISOString() }) },
  };
}

function pixSaldo(p: any) {
  return { valor_centavos: p.valor_centavos, expira_em: p.expira_em, pix: { copia_e_cola: p.pix_copia_cola, qr_base64: p.pix_qr_base64, qr_mime: p.pix_qr_mime } };
}

async function expirarPixSaldo(env: Env, agora: string) {
  const { results } = await env.DB.prepare(
    `UPDATE pagamentos SET status_interno = 'CANCELADO', atualizado_em = ?1
      WHERE tipo = 'SALDO' AND status_interno = 'AGUARDANDO' AND expira_em <= ?1
      RETURNING gateway_payment_id`,
  ).bind(agora).all<{ gateway_payment_id: string }>();
  if (!results.length) return;
  const provider = criarProvider(env);
  // Se o cliente pagar mesmo assim, o webhook acha o pagamento e registra (ou manda estornar).
  await Promise.allSettled(results.map((p) => provider.cancelar(p.gateway_payment_id)));
}
