-- =========================================================================
-- 019 — a morada exacta sai, porque a finalidade dela saiu primeiro
--
-- A latitude e a longitude de cada estabelecimento existiam para UMA coisa, e
-- estava escrita na página de privacidade: «Guardamos também onde fica o
-- estabelecimento — a latitude e a longitude — para ele aparecer no mapa do
-- “Descobrir”», com a frase «esse ponto é público» ao lado.
--
-- O ecrã «Descobrir» saiu da app do cliente. Não há página pública que mostre
-- um ponto, a lista pública deixou de os devolver, e o balcão deixou de os
-- pedir. O que sobrava era uma morada exacta guardada para um fim que já não
-- existe — e isso é o artigo 5.º, n.º 1, al. b) do RGPD: os dados são
-- recolhidos para finalidades determinadas, e não podem ser tratados de forma
-- incompatível com elas. Uma finalidade que desaparece não se substitui por
-- «pode dar jeito um dia»: isso não é uma finalidade, é a falta de uma.
--
-- POR ISSO NÃO CHEGA PARAR DE RECOLHER. O que já está guardado tem de sair, e
-- é isso que esta migração faz. O código deixou de escrever lá (ver o
-- comentário na rota `PUT /v1/balcao/negocio`); isto limpa o que ficou.
--
-- AS COLUNAS FICAM, E É DE PROPÓSITO. Uma coluna que ninguém escreve e
-- ninguém lê não faz mal a ninguém; apagá-las de uma base SQLite obriga a
-- reconstruir a tabela inteira, com as chaves estrangeiras e os índices todos
-- a passarem por cima de dados a sério. É muito mais risco do que valor, e o
-- que interessava — os dados — desaparece na mesma.
--
-- É IRREVERSÍVEL, e tem de ser: um apagar que deixasse cópia não era apagar.
-- =========================================================================

UPDATE negocios
   SET latitude   = NULL,
       longitude  = NULL,
       geo_fonte  = NULL,
       geo_em     = NULL,
       geo_morada = NULL
 WHERE latitude IS NOT NULL
    OR longitude IS NOT NULL
    OR geo_fonte IS NOT NULL
    OR geo_em IS NOT NULL
    OR geo_morada IS NOT NULL;
