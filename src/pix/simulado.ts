// Provider SIMULADO — só para desenvolvimento e homologação (bloqueado em produção).
// Gera um "QR" ilustrativo e permite simular o pagamento chamando o webhook com
// o cabeçalho x-simulado-secret = PIX_WEBHOOK_SECRET e corpo {"payment_id": "..."}.
// O estado dos pagamentos simulados fica na própria tabela `pagamentos`.
import type { Env } from '../types';
import { iguaisTempoConstante } from '../crypto';
import type { CobrancaPix, ConsultaPagamento, DadosCobranca, PixProvider, WebhookValidado } from './provider';

export class SimuladoProvider implements PixProvider {
  readonly nome = 'simulado';
  constructor(private env: Env) {}

  async criarCobranca(d: DadosCobranca): Promise<CobrancaPix> {
    const paymentId = 'sim_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    const valor = (d.valorCentavos / 100).toFixed(2);
    const copiaECola = `00020126580014BR.GOV.BCB.PIX0136SIMULADO-${paymentId}5204000053039865406${valor}5802BR5914APOLLO TURISMO6009SAO PAULO62070503***6304ABCD`;
    return {
      paymentId,
      copiaECola,
      qrBase64: btoa(qrFicticioSvg(paymentId)),
      qrMime: 'image/svg+xml',
      statusGateway: 'pending',
    };
  }

  async consultar(paymentId: string): Promise<ConsultaPagamento> {
    const row = await this.env.DB.prepare(
      `SELECT p.status_gateway, p.valor_centavos, p.reserva_id FROM pagamentos p WHERE p.gateway_payment_id = ?`,
    ).bind(paymentId).first<{ status_gateway: string; valor_centavos: number; reserva_id: string }>();
    if (!row) throw new Error('Pagamento simulado não encontrado');
    const status = row.status_gateway === 'approved' ? 'APROVADO' : row.status_gateway === 'cancelled' ? 'CANCELADO' : 'PENDENTE';
    return { paymentId, status, statusGateway: row.status_gateway, valorCentavos: row.valor_centavos, referencia: row.reserva_id };
  }

  async cancelar(paymentId: string): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE pagamentos SET status_gateway = 'cancelled' WHERE gateway_payment_id = ? AND status_gateway = 'pending'`,
    ).bind(paymentId).run();
  }

  async validarWebhook(req: Request, corpo: string): Promise<WebhookValidado | null> {
    const secret = this.env.PIX_WEBHOOK_SECRET ?? 'dev-secret';
    if (!iguaisTempoConstante(req.headers.get('x-simulado-secret') ?? '', secret)) return null;
    let json: any;
    try { json = JSON.parse(corpo); } catch { return null; }
    if (!json?.payment_id) return null;
    // "Aprova" o pagamento no gateway simulado, como se o cliente tivesse pago.
    await this.env.DB.prepare(
      `UPDATE pagamentos SET status_gateway = 'approved' WHERE gateway_payment_id = ? AND status_gateway = 'pending'`,
    ).bind(json.payment_id).run();
    return { eventoId: `sim:${json.event_id ?? crypto.randomUUID()}`, paymentId: String(json.payment_id) };
  }
}

function qrFicticioSvg(seed: string): string {
  // Padrão determinístico só para visualização — NÃO é um QR Code Pix válido.
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const n = 25, s = 8;
  let rects = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    h = (h * 1103515245 + 12345) >>> 0;
    const finder = (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
    const on = finder ? (x % 6 === 0 || y % 6 === 0 || (x % 6 >= 2 && x % 6 <= 4 && y % 6 >= 2 && y % 6 <= 4)) : (h >> 16) & 1;
    if (on) rects += `<rect x="${x * s}" y="${y * s}" width="${s}" height="${s}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-16 -16 232 232" width="232" height="232"><rect x="-16" y="-16" width="232" height="232" fill="#fff"/><g fill="#111">${rects}</g></svg>`;
}
