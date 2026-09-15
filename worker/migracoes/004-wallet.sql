-- Wallet e logótipos (15 set 2026).
--
--   npx wrangler d1 execute carimbodigital --remote --config ./wrangler.toml \
--     --file=migracoes/004-wallet.sql
--
-- Aditiva: o Worker a correr ignora tudo isto. Aplica-se ANTES de publicar o
-- código que a usa. É a 004 — a pasta já tem 001-contas-paradas,
-- 002-convites e 003-uma-morada-uma-conta.

-- O LOGÓTIPO. A coluna `negocios.logotipo` existe no esquema desde o primeiro
-- dia e nunca ninguém lhe tocou. Passa a guardar o PNG em base64, e a Google
-- exige um `programLogo` por classe: sem ele não há passe nenhum.
-- O `logotipo_em` serve para a cache: o endereço é estável e o conteúdo muda.
ALTER TABLE negocios ADD COLUMN logotipo_em TEXT;

-- O PASSE NA WALLET, por cartão.
--   wallet_codigo       — o código permanente que vai no código de barras do
--                         passe. NÃO é o `publico` do cliente: com um token
--                         próprio, um passe fotografado revoga-se sozinho sem
--                         mexer no número do cartão da pessoa.
--   wallet_em           — quando o passe foi criado. NULL = não tem passe.
--   wallet_sincronizado — a última vez que o saldo lá fora foi actualizado.
--                         É a diferença para o `ultimo_em` que diz ao
--                         reconciliador nocturno o que ficou por enviar.
ALTER TABLE cartoes ADD COLUMN wallet_codigo TEXT;
ALTER TABLE cartoes ADD COLUMN wallet_em TEXT;
ALTER TABLE cartoes ADD COLUMN wallet_sincronizado TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ix_cartoes_wallet_codigo
  ON cartoes(wallet_codigo) WHERE wallet_codigo IS NOT NULL;
-- O reconciliador pergunta por cartões com passe e por sincronizar.
CREATE INDEX IF NOT EXISTS ix_cartoes_wallet ON cartoes(wallet_em, wallet_sincronizado);

-- A CLASSE NA GOOGLE, por PROGRAMA e não por negócio: um negócio pode ter
-- vários cartões, e o nome e o objectivo são do programa, não da casa.
ALTER TABLE programas ADD COLUMN wallet_classe TEXT;
