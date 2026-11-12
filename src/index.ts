// Apollo Turismo — Plataforma de Reservas (Cloudflare Worker + D1 + Pix)
import { Hono } from 'hono';
import type { Env, MensagemWhatsApp, ViagemRow } from './types';
import { validarReserva } from './validacao';
import { criarReserva, enviarOuEnfileirar, expirarPendentes, gerarPixSaldo, processarWebhook, verificarTurnstile } from './reservas';
import { enviarConfirmacaoWhatsApp, codigoReserva } from './whatsapp';
import admin from './admin';
import { servirFoto } from './fotos';
import { agoraISO, log } from './util';
import { DIA_MS, jsonOu, lerInclusos, lerLayout, lerPontos, SQL_PAGO, sqlSeguraLugar } from './viagem';

const app = new Hono<{ Bindings: Env }>();

// Cabeçalhos de segurança para todas as respostas da API.
app.use('/api/*', async (c, next) => {
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store');
});

app.onError((err, c) => {
  log('erro_nao_tratado', { rota: c.req.path, erro: String(err?.message ?? err) });
  return c.json({ ok: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro inesperado. Tente novamente.' } }, 500);
});

// ---------------------------------------------------------------------------
// Público
// ---------------------------------------------------------------------------
app.get('/api/config', (c) =>
  c.json({
    ok: true,
    data: {
      agencia_nome: c.env.AGENCIA_NOME,
      agencia_whatsapp: c.env.AGENCIA_WHATSAPP,
      turnstile_site_key: c.env.TURNSTILE_SECRET ? c.env.TURNSTILE_SITE_KEY : null,
      reserva_minutos: Number(c.env.RESERVA_MINUTOS || 15),
      simulado: c.env.PIX_PROVIDER === 'simulado' && c.env.AMBIENTE !== 'production',
    },
  }, 200, { 'Cache-Control': 'public, max-age=300' }));

app.get('/api/viagens', async (c) => {
  const agora = agoraISO();
  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.titulo, v.destino, v.data_partida, v.data_retorno, v.preco_integral_centavos, v.preco_sinal_centavos, v.total_vagas,
            v.fotos_json,
            v.total_vagas - (SELECT COUNT(*) FROM reservas r WHERE r.viagem_id = v.id AND ${sqlSeguraLugar('?1')}) AS vagas_disponiveis
       FROM viagens v WHERE v.ativa = 1 AND v.situacao = 'PUBLICADA' AND v.data_partida > ?1 ORDER BY v.data_partida`,
  ).bind(agora).all<any>();
  const data = results.map(({ fotos_json, ...v }) => ({ ...v, capa: capaDe(fotos_json) }));
  return c.json({ ok: true, data }, 200, { 'Cache-Control': 'public, max-age=15' });
});

app.get('/api/viagem/:id', async (c) => {
  const agora = agoraISO();
  const v = await c.env.DB.prepare(
    `SELECT v.*,
            (SELECT COUNT(*) FROM reservas r WHERE r.viagem_id = v.id AND r.status = 'CONFIRMADO') AS confirmadas,
            (SELECT COUNT(*) FROM reservas r WHERE r.viagem_id = v.id AND r.status = 'PENDENTE' AND r.expira_em > ?2) AS pendentes
       FROM viagens v WHERE v.id = ?1 AND v.ativa = 1 AND v.situacao = 'PUBLICADA'`,
  ).bind(c.req.param('id'), agora).first<ViagemRow & { confirmadas: number; pendentes: number }>();
  if (!v) return c.json({ ok: false, erro: { codigo: 'NAO_ENCONTRADA', mensagem: 'Viagem não encontrada' } }, 404);

  const ocupadas = v.confirmadas + v.pendentes;
  const layout = lerLayout(v.layout_json);
  let poltronasOcupadas: number[] = [];
  if (layout) {
    const { results } = await c.env.DB.prepare(
      `SELECT r.poltrona FROM reservas r WHERE r.viagem_id = ?1 AND r.poltrona IS NOT NULL AND ${sqlSeguraLugar('?2')}`,
    ).bind(v.id, agora).all<{ poltrona: number }>();
    poltronasOcupadas = results.map((x) => x.poltrona);
  }
  return c.json({
    ok: true,
    data: {
      id: v.id,
      titulo: v.titulo,
      destino: v.destino,
      descricao: v.descricao,
      data_partida: v.data_partida,
      data_retorno: v.data_retorno,
      local_embarque: v.local_embarque,
      preco_integral_centavos: v.preco_integral_centavos,
      preco_sinal_centavos: v.preco_sinal_centavos,
      programacao: JSON.parse(v.programacao_json),
      fotos: JSON.parse(v.fotos_json),
      total_vagas: v.total_vagas,
      vagas_ocupadas: ocupadas,
      vagas_disponiveis: Math.max(0, v.total_vagas - ocupadas),
      vendas_abertas: v.data_partida > agora,
      layout,
      poltronas_ocupadas: poltronasOcupadas,
      pontos_embarque: lerPontos(v.pontos_embarque_json).map(({ id, nome, endereco, horario }) => ({ id, nome, endereco, horario })),
      inclusos: lerInclusos(v.inclusos_json),
      politica_cancelamento: v.politica_cancelamento,
    },
  }, 200, { 'Cache-Control': 'public, max-age=10' });
});

app.post('/api/reservar', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? '';
  if (c.env.RESERVA_LIMITER) {
    const { success } = await c.env.RESERVA_LIMITER.limit({ key: `reservar:${ip}` });
    if (!success) return c.json({ ok: false, erro: { codigo: 'MUITAS_TENTATIVAS', mensagem: 'Muitas tentativas. Aguarde um minuto.' } }, 429);
  }

  const body = await c.req.json().catch(() => null);
  const val = validarReserva(body);
  if (!val.ok) return c.json({ ok: false, erro: { codigo: 'DADOS_INVALIDOS', mensagem: 'Verifique os campos destacados.', campos: val.campos } }, 400);

  if (!(await verificarTurnstile(c.env, val.dados.turnstile_token, ip))) {
    return c.json({ ok: false, erro: { codigo: 'VERIFICACAO_FALHOU', mensagem: 'Não conseguimos verificar que você é humano. Recarregue a página.' } }, 403);
  }

  const r = await criarReserva(c.env, val.dados);
  return c.json(r.body, r.status as any);
});

app.get('/api/reserva/:id/status', async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT r.id, r.status, r.expira_em, r.tipo_pagamento, r.valor_centavos, r.confirmado_em,
            r.poltrona, r.ponto_embarque_nome, COALESCE(r.valor_total_centavos, r.valor_centavos) AS valor_total_centavos,
            v.titulo, v.data_partida, v.local_embarque
       FROM reservas r JOIN viagens v ON v.id = r.viagem_id WHERE r.id = ?`,
  ).bind(c.req.param('id')).first<any>();
  if (!r) return c.json({ ok: false, erro: { codigo: 'NAO_ENCONTRADA', mensagem: 'Reserva não encontrada' } }, 404);
  const status = r.status === 'PENDENTE' && r.expira_em <= agoraISO() ? 'EXPIRADO' : r.status;
  return c.json({ ok: true, data: { ...r, status, codigo: codigoReserva(r.id), link: `/r/${r.id}` } });
});

// ---------------------------------------------------------------------------
// Página da reserva (/r/<id>) — o id é um UUID aleatório: quem tem o link acompanha a reserva.
// ---------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

app.get('/api/r/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json({ ok: false, erro: { codigo: 'NAO_ENCONTRADA', mensagem: 'Reserva não encontrada' } }, 404);
  const agora = agoraISO();
  const r = await c.env.DB.prepare(
    `SELECT r.*, ${SQL_PAGO} AS pago, p.nome_completo,
            v.titulo, v.destino, v.data_partida, v.data_retorno, v.situacao, v.motivo_cancelamento, v.local_embarque,
            v.pontos_embarque_json, v.grupo_whatsapp, v.motorista_nome, v.veiculo_descricao, v.fotos_json
       FROM reservas r JOIN passageiros p ON p.id = r.passageiro_id JOIN viagens v ON v.id = r.viagem_id
      WHERE r.id = ?`,
  ).bind(id).first<any>();
  if (!r) return c.json({ ok: false, erro: { codigo: 'NAO_ENCONTRADA', mensagem: 'Reserva não encontrada' } }, 404);

  const status = r.status === 'PENDENTE' && r.expira_em <= agora ? 'EXPIRADO' : r.status;
  const confirmada = status === 'CONFIRMADO' && r.situacao !== 'CANCELADA';
  const pontoAtual = lerPontos(r.pontos_embarque_json).find((p) => p.id === r.ponto_embarque_id);
  const ponto = pontoAtual
    ? { nome: pontoAtual.nome, endereco: pontoAtual.endereco, horario: pontoAtual.horario }
    : r.ponto_embarque_nome ? { nome: r.ponto_embarque_nome, endereco: '', horario: null }
    : r.local_embarque ? { nome: r.local_embarque, endereco: '', horario: null } : null;
  const total = r.valor_total_centavos ?? r.valor_centavos;
  const faltaPouco = new Date(r.data_partida).getTime() - Date.now() <= 2 * DIA_MS;

  const { results: pagamentos } = await c.env.DB.prepare(
    `SELECT tipo, valor_centavos, COALESCE(recebido_em, atualizado_em) AS data FROM pagamentos
      WHERE reserva_id = ? AND status_interno = 'APROVADO' ORDER BY data`,
  ).bind(id).all<any>();

  return c.json({
    ok: true,
    data: {
      id: r.id,
      codigo: codigoReserva(r.id),
      status,
      primeiro_nome: String(r.nome_completo).split(' ')[0],
      poltrona: r.poltrona,
      ponto_embarque: ponto,
      tipo_pagamento: r.tipo_pagamento,
      valor_total_centavos: total,
      pago_centavos: r.pago,
      saldo_centavos: Math.max(0, total - r.pago),
      pagamentos,
      politica_aceita: r.politica_aceita,
      desistencia_em: r.desistencia_em,
      pode_pedir_desistencia: confirmada && !r.desistencia_em && r.data_partida > agora,
      pix_pendente: status === 'PENDENTE' && r.pix_copia_cola
        ? { expira_em: r.expira_em, valor_centavos: r.valor_centavos, copia_e_cola: r.pix_copia_cola, qr_base64: r.pix_qr_base64, qr_mime: r.pix_qr_mime }
        : null,
      grupo_whatsapp: confirmada ? r.grupo_whatsapp : null,
      motorista_nome: confirmada && faltaPouco ? r.motorista_nome : null,
      viagem: {
        id: r.viagem_id, titulo: r.titulo, destino: r.destino, data_partida: r.data_partida, data_retorno: r.data_retorno,
        situacao: r.situacao, motivo_cancelamento: r.situacao === 'CANCELADA' ? r.motivo_cancelamento : null,
        capa: capaDe(r.fotos_json),
      },
    },
  });
});

