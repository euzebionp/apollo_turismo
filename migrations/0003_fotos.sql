-- Migration 0003 — Fotos enviadas pelo painel.
-- As imagens chegam já reduzidas pelo navegador (máx. 1920 px, ~200–400 KB) e ficam aqui
-- enquanto o R2 não estiver ativado. Se o binding FOTOS (R2) existir, o Worker grava lá
-- e esta tabela guarda só os metadados (dados = NULL).
CREATE TABLE IF NOT EXISTS fotos (
  id           TEXT    PRIMARY KEY,      -- 32 hex; a URL pública é /fotos/<id>.<ext>
  mime         TEXT    NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  tamanho      INTEGER NOT NULL,
  dados        BLOB,                     -- NULL quando armazenada no R2
  armazenamento TEXT   NOT NULL DEFAULT 'd1' CHECK (armazenamento IN ('d1', 'r2')),
  nome_original TEXT,
  enviado_por  TEXT,
  criado_em    TEXT    NOT NULL
);
