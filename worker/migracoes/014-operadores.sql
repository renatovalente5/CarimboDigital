-- --------------------------------------------------------------------------
-- 014 — vários operadores por balcão (18 set 2026)
--
--   npx wrangler d1 execute carimbodigital --remote --config ./wrangler.toml \
--     --file=migracoes/014-operadores.sql
--
-- A TABELA JÁ AGUENTAVA ISTO desde o primeiro dia: `operadores` tem
-- `negocio_id`, tem `papel` (dono | balcao) e tem `ativo`. O que faltava era o
-- Worker deixar juntar um segundo e o balcão ter onde o fazer. Esta migração
-- acrescenta só o que a tabela não sabia ainda, que são duas coisas.
--
-- 1. DOIS NOMES IGUAIS NO MESMO BALCÃO NÃO SERVEM. O histórico de um cartão
--    guarda o NOME de quem carimbou, e não o identificador — de propósito,
--    para o histórico sobreviver a quem sai do café. Com dois «João» activos,
--    o dono abre o histórico e não fica a saber nada: é precisamente a
--    pergunta que ter vários operadores existe para responder. Recusa-se à
--    entrada, e diz-se porquê («João da tarde» resolve).
--
--    O índice é PARCIAL (`WHERE ativo = 1`): quem sai deixa o nome livre, e um
--    João que saiu não impede o João que entra. Para o índice ver o mesmo que
--    uma pessoa vê, o nome é comparado sem maiúsculas e sem espaços à volta —
--    «joão » e «João» são o mesmo nome escrito duas vezes.
--
-- 2. QUANDO É QUE ESTE OPERADOR ESTEVE CÁ PELA ÚLTIMA VEZ. Sem isto, a lista
--    do balcão mostra nomes e mais nada, e o dono não tem como saber que
--    aquele email é de alguém que saiu há seis meses. Escreve-se ao entrar.
-- --------------------------------------------------------------------------

-- Um nome por balcão, entre os activos.
CREATE UNIQUE INDEX IF NOT EXISTS ix_operadores_nome_unico
  ON operadores(negocio_id, lower(trim(nome))) WHERE ativo = 1;

-- Quando entrou pela última vez. NULL = convidado e ainda não entrou, que é um
-- estado que o balcão mostra («ainda não entrou»): é a diferença entre um
-- convite por usar e um colega que já cá esteve.
ALTER TABLE operadores ADD COLUMN visto_em TEXT;
