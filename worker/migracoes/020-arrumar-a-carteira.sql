-- =========================================================================
-- Arrumar a carteira: uma ordem que é da pessoa, e um arquivo
--
-- Até aqui a ordem do baralho era decidida no servidor e era a mesma para
-- toda a gente: primeiro os cartões com prémio por levantar, depois os de
-- actividade mais recente (worker/src/index.js, GET /v1/cliente/cartoes).
-- Boa regra, mas ninguém lhe podia tocar — e uma carteira enche-se de sítios
-- onde já não se vai, sem outra saída senão «Deixar de usar este cartão»,
-- que apaga os carimbos e o histórico.
--
-- A ORDEM NÃO É UMA COLUNA DE `cartoes`, E A RAZÃO ESTÁ NO FICHEIRO. Não
-- existe UM `ORDER BY` sobre `cartoes` em todo o worker/src/index.js: as 42
-- consultas são `SELECT ... FROM cartoes WHERE cliente_id = ?` e quem ordena
-- é o JavaScript. Uma coluna `ordem` não serviria consulta nenhuma, e o
-- índice que ela pediria custava uma linha escrita a cada adesão, para
-- sempre. Pior: arrastar um cartão numa carteira de oito renumerava oito
-- linhas, quando aqui uma chega.
--
-- E resolve uma armadilha que esta casa já pagou. Com `ordem INTEGER`, um
-- cartão novo nasce a NULL e `null - 4` dá -4 em JavaScript: ele saltava para
-- primeiro por acidente aritmético (ver a memória «Zero não é "não foi
-- dito"»). Com uma lista de ids, «não está na lista» é binário — não há sinal
-- nenhum para interpretar mal, e a carteira de quem nunca arrumou nada sai
-- pelo MESMO ramo de código de hoje: lista vazia, ordenação de sempre.
--
-- O `arquivado_em` É de `cartoes`, esse sim: é um facto sobre aquele cartão e
-- não sobre a arrumação da pessoa. Arquivar é só tirar da vista — os carimbos
-- ficam, o cartão continua a receber carimbos, e o café continua a ver a
-- pessoa na lista dele. É o contrário de «Deixar de usar este cartão», e a
-- app tem de dizer isso em voz alta, senão são dois botões que parecem o
-- mesmo e um deles é irreversível.
--
-- SÓ AQUI E NÃO NO esquema.sql, que é o precedente da 018: o `apple_servico`
-- veio por migração e dá zero ocorrências no esquema. Uma base nova corre o
-- esquema E depois todas as migrações por ordem, e o `conferirBase()` do
-- com-worker.mjs lê os `ALTER TABLE ... ADD COLUMN` daqui para saber o que
-- exigir. Escrever nos dois sítios é duplicar a verdade e esperar que
-- divirjam.
-- =========================================================================

-- A ordem escolhida pela pessoa: array JSON de ids de cartão, os que ela
-- colocou. NULL ou ausente = nunca arrumou nada.
ALTER TABLE clientes ADD COLUMN ordem_cartoes TEXT;

-- Quando é que ela arrumou pela última vez. Não serve para ordenar: serve
-- para saber, quando um dia isto der para o torto, se a lista é de ontem ou
-- de há um ano.
ALTER TABLE clientes ADD COLUMN ordem_em TEXT;

-- NULL = está no baralho. Com data = foi arrumado para fora da vista.
ALTER TABLE cartoes ADD COLUMN arquivado_em TEXT;
