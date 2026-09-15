-- Convites (15 set 2026).
--
--   npx wrangler d1 execute carimbodigital --remote --config ./wrangler.toml \
--     --file=migracoes/002-convites.sql
--
-- Aditiva de ponta a ponta: o Worker que está a correr ignora a tabela e a
-- coluna novas, por isso esta migração aplica-se ANTES de publicar o código
-- que as usa, e não depois. Correr duas vezes não faz mal à tabela nem ao
-- índice, mas faz à coluna — o SQLite não tem ADD COLUMN IF NOT EXISTS.
--
-- O código em claro NUNCA entra aqui. Guarda-se o resumo SHA-256, tal como as
-- sessões: uma cópia desta base não dá um convite a ninguém.
CREATE TABLE IF NOT EXISTS convites (
  resumo       TEXT PRIMARY KEY,
  etiqueta     TEXT,                              -- para quem é, em português
  email        TEXT,                              -- NULL = qualquer morada o pode gastar
  usos_max     INTEGER NOT NULL DEFAULT 1,
  usos         INTEGER NOT NULL DEFAULT 0,
  criado_em    TEXT NOT NULL,
  expira_em    TEXT,                              -- NULL = não expira
  revogado_em  TEXT,
  usado_em     TEXT                               -- a última vez que foi gasto
);

-- De que convite nasceu cada negócio. Uma coluna em vez de uma tabela de
-- registos: assim o rasto vale tanto para um convite de um uso como para um
-- de dez, e não há uma segunda tabela a crescer.
ALTER TABLE negocios ADD COLUMN convite TEXT;
CREATE INDEX IF NOT EXISTS ix_negocios_convite ON negocios(convite);
