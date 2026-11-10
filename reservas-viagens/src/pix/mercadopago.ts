// Adaptador Mercado Pago — API de Pagamentos (Pix).
// Confira os nomes de campos na documentação vigente antes de ir a produção.
import type { Env } from '../types';
import { hmacHex, iguaisTempoConstante } from '../crypto';
import {
  GatewayError, centavosParaReais, reaisParaCentavos,
  type CobrancaPix, type ConsultaPagamento, type DadosCobranca, type PixProvider, type StatusPagamento, type WebhookValidado,
} from './provider';

const BASE = 'https://api.mercadopago.com';

// O Mercado Pago exige expiração mínima de ~30 min para Pix. A trava da vaga continua
// em 15 min no nosso banco; o cron cancela a cobrança no gateway quando a reserva expira.
const EXPIRACAO_MINIMA_MS = 31 * 60 * 1000;

export class MercadoPagoProvider implements PixProvider {
  readonly nome = 'mercadopago';
  constructor(private env: Env) {}

  private async req(path: string, init: RequestInit & { idempotencia?: string } = {}) {
    if (!this.env.PIX_ACCESS_TOKEN) throw new GatewayError('PIX_ACCESS_TOKEN não configurado');
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.env.PIX_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    };
    if (init.idempotencia) headers['X-Idempotency-Key'] = init.idempotencia;
    const res = await fetch(BASE + path, { ...init, headers });
    const texto = await res.text();
    if (!res.ok) throw new GatewayError(`Mercado Pago ${res.status}`, res.status, texto.slice(0, 500));
    return texto ? JSON.parse(texto) : {};
  }

  async criarCobranca(d: DadosCobranca): Promise<CobrancaPix> {
    const expira = new Date(Math.max(d.expiraEm.getTime(), Date.now() + EXPIRACAO_MINIMA_MS));
    const [primeiro, ...resto] = d.pagador.nome.split(' ');
    const body = {
      transaction_amount: centavosParaReais(d.valorCentavos),
      description: d.descricao.slice(0, 250),
      payment_method_id: 'pix',
      external_reference: d.reservaId,
      date_of_expiration: expira.toISOString().replace('Z', '+00:00'),
      payer: {
        email: d.pagador.email,
        first_name: primeiro,
        last_name: resto.join(' '),
        identification: { type: 'CPF', number: d.pagador.cpf },
      },
    };
    const p = await this.req('/v1/payments', { method: 'POST', body: JSON.stringify(body), idempotencia: d.reservaId });
    const td = p?.point_of_interaction?.transaction_data;
    if (!td?.qr_code) throw new GatewayError('Resposta do Mercado Pago sem QR Code');
    return {
      paymentId: String(p.id),
      copiaECola: td.qr_code,
      qrBase64: td.qr_code_base64,
      qrMime: 'image/png',
      statusGateway: String(p.status),
    };
  }

  async consultar(paymentId: string): Promise<ConsultaPagamento> {
    const p = await this.req(`/v1/payments/${encodeURIComponent(paymentId)}`);
    const mapa: Record<string, StatusPagamento> = {
      approved: 'APROVADO', pending: 'PENDENTE', in_process: 'PENDENTE', authorized: 'PENDENTE',
      cancelled: 'CANCELADO', rejected: 'CANCELADO', refunded: 'ESTORNADO', charged_back: 'ESTORNADO',
    };
    return {
      paymentId: String(p.id),
      status: mapa[p.status] ?? 'OUTRO',
      statusGateway: String(p.status),
      valorCentavos: reaisParaCentavos(p.transaction_amount),
      referencia: p.external_reference ?? null,
    };
  }

  async cancelar(paymentId: string): Promise<void> {
    await this.req(`/v1/payments/${encodeURIComponent(paymentId)}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'cancelled' }),
    });
  }

  // Assinatura: cabeçalho x-signature = "ts=<ts>,v1=<hmac>"; manifesto
  // "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" assinado com a chave secreta do webhook.
  async validarWebhook(req: Request, corpo: string): Promise<WebhookValidado | null> {
    const secret = this.env.PIX_WEBHOOK_SECRET;
    if (!secret) throw new Error('PIX_WEBHOOK_SECRET não configurado');

    const url = new URL(req.url);
    let json: any = {};
    try { json = JSON.parse(corpo || '{}'); } catch { /* corpo vazio */ }

    const tipo = url.searchParams.get('type') ?? json.type ?? url.searchParams.get('topic');
    if (tipo !== 'payment') return null;

    const dataId = url.searchParams.get('data.id') ?? (json?.data?.id != null ? String(json.data.id) : null);
    const sig = req.headers.get('x-signature') ?? '';
    const requestId = req.headers.get('x-request-id') ?? '';
    if (!dataId || !sig) return null;

    const partes = Object.fromEntries(sig.split(',').map((p) => p.trim().split('=') as [string, string]));
    if (!partes.ts || !partes.v1) return null;

    const idManifesto = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
    let manifesto = `id:${idManifesto};`;
    if (requestId) manifesto += `request-id:${requestId};`;
    manifesto += `ts:${partes.ts};`;

    const esperado = await hmacHex(secret, manifesto);
    if (!iguaisTempoConstante(esperado, partes.v1)) return null;

    return { eventoId: `mp:${requestId || partes.ts}:${dataId}`, paymentId: dataId };
  }
}
