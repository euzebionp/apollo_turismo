export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  WHATSAPP_QUEUE?: Queue<MensagemWhatsApp>;
  RESERVA_LIMITER?: RateLimiter;
  LOGIN_LIMITER?: RateLimiter;
  FOTOS?: R2Bucket;          // opcional: com R2 ativado, as fotos vão para lá

  AMBIENTE: string;
  PIX_PROVIDER: 'simulado' | 'mercadopago' | 'asaas';
  RESERVA_MINUTOS: string;
  ASAAS_BASE_URL: string;
  AGENCIA_NOME: string;
  AGENCIA_WHATSAPP: string;
  TURNSTILE_SITE_KEY: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  WHATSAPP_TEMPLATE: string;
  WHATSAPP_TEMPLATE_LANG: string;
  WHATSAPP_API_VERSION: string;

  // secrets
  PIX_ACCESS_TOKEN?: string;
  PIX_WEBHOOK_SECRET?: string;
  MASTER_USUARIO?: string;   // usado só no primeiro login, para criar o master
  MASTER_SENHA?: string;
  DATA_ENC_KEY?: string;
  DATA_HMAC_KEY?: string;
  TURNSTILE_SECRET?: string;
  WHATSAPP_TOKEN?: string;
}

export type StatusReserva = 'PENDENTE' | 'CONFIRMADO' | 'EXPIRADO' | 'CANCELADO';
export type TipoPagamento = 'SINAL' | 'INTEGRAL';

export interface MensagemWhatsApp {
  reservaId: string;
}

export interface ViagemRow {
  id: string;
  titulo: string;
  destino: string;
  descricao: string | null;
  data_partida: string;
  data_retorno: string | null;
  local_embarque: string | null;
  total_vagas: number;
  preco_integral_centavos: number;
  preco_sinal_centavos: number;
  programacao_json: string;
  fotos_json: string;
  ativa: number;
}

export interface ReservaRow {
  id: string;
  viagem_id: string;
  passageiro_id: string;
  tipo_pagamento: TipoPagamento;
  valor_centavos: number;
  status: StatusReserva;
  pix_txid: string | null;
  pix_copia_cola: string | null;
  pix_qr_base64: string | null;
  pix_qr_mime: string | null;
  expira_em: string;
  confirmado_em: string | null;
  criado_em: string;
}
