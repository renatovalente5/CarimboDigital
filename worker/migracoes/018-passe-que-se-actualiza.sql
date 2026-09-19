-- =========================================================================
-- O passe da Apple passa a actualizar-se sozinho
--
-- Até aqui o passe era um RETRATO: os carimbos que lá estavam eram os do dia
-- em que a pessoa o guardou, e a única forma de o pôr em dia era voltar a
-- adicioná-lo. Quem abrisse a carteira e visse sete carimbos tendo oito não
-- concluía «falta aqui um servidor de push» — concluía que o café não lhe
-- tinha dado o carimbo.
--
-- O que a Apple obriga a ter para isto mudar é um PassKit Web Service: cinco
-- rotas que o iPhone chama sozinho, e uma notificação da APNs a dizer-lhe que
-- vá ver. Estas tabelas são o estado desse protocolo.
--
-- O QUE NÃO ESTÁ AQUI, DE PROPÓSITO: uma tabela de testemunhos. O
-- `authenticationToken` de cada passe deriva-se por HMAC do número de série,
-- e por isso é sempre o mesmo sem se guardar em lado nenhum. A Apple diz
-- explicitamente para NÃO mudar esse testemunho numa actualização: mudá-lo
-- parte todos os passes que já estão na rua. Uma coluna que se pode escrever
-- é uma coluna que um dia alguém escreve.
-- =========================================================================

-- Os aparelhos que pediram para ser avisados.
--
-- O `device_library_identifier` é inventado pelo próprio iPhone e é OPACO
-- para nós — a Apple diz que não tem relação nenhuma com o identificador do
-- aparelho (não é o UDID). Ele é, ao mesmo tempo, a chave e o segredo: a rota
-- que lista os passes alterados não leva testemunho nenhum, e o que a protege
-- é só quem sabe este identificador.
--
-- Um aparelho tem UM testemunho de push, e ele muda: quando muda, o iPhone
-- volta a registar-se com o mesmo identificador, e por isso o INSERT é um
-- upsert em vez de um erro.
CREATE TABLE IF NOT EXISTS wallet_aparelhos (
  aparelho    TEXT PRIMARY KEY,   -- deviceLibraryIdentifier
  testemunho  TEXT NOT NULL,      -- pushToken, em hexadecimal
  visto_em    TEXT NOT NULL
);

-- Que aparelho quer saber de que passe.
--
-- É uma relação de muitos para muitos, e não uma coluna no cartão: a mesma
-- pessoa tem o cartão no iPhone, no iPad e no Watch do pai, e todos eles se
-- registam para o mesmo número de série. Uma coluna guardava o último e os
-- outros ficavam calados.
--
-- O `serial` é o id do cartão, que é o que o `pkpass.js` escreve no
-- `serialNumber` do passe.
CREATE TABLE IF NOT EXISTS wallet_registos (
  aparelho    TEXT NOT NULL REFERENCES wallet_aparelhos(aparelho) ON DELETE CASCADE,
  serial      TEXT NOT NULL,
  criado_em   TEXT NOT NULL,
  PRIMARY KEY (aparelho, serial)
);

-- Pelo caminho ao contrário: dado um cartão que mudou, que aparelhos avisar.
-- Sem este índice, cada carimbo varria a tabela inteira.
CREATE INDEX IF NOT EXISTS ix_wallet_registos_serial ON wallet_registos(serial);

-- =========================================================================
-- A ETIQUETA DO TEMPO, EM SEGUNDOS INTEIROS
--
-- O protocolo tem duas comparações de tempo e as duas passam por HTTP:
-- o `passesUpdatedSince` na lista, e o `If-Modified-Since` na entrega do
-- passe. As datas de HTTP têm resolução de UM SEGUNDO.
--
-- Guardar isto em milissegundos — ou em ISO com milésimos, como todo o resto
-- desta base — dava 304 errados para duas alterações dentro do mesmo segundo:
-- o `Date.parse` do cabeçalho vem truncado, e um `actualizado > recebido` com
-- 300 ms de diferença compara 1758290000.300 com 1758290000.000 e diz que
-- mudou quando não mudou, ou o contrário conforme o arredondamento.
--
-- Segundos inteiros, portanto. É a única coluna de tempo desta base que não é
-- ISO, e é de propósito: ela existe para casar com um formato de fora.
-- =========================================================================
ALTER TABLE cartoes ADD COLUMN apple_actualizado INTEGER;

-- SE O PASSE QUE ESTÁ NO TELEMÓVEL SABE VOLTAR A FALAR CONNOSCO.
--
-- O `webServiceURL` e o `authenticationToken` vão ASSINADOS dentro do
-- ficheiro .pkpass. Um passe emitido antes de isto existir não os tem, e nada
-- do que se faça no servidor o muda: ele fica congelado no telemóvel para
-- sempre, e nós não temos como saber que ele existe.
--
-- Esta coluna é a diferença entre os dois mundos. Serve para a app poder
-- dizer a quem tem um passe velho «guarda-o outra vez, uma vez só, e nunca
-- mais precisas» — em vez de prometer a toda a gente uma actualização
-- automática que para metade dos cartões é mentira.
--
-- Fica a NULL nos passes antigos, que é exactamente o que eles são: um
-- passe sobre o qual não sabemos nada.
ALTER TABLE cartoes ADD COLUMN apple_servico TEXT;

-- Os cartões cujo passe mudou e cujos aparelhos ainda não foram avisados.
--
-- O AVISO NÃO PODE SAIR NO PEDIDO DO BALCÃO. Uma invocação de Worker tem
-- tecto de CINQUENTA subpedidos, e um push é um subpedido por aparelho: uma
-- família com iPhones, iPads e relógios estoira o tecto num carimbo só, e o
-- que rebenta é o carimbo — a coisa que o cliente está ali a fazer.
--
-- Por isso o carimbo só marca, e quem manda é o cron. Custa até um minuto de
-- atraso no toque, e ganha um carimbo que nunca falha por causa de uma coisa
-- que o cliente nem sabe que existe.
CREATE TABLE IF NOT EXISTS wallet_por_avisar (
  serial      TEXT PRIMARY KEY,
  marcado_em  TEXT NOT NULL
);

-- =========================================================================
-- O BILHETE DA APNs
--
-- A APNs autentica-se com um JWT ES256 assinado com uma chave .p8. O bilhete
-- vale no máximo uma hora — e a Apple RECUSA quem o renove mais do que uma
-- vez em cada vinte minutos, com `TooManyProviderTokenUpdates`.
--
-- Um Worker não tem memória entre pedidos: assinar um bilhete novo em cada
-- push é o caminho por omissão, e é exactamente o que a Apple castiga. Por
-- isso o bilhete vive aqui, e reutiliza-se cinquenta minutos.
--
-- Uma linha só, com `id = 1`. Uma tabela de uma linha parece exagero até se
-- perceber que a alternativa num Worker é não haver sítio nenhum.
-- =========================================================================
CREATE TABLE IF NOT EXISTS apns_bilhete (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  jwt         TEXT NOT NULL,
  assinado_em INTEGER NOT NULL
);
