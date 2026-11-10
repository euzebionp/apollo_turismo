import type { Env } from '../types';
import { MercadoPagoProvider } from './mercadopago';
import { AsaasProvider } from './asaas';
import { SimuladoProvider } from './simulado';

export interface DadosCobranca {
  reservaId: string;
  valorCentavos: number;
  descricao: string;
  expiraEm: Date;
  pagador: { nome: string; cpf: string; email: string; telefone: string };
}

export interface CobrancaPix {
  paymentId: string;
  copiaECola: string;
  qrBase64: string;
  qrMime: string;
  statusGateway: string;
}

export type StatusPagamento = 'APROVADO' | 'PENDENTE' | 'CANCELADO' | 'ESTORNADO' | 'OUTRO';

export interface ConsultaPagamento {
  paymentId: string;
  status: StatusPagamento;
  statusGateway: string;
  valorCentavos: number;
  referencia: string | null; // reserva_id
}

export interface WebhookValidado {
  eventoId: string;   // chave de idempotência
  paymentId: string;
}

export interface PixProvider {
  readonly nome: string;
  criarCobranca(d: DadosCobranca): Promise<CobrancaPix>;
  consultar(paymentId: string): Promise<ConsultaPagamento>;
  cancelar(paymentId: string): Promise<void>;
  /** Retorna null quando a assinatura/token não confere ou o evento não é de pagamento. */
  validarWebhook(req: Request, corpo: string): Promise<WebhookValidado | null>;
}

export class GatewayError extends Error {
  constructor(message: string, readonly status?: number, readonly detalhe?: string) {
    super(message);
  }
}

export function criarProvider(env: Env): PixProvider {
  switch (env.PIX_PROVIDER) {
    case 'mercadopago':
      return new MercadoPagoProvider(env);
    case 'asaas':
      return new AsaasProvider(env);
    case 'simulado':
      if (env.AMBIENTE === 'production') throw new Error('Provider simulado não pode rodar em produção');
      return new SimuladoProvider(env);
    default:
      throw new Error(`PIX_PROVIDER desconhecido: ${env.PIX_PROVIDER}`);
  }
}

export const centavosParaReais = (c: number) => Math.round(c) / 100;
export const reaisParaCentavos = (r: number) => Math.round(Number(r) * 100);