app.post('/api/r/:id/saldo', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json({ ok: false, erro: { codigo: 'NAO_ENCONTRADA', mensagem: 'Reserva não encontrada' } }, 404);
  if (c.env.RESERVA_LIMITER) {
    const { success } = await c.env.RESERVA_LIMITER.limit({ key: `saldo:${c.req.header('CF-Connecting-IP') ?? ''}` });
    if (!success) return c.json({ ok: false, erro: { codigo: 'MUITAS_TENTATIVAS', mensagem: 'Muitas tentativas. Aguarde um minuto.' } }, 429);
  }
  const r = await gerarPixSaldo(c.env, id);
  return c.json(r.body, r.status as any);
});

app.post('/api/r/:id/desistencia', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json({ ok: false, erro: { codigo: 'NAO_ENCONTRADA', mensagem: 'Reserva não encontrada' } }, 404);
  if (c.env.RESERVA_LIMITER) {
    const { success } = await c.env.RESERVA_LIMITER.limit({ key: `desist:${c.req.header('CF-Connecting-IP') ?? ''}` });
    if (!success) return c.json({ ok: false, erro: { codigo: 'MUITAS_TENTATIVAS', mensagem: 'Muitas tentativas. Aguarde um minuto.' } }, 429);
  }
  const b = await c.req.json().catch(() => ({}));
  const motivo = String(b?.motivo ?? '').trim().slice(0, 500) || null;
  const agora = agoraISO();
  const res = await c.env.DB.prepare(
    `UPDATE reservas SET desistencia_em = ?2, desistencia_motivo = ?3
      WHERE id = ?1 AND status = 'CONFIRMADO' AND desistencia_em IS NULL
        AND (SELECT data_partida FROM viagens v WHERE v.id = reservas.viagem_id) > ?2`,
  ).bind(id, agora, motivo).run();
  if (!res.meta.changes) return c.json({ ok: false, erro: { codigo: 'NAO_PERMITIDO', mensagem: 'Não é possível pedir desistência desta reserva.' } }, 409);
  log('desistencia_pedida', { reserva_id: id });
  return c.json({ ok: true });
});

