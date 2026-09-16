-- --------------------------------------------------------------------------
-- 010 — a conta que sai de uma fusão não se apaga (16 set 2026)
--
--   npx wrangler d1 execute carimbodigital --remote --config ./wrangler.toml \
--     --file=migracoes/010-contas-sombra.sql
--
-- Quando duas contas se juntam, uma delas deixa de ser destino. A tentação é
-- apagá-la — e apagá-la parte uma promessa que o produto faz em papel: **o
-- número de cartão foi dito em voz alta ao balcão, escrito num guardanapo e
-- fotografado**. Seis caracteres que alguém tem apontados não deixam de
-- existir só porque a pessoa entrou pela Google no telemóvel novo.
--
-- Por isso a conta fica como SOMBRA: sem cartões (foram todos reparenteados),
-- sem identidades (mudaram de dono), mas com o `publico` de sempre e um
-- ponteiro para quem a absorveu. Quem escrever o número antigo ao balcão
-- carimba na conta que sobreviveu.
--
--   fundida_em       — o id da conta que a absorveu. NULL = conta viva.
--   fundida_quando   — quando. Serve para caducar sombras muito velhas um dia.
--
-- O QUE A SOMBRA NÃO PODE FAZER é continuar a valer como credencial. O número
-- antigo entra por `M1.` (escrito à mão, sem assinatura) e resolve-se para a
-- conta que sobreviveu; um `C1.` antigo — o código do ecrã, assinado com o
-- segredo da sombra — tem de MORRER, senão a fusão deixava dois telemóveis a
-- carimbar a mesma conta e um deles não era de quem lá entrou. Isso cai
-- sozinho: a verificação passa a correr contra o segredo da conta que
-- sobreviveu, e a assinatura antiga nunca bate certo.
--
-- Nada cria sombras ainda — quem as cria é a fusão, na fase 3. O que esta
-- migração faz é pôr a coluna e o índice de pé para que o código que as
-- ATRAVESSA possa ser escrito e provado antes de haver uma única.
-- --------------------------------------------------------------------------

ALTER TABLE clientes ADD COLUMN fundida_em TEXT;
ALTER TABLE clientes ADD COLUMN fundida_quando TEXT;

-- Para a limpeza da madrugada saber quais são sombras sem percorrer a tabela
-- toda, e para se poderem achatar cadeias na fusão. PARCIAL: as contas vivas
-- são a esmagadora maioria e não têm nada que fazer neste índice.
CREATE INDEX IF NOT EXISTS ix_clientes_fundida
  ON clientes(fundida_em) WHERE fundida_em IS NOT NULL;
