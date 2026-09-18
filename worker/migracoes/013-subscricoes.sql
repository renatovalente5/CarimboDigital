-- --------------------------------------------------------------------------
-- 013 — as subscrições de notificação (18 set 2026)
--
--   npx wrangler d1 execute carimbodigital --remote --config ./wrangler.toml \
--     --file=migracoes/013-subscricoes.sql
--
-- O momento que interessa a quem junta carimbos é aquele em que o cartão fica
-- cheio — e é justamente o momento em que a pessoa está a guardar o telemóvel
-- e a sair do café. O carimbo é dado no aparelho do BALCÃO; do lado de cá não
-- há nada a dizer que aconteceu, a não ser que a app esteja aberta.
--
-- SÓ ISSO. Uma notificação por prémio ganho, e mais nada. «Há dois meses que
-- não apareces» é publicidade com outro nome, e a página de privacidade promete
-- em letra grande que não enviamos publicidade — a promessa vale mais do que a
-- campanha. Se um dia for para fazer, é outro consentimento e outra linha, não
-- um uso a mais deste.
--
-- O QUE SE GUARDA, e é preciso dizê-lo porque é a coisa mais identificadora
-- que esta base alguma vez teve: o `endereco` é um endereço que o serviço de
-- push do browser (a Google, a Mozilla, a Apple) dá àquele aparelho. Não é um
-- nome nem um número de telefone, mas identifica um telemóvel e não se pode
-- guardar em resumo — é para lá que se manda. Entra na política de privacidade
-- com nome e fundamento (consentimento), e desaparece com um toque.
--
-- As duas chaves são o que torna o texto ilegível para quem o transporta: o
-- `p256dh` é a metade pública de uma chave que o BROWSER gerou e da qual nunca
-- saiu a privada, e o `auth` é um segredo de 16 bytes que ele sorteou. Só quem
-- tem as duas metades lê a mensagem — a Google entrega um envelope fechado.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subscricoes (
  id          TEXT PRIMARY KEY,
  cliente_id  TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,

  -- Para onde se manda. Identifica o aparelho no serviço de push.
  endereco    TEXT NOT NULL,
  -- base64url, tal como o browser as dá.
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,

  criada_em   TEXT NOT NULL,
  -- Quando é que esta subscrição recebeu alguma coisa pela última vez.
  usada_em    TEXT,
  -- Envios seguidos que não deram. Ao terceiro a linha é apagada: um aparelho
  -- que recusa três vezes já não está a ouvir, e insistir é gastar pedidos do
  -- plano gratuito contra uma parede.
  falhas      INTEGER NOT NULL DEFAULT 0
);

-- Um aparelho, uma linha. O browser pode voltar a subscrever com o mesmo
-- endereço — depois de uma actualização, por exemplo — e o que tem de
-- acontecer é actualizar, nunca duplicar: duas linhas iguais são duas
-- notificações iguais no mesmo ecrã.
CREATE UNIQUE INDEX IF NOT EXISTS ix_subscricoes_endereco ON subscricoes(endereco);
CREATE INDEX IF NOT EXISTS ix_subscricoes_cliente ON subscricoes(cliente_id);