app.post('/api/webhook/pix', async (c) => {
  const r = await processarWebhook(c.env, c.req.raw, (reservaId) => enviarOuEnfileirar(c.env, c.executionCtx, reservaId));
  return c.json(r.body, r.status as any);
});

// Somente com PIX_PROVIDER=simulado fora de produção: simula o cliente pagando o Pix.
app.post('/api/dev/simular-pagamento/:id', async (c) => {
  if (c.env.PIX_PROVIDER !== 'simulado' || c.env.AMBIENTE === 'production') return c.json({ ok: false }, 404);
  const r = await c.env.DB.prepare(
    `SELECT gateway_payment_id AS pix_txid FROM pagamentos WHERE reserva_id = ? AND status_interno = 'AGUARDANDO' ORDER BY criado_em DESC LIMIT 1`,
  ).bind(c.req.param('id')).first<{ pix_txid: string }>();
  if (!r?.pix_txid) return c.json({ ok: false, erro: { codigo: 'NAO_ENCONTRADA', mensagem: 'Reserva sem Pix aguardando' } }, 404);
  const req = new Request('https://interno/api/webhook/pix', {
    method: 'POST',
    headers: { 'x-simulado-secret': c.env.PIX_WEBHOOK_SECRET ?? 'dev-secret' },
    body: JSON.stringify({ payment_id: r.pix_txid, event_id: c.req.query('event_id') ?? crypto.randomUUID() }),
  });
  const res = await processarWebhook(c.env, req, (reservaId) => enviarOuEnfileirar(c.env, c.executionCtx, reservaId));
  return c.json(res.body, res.status as any);
});

