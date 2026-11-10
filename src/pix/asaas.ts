// Adaptador Asaas — cobranças Pix (API v3).
// Confira os nomes de campos na documentação vigente antes de ir a produção.
import type { Env } from '../types';
import { iguaisTempoConstante } from '../crypto';
import {
  GatewayError, centavosParaReais, reaisParaCentavos,
  type CobrancaPix, type ConsultaPagamento, type DadosCobranca, type PixProvider, type StatusPagamento, type WebhookValidado,
} from './provider';

export class AsaasProvider implements PixProvider {
  readonly nome = 'asaas';
  constructor(private env: Env) {}

  private async req(path: string, init: RequestInit = {}) {
    if (!this.env.PIX_ACCESS_TOKEN) throw new GatewayError('PIX_ACCESS_TOKEN não configurado');
    const res = await fetch(this.env.ASAAS_BASE_URL + path, {
      ...init,
      headers: {
        access_token: this.env.PIX_ACCESS_TOKEN,
        'Content-Type': 'application/json',
        'User-Agent': 'apollo-reservas',
      },
    });
    const texto = await res.text();
    if (!res.ok) throw new GatewayError(`Asaas ${res.status}`, res.status, texto.slice(0, 500));
    return texto ? JSON.parse(texto) : {};
  }

  private async clienteId(d: DadosCobranca): Promise<string> {
    const busca = await this.req(`/customers?cpfCnpj=${d.pagador.cpf}`);
    if (busca?.data?.[0]?.id) return busca.data[0].id;
    const c = await this.req('/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: d.pagador.nome,
        cpfCnpj: d.pagador.cpf,
        email: d.pagador.email,
        mobilePhone: d.pagador.telefone,
        notificationDisabled: true,
      }),
    });
    return c.id;
  }

  async criarCobranca(d: DadosCobranca): Promise<CobrancaPix> {
    const customer = await this.clienteId(d);
    const hojeBR = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    const cobranca = await this.req('/payments', {
      method: 'POST',
      body: JSON.stringify({
        customer,
        billingType: 'PIX',
        value: centavosParaReais(d.valorCentavos),
        dueDate: hojeBR,
        description: d.descricao.slice(0, 500),
        externalReference: d.reservaId,
      }),
    });
    const qr = await this.req(`/payments/${cobranca.id}/pixQrCode`);
    if (!qr?.payload) throw new GatewayError('Resposta do Asaas sem QR Code');
    return {
      paymentId: String(cobranca.id),
      copiaECola: qr.payload,
      qrBase64: qr.encodedImage,
      qrMime: 'image/png',
      statusGateway: String(cobranca.status),
    };
  }

  async consultar(paymentId: string): Promise<ConsultaPagamento> {
    const p = await this.req(`/payments/${encodeURIComponent(paymentId)}`);
    const mapa: Record<string, StatusPagamento> = {
      RECEIVED: 'APROVADO', CONFIRMED: 'APROVADO', RECEIVED_IN_CASH: 'APROVADO',
      PENDING: 'PENDENTE', AWAITING_RISK_ANALYSIS: 'PENDENTE',
      OVERDUE: 'CANCELADO', DELETED: 'CANCELADO',
      REFUNDED: 'ESTORNADO', REFUND_REQUESTED: 'ESTORNADO', REFUND_IN_PROGRESS: 'ESTORNADO',
    };
    return {
      paymentId: String(p.id),
      status: p.deleted ? 'CANCELADO' : (mapa[p.status] ?? 'OUTRO'),
      statusGateway: String(p.status),
      valorCentavos: reaisParaCentavos(p.value),
      referencia: p.externalReference ?? null,
    };
  }

  async cancelar(paymentId: string): Promise<void> {
    await this.req(`/payments/${encodeURIComponent(paymentId)}`, { method: 'DELETE' });
  }

  // O Asaas envia o token configurado no painel no cabeçalho "asaas-access-token".
  async validarWebhook(req: Request, corpo: string): Promise<WebhookValidado | null> {
    const secret = this.env.PIX_WEBHOOK_SECRET;
    if (!secret) throw new Error('PIX_WEBHOOK_SECRET não configurado');
    const token = req.headers.get('asaas-access-token') ?? '';
    if (!iguaisTempoConstante(token, secret)) return null;
    let json: any;
    try { json = JSON.parse(corpo); } catch { return null; }
    const pid = json?.payment?.id;
    if (!pid || !String(json?.event ?? '').startsWith('PAYMENT_')) return null;
    return { eventoId: `asaas:${json.id ?? `${json.event}:${pid}`}`, paymentId: String(pid) };
  }
}
