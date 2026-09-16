-- --------------------------------------------------------------------------
-- 009 — a identidade passa a ser `(provedor, sujeito)` (16 set 2026)
--
--   npx wrangler d1 execute carimbodigital --remote --config ./wrangler.toml \
--     --file=migracoes/009-identidades.sql
--
-- Hoje uma conta tem UMA forma de entrar, guardada em duas colunas da própria
-- conta: `clientes.email` e `clientes.email_verificado`. Isso chega enquanto a
-- porta é uma só. Com quatro — email, Google, Apple — a morada deixa de poder
-- ser a chave: o `sub` da Google e o da Apple são espaços de nomes diferentes,
-- e a mesma pessoa pode mostrar a mesma morada em dois provedores sem que isso
-- prove seja o que for.
--
-- O PROVEDOR FAZ PARTE DA CHAVE, e o `sujeito` é o identificador ESTÁVEL lá
-- dentro — nunca o email:
--
--   email   → a morada em minúsculas
--   google  → o `sub` do id_token
--   apple   → o `sub` do id_token
--
-- (O telefone não entra: ficou decidido que não há SMS. Ver PLANO-LOGIN.md §0.)
--
-- O `email` desta tabela é PISTA, para lhe podermos escrever — nunca para
-- decidir de quem é a conta. É por isso que o índice sobre ele NÃO é único: a
-- regra de ligação exige prova na mesma sessão, e o dia em que alguém puser
-- UNIQUE ali é o dia em que o pré-registo entra (Sudhodanan e Paverd, USENIX
-- Security 2022).
--
-- ESTA MIGRAÇÃO NÃO TIRA NADA. O `clientes.email` continua a ser escrito como
-- espelho, porque a PWA no telemóvel de alguém pode ser de há semanas e lê-o —
-- a API acrescenta, não renomeia. A fonte da verdade para «de quem é esta
-- morada» passa a ser esta tabela; o espelho sai numa fase posterior, quando
-- já não houver ninguém a lê-lo.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS identidades (
  id             TEXT PRIMARY KEY,
  cliente_id     TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,

  provedor       TEXT NOT NULL,
  sujeito        TEXT NOT NULL,

  -- A morada que o provedor mostrou. Pista, não chave.
  email          TEXT,
  -- 1 quando é o relay da Apple. Um relay nunca vira identidade `email` e
  -- nunca é escolhido como morada de contacto: a pessoa pode desligá-lo, e
  -- nesse dia o que lá escrevermos bate numa parede.
  relay          INTEGER NOT NULL DEFAULT 0,
  rotulo         TEXT,

  criada_em      TEXT NOT NULL,
  -- Não existe estado «por verificar»: uma identidade só chega a ser linha
  -- depois de a pessoa a ter provado. É assim que o pré-registo morre de raiz.
  verificada_em  TEXT NOT NULL,
  usada_em       TEXT
);

-- A regra central do modelo inteiro: uma identidade pertence a uma conta só.
CREATE UNIQUE INDEX IF NOT EXISTS ix_identidades_unica
  ON identidades(provedor, sujeito);

CREATE INDEX IF NOT EXISTS ix_identidades_cliente ON identidades(cliente_id);

-- NÃO é único, e é de propósito. Ver o cabeçalho.
CREATE INDEX IF NOT EXISTS ix_identidades_email ON identidades(email);

-- --------------------------------------------------------------------------
-- O que já existe passa a ter linha.
--
-- `OR IGNORE` para a migração poder correr duas vezes sem estragar nada — o
-- índice único é que decide, e uma segunda passagem não duplica.
--
-- A DATA É A DA CONTA, e não a da verificação: nunca se guardou quando é que
-- uma morada foi confirmada, por isso não há nada melhor para pôr aqui. Fica
-- dito em vez de fingido.
-- --------------------------------------------------------------------------
INSERT OR IGNORE INTO identidades
  (id, cliente_id, provedor, sujeito, email, relay, rotulo, criada_em, verificada_em, usada_em)
SELECT lower(hex(randomblob(16))),
       id,
       'email',
       lower(email),
       lower(email),
       0,
       NULL,
       criado_em,
       criado_em,
       visto_em
  FROM clientes
 WHERE email IS NOT NULL
   AND TRIM(email) <> ''
   AND email_verificado = 1;
