// Envio do voucher de confirmação pela WhatsApp Cloud API (Meta).
// Mensagens iniciadas pela empresa exigem TEMPLATE aprovado. Modelo sugerido
// (nome: confirmacao_reserva, idioma pt_BR, categoria Utilidade), 6 variáveis:
//   Olá {{1}}! Sua reserva para {{2}} está CONFIRMADA ✅
//   Partida: {{3}}
//   Pagamento: {{4}} ({{5}})
//   Código da reserva: {{6}}
//   Apresente este código no embarque, junto com seu documento com foto.
import type { Env } from './types';
import { formatarDataBR, formatarReais } from './util';

export async function enviarConfirmacaoWhatsApp(env: Env, reservaId: string): Promise<void> {
  const r = await env.DB.prepare(
    `SELECT r.id, r.tipo_pagamento, r.valor_centavos, r.status,
            p.nome_completo, p.telefone, v.titulo, v.data_partida
       FROM reservas r
       JOIN passageiros p ON p.id = r.passageiro_id
       JOIN viagens v ON v.id = r.viagem_id
      WHERE r.id = ?`,
  ).bind(reservaId).first<any>();

  if (!r || r.status !== 'CONFIRMADO') return;

  const codigo = codigoReserva(r.id);
  const params = [
    r.nome_completo.split(' ')[0],
    r.titulo,
    formatarDataBR(r.data_partida),
    formatarReais(r.valor_centavos),
    r.tipo_pagamento === 'SINAL' ? 'sinal' : 'integral',
    codigo,
  ];

  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    console.log(JSON.stringify({ evento: 'whatsapp_nao_configurado', reserva_id: reservaId, params: params.slice(1) }));
    return;
  }

  const res = await fetch(
    `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: `55${r.telefone}`,
        type: 'template',
        template: {
          name: env.WHATSAPP_TEMPLATE,
          language: { code: env.WHATSAPP_TEMPLATE_LANG },
          components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }],
        },
      }),
    },
  );
  if (!res.ok) {
    const corpo = (await res.text()).slice(0, 300);
    throw new Error(`WhatsApp ${res.status}: ${corpo}`); // a fila reenvia
  }
  console.log(JSON.stringify({ evento: 'whatsapp_enviado', reserva_id: reservaId }));
}

export function codigoReserva(id: string): string {
  return id.replace(/-/g, '').slice(0, 8).toUpperCase();
}