// ---------------------------------------------------------------------------
// Administração
// ---------------------------------------------------------------------------
app.route('/api/admin', admin);

app.all('/api/*', (c) => c.json({ ok: false, erro: { codigo: 'ROTA_INEXISTENTE', mensagem: 'Rota não encontrada' } }, 404));

app.get('/fotos/*', (c) => servirFoto(c.env, c.req.raw, c.executionCtx));

// Página da viagem: o HTML sai com título, descrição e foto da viagem, para a prévia do link
// no WhatsApp/Facebook mostrar a excursão certa (os robôs dessas redes não executam JavaScript).
app.get('/viagem/:id', async (c) => {
  const pagina = await c.env.ASSETS.fetch(new URL('/', c.req.url));
  const v = await c.env.DB.prepare(
    `SELECT id, titulo, destino, descricao, data_partida, fotos_json FROM viagens WHERE id = ? AND situacao = 'PUBLICADA'`,
  ).bind(c.req.param('id')).first<any>();
  if (!v) return pagina;
  const origem = new URL(c.req.url).origin;
  const capa = capaDe(v.fotos_json);
  const imagem = new URL(capa || '/img/banner.jpg', origem).toString();
  const data = new Date(v.data_partida).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'long', year: 'numeric' });
  const titulo = `${v.titulo} — ${c.env.AGENCIA_NOME}`;
  const descricao = `${v.destino} · saída em ${data}. ${String(v.descricao ?? '').slice(0, 140)}`.trim();
  const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const metas = [
    ['og:type', 'website'], ['og:site_name', c.env.AGENCIA_NOME], ['og:title', titulo], ['og:description', descricao],
    ['og:url', `${origem}/viagem/${v.id}`], ...(imagem ? [['og:image', imagem]] : []),
  ].map(([k, val]) => `<meta property="${k}" content="${attr(val)}">`).join('')
    + `<meta name="twitter:card" content="${imagem ? 'summary_large_image' : 'summary'}">`;
  return new HTMLRewriter()
    .on('title', { element: (el) => { el.setInnerContent(titulo); } })
    .on('meta[name="description"]', { element: (el) => { el.setAttribute('content', descricao); } })
    .on('head', { element: (el) => { el.append(metas, { html: true }); } })
    .transform(pagina);
});

// Tudo que não é /api/* nem /fotos/* vem dos static assets (index.html, admin.html).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

function capaDe(fotosJson: string | null): string | null {
  const f = jsonOu<Record<string, { url: string }[]>>(fotosJson, {});
  return f.destino?.[0]?.url || f.hospedagem?.[0]?.url || f.veiculo?.[0]?.url || null;
}

export default {
  fetch: app.fetch,

  // Cron (a cada minuto): expira pendentes e cancela a cobrança no gateway.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(expirarPendentes(env));
  },

  // Consumidor da fila do WhatsApp: reenvia automaticamente em caso de falha.
  async queue(batch: MessageBatch<MensagemWhatsApp>, env: Env) {
    for (const msg of batch.messages) {
      try {
        await enviarConfirmacaoWhatsApp(env, msg.body.reservaId);
        msg.ack();
      } catch (e: any) {
        log('whatsapp_falhou', { reserva_id: msg.body.reservaId, tentativa: msg.attempts, erro: String(e?.message) });
        msg.retry({ delaySeconds: Math.min(300, 30 * msg.attempts) });
      }
    }
  },
} satisfies ExportedHandler<Env, MensagemWhatsApp>;
