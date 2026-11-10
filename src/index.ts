// Apollo Turismo — Plataforma de Reservas (Cloudflare Worker + D1 + Pix)
import { Hono } from 'hono';
import type { Env, MensagemWhatsApp, ViagemRow } from './types';
import { validarReserva } from './validacao';
import { criarReserva, enviarOuEnfileirar, expirarPendentes, processarWebhook, verificarTurnstile } from './reservas';
import { enviarConfirmacaoWhatsApp, codigoReserva } from './whatsapp';
import admin from './admin';
import { agoraISO, log } from './util';

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
    `SELECT v.id, v.titulo, v.destino, v.data_partida, v.preco_integral_centavos, v.preco_sinal_centavos, v.total_vagas,
            v.total_vagas - (SELECT COUNT(*) FROM reservas r WHERE r.viagem_id = v.id
              AND (r.status = 'CONFIRMADO' OR (r.status = 'PENDENTE' AND r.expira_em > ?1))) AS vagas_disponiveis
       FROM viagens v WHERE v.ativa = 1 AND v.data_partida > ?1 ORDER BY v.data_partida`,
  ).bind(agora).all();
  return c.json({ ok: true, data: results }, 200, { 'Cache-Control': 'public, max-age=15' });
});

app.get('/api/viagem/:id', async (c) => {
  const agora = agoraISO();
  const v = await c.env.DB.prepare(
    `SELECT v.*,
            (SELECT COUNT(*) FROM reservas r WHERE r.viagem_id = v.id AND r.status = 'CONFIRMADO') AS confirmadas,
            (SELECT COUNT(*) FROM reservas r WHERE r.viagem_id = v.id AND r.status = 'PENDENTE' AND r.expira_em > ?2) AS pendentes
       FROM viagens v WHERE v.id = ?1 AND v.ativa = 1`,
  ).bind(c.req.param('id'), agora).first<ViagemRow & { confirmadas: number; pendentes: number }>();
  if (!v) return c.json({ ok: false, erro: { codigo: 'NAO_ENCONTRADA', mensagem: 'Viagem não encontrada' } }, 404);

  const ocupadas = v.confirmadas + v.pendentes;
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
            v.titulo, v.data_partida, v.local_embarque
       FROM reservas r JOIN viagens v ON v.id = r.viagem_id WHERE r.id = ?`,
  ).bind(c.req.param('id')).first<any>();
  if (!r) return c.json({ ok: false, erro: { codigo: 'NAO_ENCONTRADA', mensagem: 'Reserva não encontrada' } }, 404);
  const status = r.status === 'PENDENTE' && r.expira_em <= agoraISO() ? 'EXPIRADO' : r.status;
  return c.json({ ok: true, data: { ...r, status, codigo: codigoReserva(r.id) } });
});

app.post('/api/webhook/pix', async (c) => {
  const r = await processarWebhook(c.env, c.req.raw, (reservaId) => enviarOuEnfileirar(c.env, c.executionCtx, reservaId));
  return c.json(r.body, r.status as any);
});

// Somente com PIX_PROVIDER=simulado fora de produção: simula o cliente pagando o Pix.
app.post('/api/dev/simular-pagamento/:id', async (c) => {
  if (c.env.PIX_PROVIDER !== 'simulado' || c.env.AMBIENTE === 'production') return c.json({ ok: false }, 404);
  const r = await c.env.DB.prepare(`SELECT pix_txid FROM reservas WHERE id = ?`).bind(c.req.param('id')).first<{ pix_txid: string }>();
  if (!r?.pix_txid) return c.json({ ok: false, erro: { codigo: 'NAO_ENCONTRADA', mensagem: 'Reserva sem Pix' } }, 404);
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

// Tudo que não é /api/* vem dos static assets (index.html, admin.html).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

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
