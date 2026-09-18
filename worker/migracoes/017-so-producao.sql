-- --------------------------------------------------------------------------
-- 017 — só produção (18 set 2026)
--
--   npx wrangler d1 execute carimbodigital --remote --config ./wrangler.toml \
--     --file=migracoes/017-so-producao.sql
--
-- ISTO NÃO MUDA O ESQUEMA: LIMPA DADOS. E limpa uma coisa em concreto — o
-- banco de provas que vivia dentro da base a sério.
--
-- O «Café Maravilha» nunca existiu. Era uma loja inventada, com clientes
-- inventados e carimbos com datas escritas à mão, criada para se poder ver o
-- produto cheio antes de haver um cliente cheio. Ficou marcada com
-- `demonstracao = 1`, o que a tirava da lista do «Descobrir» — e era tudo o
-- que se tinha feito quanto a isso.
--
-- O PROBLEMA NÃO ERA ELA APARECER: ERA ELA EXISTIR. Com duas lojas na base,
-- uma a sério e uma de mentira, e o mesmo balcão a poder abrir qualquer uma
-- delas, «estou no balcão errado» passou de erro improvável a erro provável —
-- e um carimbo dado no balcão errado não dá erro nenhum: dá um carimbo, no
-- cartão errado, e ninguém repara. Quem o descobriu foi o dono do produto, a
-- tentar carimbar e a não perceber porquê.
--
-- Por isso, daqui para a frente, o que está aqui dentro é o que é verdade.
-- Para experimentar existe a demonstração, que corre inteira dentro do
-- browser e não toca neste servidor.
--
-- Nada disto tem volta. Foi lido antes de ser escrito: as contagens estão no
-- fim do ficheiro, e conferem com o que a base tinha em 18 de setembro.
-- --------------------------------------------------------------------------

-- --- o que é do Café Maravilha --------------------------------------------
-- Apaga-se pela ordem das dependências, e à mão. As chaves estrangeiras estão
-- declaradas com `ON DELETE CASCADE`, mas o SQLite só as cumpre com
-- `PRAGMA foreign_keys = ON` — e uma migração que dependa de um PRAGMA que
-- não controla é uma migração que um dia apaga metade.

DELETE FROM premios WHERE cartao_id IN (
  SELECT c.id FROM cartoes c JOIN programas p ON p.id = c.programa_id
  WHERE p.negocio_id = '6e63d87d58cf771303693f5fa782b2fd');

DELETE FROM movimentos WHERE cartao_id IN (
  SELECT c.id FROM cartoes c JOIN programas p ON p.id = c.programa_id
  WHERE p.negocio_id = '6e63d87d58cf771303693f5fa782b2fd');

DELETE FROM cartoes WHERE programa_id IN (
  SELECT id FROM programas WHERE negocio_id = '6e63d87d58cf771303693f5fa782b2fd');

DELETE FROM marcos WHERE programa_id IN (
  SELECT id FROM programas WHERE negocio_id = '6e63d87d58cf771303693f5fa782b2fd');

DELETE FROM amigos WHERE programa_id IN (
  SELECT id FROM programas WHERE negocio_id = '6e63d87d58cf771303693f5fa782b2fd');

DELETE FROM programas WHERE negocio_id = '6e63d87d58cf771303693f5fa782b2fd';

-- A sessão do balcão dele. Sem isto, o separador que ficou aberto continua a
-- apresentar-se como operador de um negócio que já não existe — e o que se vê
-- é um 500, não uma explicação.
DELETE FROM sessoes WHERE sujeito IN (
  SELECT 'operador:' || id FROM operadores
  WHERE negocio_id = '6e63d87d58cf771303693f5fa782b2fd');

DELETE FROM operadores WHERE negocio_id = '6e63d87d58cf771303693f5fa782b2fd';

DELETE FROM negocios WHERE id = '6e63d87d58cf771303693f5fa782b2fd';

-- O convite que o fundou volta ao bolso. Um convite marcado como gasto por um
-- negócio que já não existe é uma linha que mente, e são essas que dão
-- trabalho daqui a um ano.
UPDATE convites SET usos = 0, usado_em = NULL
 WHERE resumo = '31cb4f1af2a10a0d0a955a504f05f7525761a5cc2abb248ae34b8fa255f0383a';

