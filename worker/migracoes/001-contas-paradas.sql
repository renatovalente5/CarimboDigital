-- Contas paradas (11 set 2026).
--
-- Aplica-se a uma base que já existe:
--   npx wrangler d1 execute carimbodigital --remote --config ./wrangler.toml \
--     --file=migracoes/001-contas-paradas.sql
--
-- O `esquema.sql` já traz as duas coisas; isto é para a base que foi criada
-- antes delas. Correr duas vezes não faz mal ao índice, mas faz à coluna — o
-- SQLite não tem ADD COLUMN IF NOT EXISTS e dá «duplicate column name».
ALTER TABLE clientes ADD COLUMN avisada_em TEXT;
CREATE INDEX IF NOT EXISTS ix_clientes_visto ON clientes(visto_em);
