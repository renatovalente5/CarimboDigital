-- --------------------------------------------------------------------------
-- 012 — as ligações a um provedor de identidade (17 set 2026)
--
--   npx wrangler d1 execute carimbodigital --remote --config ./wrangler.toml \
--     --file=migracoes/012-ligacoes.sql
--
-- A porta da Google — e a da Apple, que vem a seguir — abre-se por
-- REDIRECCIONAMENTO: a app manda o browser para lá e o browser volta à app com
-- um código na barra de endereço. Entre a ida e a volta há um
-- estado que tem de sobreviver, e que não pode viver no browser: o `state` que
-- prova que a volta corresponde à ida, o `nonce` que amarra o `id_token` a
-- esta ida, e o `code_verifier` do PKCE.
--
-- O BILHETE é a peça que fecha o buraco maior deste desenho. Sem ele, o ataque
-- era: eu peço a ida, fico com o que a app ficaria, e mando-te o endereço — um
-- endereço verdadeiro da Google, com o nosso identificador, indistinguível de
-- um login legítimo. Tu entras, e eu levanto a TUA sessão. O `state`, o PKCE e
-- o `nonce` não defendem disto: são todos do lado de quem COMEÇA, e quem
-- começa é o atacante. O que defende é exigir, para concluir, um segredo que
-- só existe no armazenamento local de quem pediu a ida.
--
-- O QUE NÃO ESTÁ AQUI: um testemunho de sessão. A sessão é cunhada no momento
-- em que a app a vem buscar com o bilhete, e não antes — senão uma cópia da
-- base de dados era uma mão-cheia de contas abertas. Do `state` e do bilhete
-- guarda-se o RESUMO, pela mesma razão por que as sessões se guardam assim.
--
-- O `verificador` do PKCE guarda-se em claro de propósito: ele não abre nada
-- sozinho — só serve acompanhado do código de autorização, que nunca passa por
-- aqui, e do segredo do cliente, que vive fora da base de dados.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ligacoes (
  id             TEXT PRIMARY KEY,

  -- 'google' hoje; 'apple' na fase a seguir, sem tocar nesta tabela.
  provedor       TEXT NOT NULL,

  -- SHA-256 do `state` e do bilhete. Nunca os próprios.
  estado_resumo  TEXT NOT NULL,
  bilhete_resumo TEXT NOT NULL,

  -- PKCE (RFC 7636). Sem valor sozinho: ver o cabeçalho.
  verificador    TEXT NOT NULL,
  -- Amarra o `id_token` a ESTA ida, e não a uma qualquer.
  nonce          TEXT NOT NULL,
  -- O `redirect_uri` exacto que foi enviado. A troca do código tem de repetir
  -- o mesmo, à letra, ou a Google recusa.
  redireccao     TEXT NOT NULL,

  -- O RESUMO da sessão de quem pediu, quando havia uma. É esta coluna que
  -- decide se uma identidade nova se pode colar a uma conta que já existe:
  -- sem ela, nasce conta nova. É a regra de ligação do PLANO-LOGIN.md §2.
  --
  -- Guarda-se o resumo da SESSÃO e não o número da conta de propósito: entre
  -- a ida e a volta passam minutos, e nesses minutos a sessão pode ter sido
  -- expulsa. Uma conta anotada não sabe disso; uma sessão, ao ser procurada,
  -- ou está lá ou não está. Na dúvida, nasce conta nova — que é o lado certo
  -- para falhar.
  sessao_resumo  TEXT,

  criada_em      TEXT NOT NULL,
  expira_em      TEXT NOT NULL,

  -- O `state` serve UMA vez. Marca-se antes de falar com a Google, para duas
  -- voltas com o mesmo código não darem duas trocas.
  usada_em       TEXT,

  -- Preenchidas quando a volta corre bem.
  concluida_em   TEXT,
  cliente_id     TEXT,
  -- 1 quando a conta em que se entrou não é a que pediu: a app avisa que os
  -- cartões vieram de outro aparelho, e oferece juntar os dois.
  recuperada     INTEGER NOT NULL DEFAULT 0,
  -- Quantas vezes a app já veio buscar a sessão. Há um tecto: uma resposta
  -- perdida pela rede merece outra tentativa, uma sondagem sem fim não.
  entregues      INTEGER NOT NULL DEFAULT 0,

  -- 'mesma-morada' quando a morada que veio do provedor já pertence, pela
  -- porta do email, a OUTRA conta. Não junta nada — a morada é pista e não
  -- chave — mas deixa a app explicar o que senão se lê como «perdi os
  -- cartões».
  pista          TEXT,

  -- Um código curto — 'google-recusou', 'google-falhou'. Nunca o texto que a
  -- Google devolveu: não se guarda aqui o que não se precisa de guardar, e uma
  -- mensagem de erro de terceiros pode trazer lá dentro o que lhe apetecer.
  erro           TEXT
);

-- As duas formas de chegar a uma linha. Únicos porque são resumos de 32 bytes
-- ao acaso: duas linhas iguais aqui só podem ser um defeito nosso.
CREATE UNIQUE INDEX IF NOT EXISTS ix_ligacoes_estado ON ligacoes(estado_resumo);
CREATE UNIQUE INDEX IF NOT EXISTS ix_ligacoes_bilhete ON ligacoes(bilhete_resumo);

-- A limpeza da madrugada varre por aqui.
CREATE INDEX IF NOT EXISTS ix_ligacoes_prazo ON ligacoes(expira_em);
