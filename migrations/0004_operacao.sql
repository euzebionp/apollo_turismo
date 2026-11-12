-- Migration 0004 — Operação da viagem (inspirada nos fluxos de excursão rodoviária)
--
-- * Situação da viagem: RASCUNHO → PUBLICADA → CONCLUIDA (ou CANCELADA).
--   "ativa" continua existindo e significa "vendas abertas" dentro de uma viagem publicada.
-- * Mapa de poltronas (layout_json) e escolha da poltrona na reserva, com poltrona única garantida
--   por índice (duas reservas ativas nunca ficam com a mesma poltrona).
-- * Pontos de embarque com horário; a reserva guarda o ponto escolhido.
-- * Inclusos, política de cancelamento (guardada em cada reserva), grupo do WhatsApp, motorista e veículo.
-- * Pagamento do saldo por Pix e pagamentos registrados à mão (tabela pagamentos).
-- * Pedido de desistência feito pelo passageiro na página da reserva.
-- * Fila de mensagens do WhatsApp (o que já foi aberto) e despesas da viagem (financeiro).
-- Nada é apagado: viagens e reservas antigas continuam funcionando sem poltrona e sem pontos.

-- ---------------------------------------------------------------- viagens
ALTER TABLE viagens ADD COLUMN situacao TEXT NOT NULL DEFAULT 'PUBLICADA'
  CHECK (situacao IN ('RASCUNHO', 'PUBLICADA', 'CONCLUIDA', 'CANCELADA'));
ALTER TABLE viagens ADD COLUMN layout_json          TEXT;   -- {"tipo":"2-2","poltronas":46,"bloqueadas":[45,46]} ou NULL (sem mapa)
ALTER TABLE viagens ADD COLUMN pontos_embarque_json TEXT NOT NULL DEFAULT '[]'; -- [{id, nome, endereco, horario(ISO)}]
ALTER TABLE viagens ADD COLUMN inclusos_json        TEXT NOT NULL DEFAULT '[]'; -- ["Transporte", "Hospedagem", ...]
ALTER TABLE viagens ADD COLUMN politica_cancelamento TEXT;
ALTER TABLE viagens ADD COLUMN grupo_whatsapp       TEXT;   -- só aparece para quem já pagou
ALTER TABLE viagens ADD COLUMN motorista_nome       TEXT;   -- aparece ao passageiro a partir de 2 dias antes
ALTER TABLE viagens ADD COLUMN motorista_whatsapp   TEXT;   -- fica só com a agência
ALTER TABLE viagens ADD COLUMN veiculo_descricao    TEXT;   -- empresa / modelo / placa (vai na lista impressa)
ALTER TABLE viagens ADD COLUMN motivo_cancelamento  TEXT;

-- ---------------------------------------------------------------- reservas
ALTER TABLE reservas ADD COLUMN poltrona            INTEGER;
ALTER TABLE reservas ADD COLUMN ponto_embarque_id   TEXT;
ALTER TABLE reservas ADD COLUMN ponto_embarque_nome TEXT;   -- cópia do nome no momento da reserva
ALTER TABLE reservas ADD COLUMN valor_total_centavos INTEGER; -- preço integral no momento da reserva (base do saldo)
ALTER TABLE reservas ADD COLUMN politica_aceita     TEXT;   -- texto da política que o passageiro aceitou
ALTER TABLE reservas ADD COLUMN desistencia_em      TEXT;
ALTER TABLE reservas ADD COLUMN desistencia_motivo  TEXT;

-- Reservas antigas: o total é o preço integral atual da viagem.
UPDATE reservas SET valor_total_centavos = (SELECT preco_integral_centavos FROM viagens v WHERE v.id = reservas.viagem_id)
 WHERE valor_total_centavos IS NULL;

-- Poltrona única entre as reservas que seguram lugar.
CREATE UNIQUE INDEX IF NOT EXISTS idx_poltrona_ativa
  ON reservas (viagem_id, poltrona) WHERE poltrona IS NOT NULL AND status IN ('PENDENTE', 'CONFIRMADO');

-- ---------------------------------------------------------------- pagamentos
ALTER TABLE pagamentos ADD COLUMN tipo TEXT NOT NULL DEFAULT 'RESERVA' CHECK (tipo IN ('RESERVA', 'SALDO', 'MANUAL'));
ALTER TABLE pagamentos ADD COLUMN pix_copia_cola TEXT;
ALTER TABLE pagamentos ADD COLUMN pix_qr_base64  TEXT;
ALTER TABLE pagamentos ADD COLUMN pix_qr_mime    TEXT;
ALTER TABLE pagamentos ADD COLUMN expira_em      TEXT;   -- só para Pix de saldo
ALTER TABLE pagamentos ADD COLUMN recebido_em    TEXT;   -- data informada nos pagamentos à mão
ALTER TABLE pagamentos ADD COLUMN registrado_por TEXT;   -- usuário do painel (pagamentos à mão)

CREATE INDEX IF NOT EXISTS idx_pagamentos_reserva ON pagamentos (reserva_id, status_interno);
CREATE INDEX IF NOT EXISTS idx_pagamentos_saldo_aguardando ON pagamentos (expira_em) WHERE tipo = 'SALDO' AND status_interno = 'AGUARDANDO';

-- ---------------------------------------------------------------- mensagens do WhatsApp (fila manual)
-- Marca quais passageiros já tiveram a conversa aberta para cada tipo de mensagem.
CREATE TABLE IF NOT EXISTS mensagens_abertas (
  reserva_id  TEXT NOT NULL REFERENCES reservas(id),
  tipo        TEXT NOT NULL CHECK (tipo IN ('LINK', 'LEMBRETE', 'MUDANCA', 'COBRANCA')),
  aberta_em   TEXT NOT NULL,
  usuario_id  TEXT,
  PRIMARY KEY (reserva_id, tipo)
);

-- ---------------------------------------------------------------- despesas da viagem
CREATE TABLE IF NOT EXISTS despesas (
  id             TEXT    PRIMARY KEY,
  viagem_id      TEXT    NOT NULL REFERENCES viagens(id),
  categoria      TEXT    NOT NULL CHECK (categoria IN ('FRETAMENTO', 'HOSPEDAGEM', 'ALIMENTACAO', 'PASSEIOS', 'GUIA', 'SEGURO', 'TAXAS', 'OUTROS')),
  descricao      TEXT    NOT NULL,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  data           TEXT,
  criado_por     TEXT,
  criado_em      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_despesas_viagem ON despesas (viagem_id);
