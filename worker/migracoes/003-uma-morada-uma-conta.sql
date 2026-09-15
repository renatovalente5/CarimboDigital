-- Uma morada, uma conta (15 set 2026).
--
--   npx wrangler d1 execute carimbodigital --remote --config ./wrangler.toml \
--     --file=migracoes/003-uma-morada-uma-conta.sql
--
-- Havia só um índice normal sobre `clientes(email)`, e nada impedia duas
-- contas de ficarem com a MESMA morada verificada. A recuperação faz
-- `WHERE email = ? AND email_verificado = 1 LIMIT 1`: com duas, escolhia uma
-- ao calhas e os cartões da outra deixavam de ter por onde ser alcançados.
--
-- Índices PARCIAIS, e é isso que os torna possíveis: uma morada não
-- verificada pode repetir-se à vontade (são tentativas, não contas), e um
-- operador desactivado também — o que não pode repetir-se é o que serve para
-- entrar.
--
-- Se algum destes falhar com «UNIQUE constraint failed», é porque a base JÁ
-- tem duplicados: há que os resolver à mão antes, escolhendo qual fica.
CREATE UNIQUE INDEX IF NOT EXISTS ix_clientes_email_unico
  ON clientes(email) WHERE email IS NOT NULL AND email_verificado = 1;

CREATE UNIQUE INDEX IF NOT EXISTS ix_operadores_email_unico
  ON operadores(email) WHERE email IS NOT NULL AND ativo = 1;
