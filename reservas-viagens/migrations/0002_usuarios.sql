-- Migration 0002 — Usuários do painel, sessões e auditoria
--
-- Modelo de acesso:
--   * MASTER   — um único usuário, com todas as permissões. É o único que cria, edita,
--                desativa usuários e concede permissões. Criado no primeiro login a partir
--                dos secrets MASTER_USUARIO / MASTER_SENHA (a senha nunca fica no código).
--   * OPERADOR — usuários da equipe; cada um recebe só as permissões marcadas pelo master.
--
-- Senhas: PBKDF2-SHA256 (100.000 iterações, salt aleatório de 16 bytes).
-- Sessões: o navegador guarda um token aleatório; o banco guarda só o SHA-256 dele.

CREATE TABLE IF NOT EXISTS usuarios (
  id                 TEXT    PRIMARY KEY,
  usuario            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  nome               TEXT    NOT NULL,
  papel              TEXT    NOT NULL CHECK (papel IN ('MASTER', 'OPERADOR')),
  permissoes_json    TEXT    NOT NULL DEFAULT '[]',
  senha_hash         TEXT    NOT NULL,
  senha_salt         TEXT    NOT NULL,
  senha_iteracoes    INTEGER NOT NULL,
  trocar_senha       INTEGER NOT NULL DEFAULT 0 CHECK (trocar_senha IN (0, 1)),
  ativo              INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
  tentativas_falhas  INTEGER NOT NULL DEFAULT 0,
  bloqueado_ate      TEXT,
  ultimo_login_em    TEXT,
  criado_por         TEXT,
  criado_em          TEXT    NOT NULL,
  atualizado_em      TEXT    NOT NULL
);

-- Garante um único MASTER.
CREATE UNIQUE INDEX IF NOT EXISTS idx_um_master ON usuarios (papel) WHERE papel = 'MASTER';

CREATE TABLE IF NOT EXISTS sessoes (
  token_hash  TEXT PRIMARY KEY,
  usuario_id  TEXT NOT NULL REFERENCES usuarios(id),
  criado_em   TEXT NOT NULL,
  expira_em   TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessoes_usuario ON sessoes (usuario_id);
CREATE INDEX IF NOT EXISTS idx_sessoes_expira ON sessoes (expira_em);

CREATE TABLE IF NOT EXISTS auditoria (
  id          TEXT PRIMARY KEY,
  usuario_id  TEXT,
  usuario     TEXT,          -- login no momento da ação (preserva histórico)
  acao        TEXT NOT NULL,
  alvo        TEXT,
  detalhe     TEXT,          -- JSON sem dados pessoais
  ip          TEXT,
  criado_em   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auditoria_data ON auditoria (criado_em DESC);
