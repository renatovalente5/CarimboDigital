-- --------------------------------------------------------------------------
-- 016 — traz um amigo (18 set 2026)
--
--   npx wrangler d1 execute carimbodigital --remote --config ./wrangler.toml \
--     --file=migracoes/016-traz-um-amigo.sql
--
-- «Cada cliente traz outro, e ganham os dois.» É a forma mais barata que um
-- café tem de crescer: quem já lá vai convida quem conhece, e a recompensa sai
-- do próprio cartão — carimbos, que custam ao café o que ele já decidiu que um
-- carimbo custa.
--
-- QUEM PAGA É QUE DECIDE, e por isso isto nasce DESLIGADO: zero carimbos para
-- os dois lados. Um programa de fidelização que dá coisas sem o dono ter dito
-- quanto é um programa que lhe tira dinheiro do bolso sem lhe perguntar.
--
-- A RECOMPENSA SÓ ACONTECE NO PRIMEIRO CARIMBO A SÉRIO, e não na adesão. É a
-- defesa que segura tudo o resto: criar contas vazias e aderir com elas não dá
-- nada a ninguém, porque é preciso alguém ir ao balcão, mostrar o código e ser
-- carimbado por uma pessoa. Sem isto, «traz um amigo» seria uma máquina de
-- fazer carimbos a partir de um telemóvel e paciência.
--
-- E O CONVITE VAI ASSINADO. O código que a app partilha leva o número público
-- de quem convida mais uma assinatura da chave-mestra: sem ela, bastava saber
-- um número público — que é dito em voz alta ao balcão todos os dias — para se
-- atribuir convites a quem nunca convidou ninguém.
-- --------------------------------------------------------------------------

-- --- o que o programa oferece ---------------------------------------------
-- Carimbos, e não prémios directos: um prémio dado de repente a quem tem o
-- cartão a meio é uma conversa difícil ao balcão. Carimbos somam-se à regra
-- que já existe, e se calhar fecham o cartão — e aí o prémio é o de sempre.
ALTER TABLE programas ADD COLUMN amigo_convidador INTEGER NOT NULL DEFAULT 0;
ALTER TABLE programas ADD COLUMN amigo_convidado INTEGER NOT NULL DEFAULT 0;

-- Quantos convites de um mesmo cliente é que este programa premeia. Cinco é
-- muito para quem convida a família e pouco para quem faz disto um negócio.
ALTER TABLE programas ADD COLUMN amigo_max INTEGER NOT NULL DEFAULT 5;

-- --- quem trouxe quem ------------------------------------------------------
CREATE TABLE IF NOT EXISTS amigos (
  id           TEXT PRIMARY KEY,
  programa_id  TEXT NOT NULL REFERENCES programas(id) ON DELETE CASCADE,
  -- Quem convidou e quem chegou. As duas contas são de clientes, e ambas
  -- desaparecem com elas: quem pede para ser apagado leva isto atrás.
  convidador   TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  convidado    TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  criado_em    TEXT NOT NULL,
  -- NULL enquanto o convidado não tiver sido carimbado pela primeira vez. É
  -- esta coluna que impede pagar duas vezes o mesmo convite.
  premiado_em  TEXT
);

-- UM CONVITE POR PESSOA E POR PROGRAMA. Sem isto, o mesmo par podia repetir o
-- convite tantas vezes quantas quisesse: apagar o cartão, voltar a aderir pelo
-- mesmo link, e outra vez.
CREATE UNIQUE INDEX IF NOT EXISTS ix_amigos_convidado
  ON amigos(programa_id, convidado);
-- Por onde se conta quantos convites de alguém já foram premiados.
CREATE INDEX IF NOT EXISTS ix_amigos_convidador ON amigos(convidador, programa_id);
-- E por onde o carimbar pergunta «este cliente foi trazido por alguém?».
CREATE INDEX IF NOT EXISTS ix_amigos_por_premiar
  ON amigos(convidado) WHERE premiado_em IS NULL;