-- --- e as contas que sobraram das provas -----------------------------------
-- Vinte e seis contas anónimas: as doze que o Café Maravilha inventou e as
-- catorze que as baterias e as capturas criaram ao correrem contra produção —
-- todas com `criado_em` igual a `visto_em`, ou seja, registaram-se e nunca
-- mais voltaram.
--
-- A REGRA É ESTREITA DE PROPÓSITO: só se apaga quem ficou sem UM ÚNICO cartão
-- e sem UMA ÚNICA identidade. Quem tem identidade entrou por email, Google ou
-- Apple — é uma pessoa. Quem tem cartão tem carimbos de alguém, e carimbos de
-- alguém não se deitam fora por arrumação. É por isso que a conta anónima com
-- o cartão da barbearia fica: pode ser de um cliente que leu o cartaz.
-- A condição repete-se em cada linha em vez de viver numa tabela temporária:
-- uma TEMP TABLE vive na ligação, e aqui não há ligação nenhuma que se
-- controle — cada instrução pode aterrar noutro lado. Repetir é feio e é
-- seguro, e a condição não se mexe entre instruções: nenhuma delas toca em
-- `cartoes` nem em `identidades`, que é do que ela depende.
DELETE FROM sessoes WHERE sujeito IN (
  SELECT 'cliente:' || c.id FROM clientes c
   WHERE NOT EXISTS (SELECT 1 FROM cartoes t     WHERE t.cliente_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM identidades i WHERE i.cliente_id = c.id));

DELETE FROM subscricoes WHERE cliente_id IN (
  SELECT c.id FROM clientes c
   WHERE NOT EXISTS (SELECT 1 FROM cartoes t     WHERE t.cliente_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM identidades i WHERE i.cliente_id = c.id));

DELETE FROM amigos WHERE convidador IN (
  SELECT c.id FROM clientes c
   WHERE NOT EXISTS (SELECT 1 FROM cartoes t     WHERE t.cliente_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM identidades i WHERE i.cliente_id = c.id))
   OR convidado IN (
  SELECT c.id FROM clientes c
   WHERE NOT EXISTS (SELECT 1 FROM cartoes t     WHERE t.cliente_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM identidades i WHERE i.cliente_id = c.id));

DELETE FROM clientes WHERE id IN (
  SELECT c.id FROM clientes c
   WHERE NOT EXISTS (SELECT 1 FROM cartoes t     WHERE t.cliente_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM identidades i WHERE i.cliente_id = c.id));

-- --- as sessões que ficaram a apontar para ninguém --------------------------
-- Trinta e seis, e o produto não as fez: fui eu. Cada vez que apaguei uma
-- conta de prova com um `DELETE FROM clientes` escrito à mão, em vez do
-- caminho que a API usa, ficou cá a sessão dela.
--
-- Não davam erro: um bilhete que aponta para uma conta que não existe lê-se
-- como sessão inválida, e a app volta a registar-se. Mas são linhas que
-- mentem, e são as que dão trabalho quando alguém — eu, daqui a um ano —
-- contar sessões para perceber quantas pessoas há.
--
-- E não basta apagá-las aqui: a limpeza diária passou a varrê-las sozinha,
-- porque a próxima mão apressada vai fazer o mesmo. Ver o `scheduled`.
DELETE FROM sessoes
 WHERE sujeito LIKE 'cliente:%'
   AND NOT EXISTS (SELECT 1 FROM clientes c WHERE 'cliente:' || c.id = sessoes.sujeito);

DELETE FROM sessoes
 WHERE sujeito LIKE 'operador:%'
   AND NOT EXISTS (SELECT 1 FROM operadores o WHERE 'operador:' || o.id = sessoes.sujeito);

-- --- e o que sobra do correio ----------------------------------------------
-- `entradas` são códigos de seis dígitos e `codigos_usados` são janelas de
-- quinze segundos: os dois caducam sozinhos. O que se apaga aqui é só o que já
-- caducou, para a base não guardar moradas de email mais tempo do que precisa.
DELETE FROM entradas WHERE expira_em < '2026-09-18T00:00:00.000Z';
DELETE FROM envios   WHERE em        < '2026-09-11T00:00:00.000Z';

-- --------------------------------------------------------------------------
-- O que a base tinha antes (18 set 2026, lido):
--   negócios 2 (1 de demonstração) · programas 2 · cartões 15 · clientes 28
--   movimentos 75 · prémios 2 · operadores 2
-- E o que deve ter depois:
--   negócios 1 · programas 1 · cartões 2 · clientes 2 · operadores 1
-- --------------------------------------------------------------------------
