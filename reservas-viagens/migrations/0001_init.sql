-- Migration 0001 — Plataforma de Reservas Apollo Turismo
-- Convenções:
--   * Valores monetários em centavos (INTEGER) — evita erro de arredondamento do REAL.
--   * Datas em TEXT ISO-8601 UTC (ex.: 2026-11-09T23:15:00.000Z) — ordenáveis e comparáveis.
--   * CPF guardado como HMAC-SHA256 (cpf_hash, para busca/unicidade) + texto cifrado (AES-GCM).
--   * RG guardado cifrado (AES-GCM). Chaves ficam em secrets do Worker, nunca no banco.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- VIAGENS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS viagens (
  id                       TEXT    PRIMARY KEY,
  titulo                   TEXT    NOT NULL,
  destino                  TEXT    NOT NULL,
  descricao                TEXT,
  data_partida             TEXT    NOT NULL,              -- ISO-8601
  data_retorno             TEXT,                          -- ISO-8601
  local_embarque           TEXT,
  total_vagas              INTEGER NOT NULL CHECK (total_vagas > 0),
  preco_integral_centavos  INTEGER NOT NULL CHECK (preco_integral_centavos > 0),
  preco_sinal_centavos     INTEGER NOT NULL CHECK (preco_sinal_centavos > 0),
  programacao_json         TEXT    NOT NULL DEFAULT '[]', -- [{dia, titulo, itens:[{hora, atividade}]}]
  fotos_json               TEXT    NOT NULL DEFAULT '{}', -- {veiculo:[{url,legenda}], hospedagem:[...], destino:[...]}
  ativa                    INTEGER NOT NULL DEFAULT 1 CHECK (ativa IN (0, 1)),
  criado_em                TEXT    NOT NULL,
  CHECK (preco_sinal_centavos <= preco_integral_centavos)
);

-- ---------------------------------------------------------------------------
-- PASSAGEIROS (dados do manifesto ANTT/DER)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS passageiros (
  id                TEXT PRIMARY KEY,
  nome_completo     TEXT NOT NULL,
  cpf_hash          TEXT NOT NULL UNIQUE,  -- HMAC-SHA256(cpf) em hex
  cpf_cifrado       TEXT NOT NULL,         -- base64(iv || ciphertext)
  cpf_final         TEXT NOT NULL,         -- 2 últimos dígitos, só para exibição mascarada
  rg_cifrado        TEXT NOT NULL,
  orgao_emissor     TEXT NOT NULL,
  telefone          TEXT NOT NULL,         -- só dígitos, com DDD
  email             TEXT NOT NULL,         -- exigido pelo gateway para emitir o Pix
  consentimento_em  TEXT NOT NULL,         -- aceite LGPD
  criado_em         TEXT NOT NULL,
  atualizado_em     TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- RESERVAS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservas (
  id               TEXT    PRIMARY KEY,
  viagem_id        TEXT    NOT NULL REFERENCES viagens(id),
  passageiro_id    TEXT    NOT NULL REFERENCES passageiros(id),
  tipo_pagamento   TEXT    NOT NULL CHECK (tipo_pagamento IN ('SINAL', 'INTEGRAL')),
  valor_centavos   INTEGER NOT NULL CHECK (valor_centavos > 0),
  status           TEXT    NOT NULL DEFAULT 'PENDENTE'
                   CHECK (status IN ('PENDENTE', 'CONFIRMADO', 'EXPIRADO', 'CANCELADO')),
  pix_txid         TEXT    UNIQUE,         -- id do pagamento no gateway
  pix_copia_cola   TEXT,
  pix_qr_base64    TEXT,
  pix_qr_mime      TEXT,
  expira_em        TEXT    NOT NULL,       -- criado_em + 15 min
  confirmado_em    TEXT,
  criado_em        TEXT    NOT NULL
);

-- Contagem de vagas em tempo real (confirmadas + pendentes ainda válidas).
CREATE INDEX IF NOT EXISTS idx_reservas_ocupacao
  ON reservas (viagem_id, status, expira_em);

-- Cron de expiração.
CREATE INDEX IF NOT EXISTS idx_reservas_pendentes
  ON reservas (status, expira_em) WHERE status = 'PENDENTE';

-- Um mesmo passageiro não segura duas vagas ativas na mesma viagem.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reserva_ativa_por_passageiro
  ON reservas (viagem_id, passageiro_id) WHERE status IN ('PENDENTE', 'CONFIRMADO');

-- ---------------------------------------------------------------------------
-- PAGAMENTOS (conciliação, pagamento tardio, estorno)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pagamentos (
  id                  TEXT    PRIMARY KEY,
  reserva_id          TEXT    NOT NULL REFERENCES reservas(id),
  gateway             TEXT    NOT NULL,    -- mercadopago | asaas | simulado
  gateway_payment_id  TEXT    NOT NULL UNIQUE,
  status_gateway      TEXT    NOT NULL,
  status_interno      TEXT    NOT NULL DEFAULT 'AGUARDANDO'
                      CHECK (status_interno IN ('AGUARDANDO', 'APROVADO', 'ESTORNAR', 'ESTORNADO', 'DIVERGENTE', 'CANCELADO')),
  valor_centavos      INTEGER NOT NULL,
  observacao          TEXT,
  criado_em           TEXT    NOT NULL,
  atualizado_em       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pagamentos_status ON pagamentos (status_interno);

-- ---------------------------------------------------------------------------
-- WEBHOOK_EVENTOS (idempotência — o gateway reenvia notificações)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_eventos (
  id           TEXT PRIMARY KEY,           -- "<gateway>:<id do evento>"
  recebido_em  TEXT NOT NULL
);
