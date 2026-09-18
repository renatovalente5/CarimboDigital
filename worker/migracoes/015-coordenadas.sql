-- --------------------------------------------------------------------------
-- 015 — onde fica cada estabelecimento (18 set 2026)
--
--   npx wrangler d1 execute carimbodigital --remote --config ./wrangler.toml \
--     --file=migracoes/015-coordenadas.sql
--
-- O «Descobrir» era uma lista de nomes com uma localidade ao lado. Para quem
-- abre a app numa cidade que não conhece, «Ovar» não responde à pergunta que
-- se está mesmo a fazer, que é «isto é aqui ao pé?». Estas colunas são o que
-- permite pôr os estabelecimentos num mapa.
--
-- O MAPA É DESENHADO DENTRO DA APP, a partir das fronteiras dos 308 concelhos
-- guardadas no próprio site. Não se vai buscar imagem nenhuma a servidor
-- nenhum — é isso que deixa a página de privacidade continuar a dizer, à
-- letra, que «não carrega tipos de letra, mapas ou scripts de terceiros», e a
-- não haver aviso de cookies nenhum para mostrar.
--
-- DE ONDE VEM A COORDENADA, e porque é que não há geocodificador:
--
--   O balcão é usado AO BALCÃO. É a razão de ele existir. Quem o abre para
--   criar o negócio está fisicamente dentro do estabelecimento, com um
--   telemóvel que sabe onde está com cinco a dez metros de erro. Um botão
--   «Estou no estabelecimento» dá precisão ao nível da porta.
--
--   Perguntar a morada a um geocodificador dá pior: para a barbearia que já
--   está nesta base, o Nominatim e o Photon devolvem os dois o CENTRO DA RUA,
--   a oitenta metros, porque o número de porta não está no OpenStreetMap e
--   nunca vai estar. E acrescentava um domínio de terceiro à política de
--   privacidade para dar um resultado pior do que o telemóvel que já está na
--   mão de quem preenche o formulário.
-- --------------------------------------------------------------------------

-- Em graus decimais, WGS84 (EPSG:4326) — as mesmas que qualquer telemóvel dá.
-- Arredondadas a CINCO casas quando se gravam: a 40° de latitude, a quinta
-- casa vale 1,11 m. O GPS devolve mais casas do que sabe, e guardá-las é
-- guardar uma mentira com ar de medição.
ALTER TABLE negocios ADD COLUMN latitude REAL;
ALTER TABLE negocios ADD COLUMN longitude REAL;

-- 'gps' | 'mao' | 'concelho' — e não é um enfeite de auditoria.
--
-- É o que o mapa tem de poder desenhar DIFERENTE. Um ponto ao metro e o
-- centróide de um concelho inteiro não são a mesma promessa, e mostrá-los com
-- o mesmo alfinete é dizer a alguém «é aqui» quando o que se sabe é «é algures
-- neste concelho». O centróide, aliás, é uma fonte pior do que parece: o do
-- concelho do Funchal cai no mar, a 31,7 N, porque as Ilhas Selvagens
-- pertencem ao Funchal e puxam o centro de massa 100 km para sul.
ALTER TABLE negocios ADD COLUMN geo_fonte TEXT;

-- Quando é que esta coordenada foi posta. É o que permite, daqui a dois anos,
-- voltar aos que ficaram em 'concelho' e pedir-lhes o ponto a sério.
ALTER TABLE negocios ADD COLUMN geo_em TEXT;

-- A MORADA EXACTA QUE GEROU ESTE PONTO, e esta é a coluna de que ninguém se
-- lembra. O `PUT /v1/balcao/negocio` grava a morada nova e não toca em mais
-- nada; no dia em que o dono corrige a morada — mudou de porta, mudou de rua —
-- a coordenada fica a apontar para a anterior. Calada, plausível, errada.
--
-- Com esta coluna o servidor compara e AVISA, em vez de apagar: o dono pode
-- ter corrigido uma gralha com o ponto já certo, e apagar-lhe o trabalho por
-- causa de um acento seria pior do que o problema. É a mesma família do
-- «ligar uma integração envelhece textos».
ALTER TABLE negocios ADD COLUMN geo_morada TEXT;

-- O «Descobrir» pede os negócios activos e não os pede por coordenada; não há
-- índice a criar. Quando houver negócios que cheguem para uma procura «perto
-- de mim» feita no servidor — e hoje não há — isso é outra migração, com um
-- índice pensado para a consulta que existir nessa altura.
