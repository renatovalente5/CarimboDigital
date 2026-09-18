-- =========================================================================
-- Carimbo Digital — esquema da base de dados (Cloudflare D1, que é SQLite)
--
-- Princípio que atravessa tudo: guardar o menos possível. Não há nome, nem
-- telefone, nem morada do cliente. Um cartão de fidelidade precisa de saber
-- quantos carimbos alguém tem — não precisa de saber quem é.
-- =========================================================================

-- --- negócios -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS negocios (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,       -- vai no link público e no cartaz
  nome         TEXT NOT NULL,
  categoria    TEXT,
  cor          TEXT NOT NULL DEFAULT '#17161C',
  logotipo     TEXT,                              -- PNG em base64; a Google exige um
  logotipo_em  TEXT,                              -- quando mudou, para a cache
  -- A cor que ficou COZIDA por trás dele, quando o ficheiro tinha
  -- transparência. Serve para o balcão saber avisar quando a cor do cartão
  -- muda e a imagem fica a discordar — refazê-la não dá, o original não fica.
  logotipo_fundo TEXT,
  morada       TEXT,
  localidade   TEXT,
  telefone     TEXT,
  sitio        TEXT,
  -- Onde fica, para o mapa do «Descobrir». Graus decimais WGS84, arredondados
  -- a cinco casas na escrita (a 40° de latitude, a quinta casa vale 1,11 m).
  latitude     REAL,
  longitude    REAL,
  -- 'gps' | 'mao' | 'concelho'. O mapa desenha-os DIFERENTE: um ponto ao metro
  -- e o centróide de um concelho inteiro não são a mesma promessa.
  geo_fonte    TEXT,
  geo_em       TEXT,
  -- A morada exacta que gerou o ponto. Quando o dono corrige a morada, o
  -- servidor compara e AVISA — em vez de deixar a coordenada a apontar em
  -- silêncio para a porta anterior, ou de apagar o trabalho dele por causa de
  -- um acento.
  geo_morada   TEXT,
  estado       TEXT NOT NULL DEFAULT 'ativo',   -- ativo | suspenso
  criado_em    TEXT NOT NULL,
  convite      TEXT,                               -- de que convite nasceu
  -- Um negócio que não existe, e que serve para provar a aplicação contra a
  -- produção a sério. Fica FORA da lista pública do «Descobrir», mas o
  -- endereço próprio continua a responder — é o que o cartaz e o QR usam.
  demonstracao INTEGER NOT NULL DEFAULT 0
);

-- --- programas ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS programas (
  id             TEXT PRIMARY KEY,
  negocio_id     TEXT NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  nome           TEXT NOT NULL,
  tipo           TEXT NOT NULL DEFAULT 'carimbos',   -- carimbos | pontos
  selo           TEXT NOT NULL DEFAULT 'carimbo',
  objetivo       INTEGER NOT NULL DEFAULT 10,
  premio         TEXT NOT NULL,
  regras         TEXT,
  -- Segundos entre dois carimbos no mesmo cartão. É a defesa contra carimbar
  -- dez vezes seguidas, de propósito ou por engano.
  arrefecimento  INTEGER NOT NULL DEFAULT 3600,
  -- Tecto diário por cartão, mais uma rede de segurança do que uma regra.
  maximo_diario  INTEGER NOT NULL DEFAULT 4,
  validade_dias  INTEGER,                            -- NULL = não expira
  ativo          INTEGER NOT NULL DEFAULT 1,
  criado_em      TEXT NOT NULL,
  wallet_classe  TEXT                               -- a classe na Google, por programa
);
CREATE INDEX IF NOT EXISTS ix_programas_negocio ON programas(negocio_id);

CREATE TABLE IF NOT EXISTS marcos (
  id           TEXT PRIMARY KEY,
  programa_id  TEXT NOT NULL REFERENCES programas(id) ON DELETE CASCADE,
  pontos       INTEGER NOT NULL,
  premio       TEXT NOT NULL,
  ordem        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_marcos_programa ON marcos(programa_id, pontos);

-- --- clientes -----------------------------------------------------------
-- `publico` é o que aparece no cartão e o que o balcão pode escrever à mão.
-- Não há segredo guardado: o segredo do dispositivo é derivado da chave-mestra
-- (ver `derivarSegredo` no Worker), por isso uma cópia desta tabela não chega
-- para forjar códigos.

CREATE TABLE IF NOT EXISTS clientes (
  id                TEXT PRIMARY KEY,
  publico           TEXT NOT NULL UNIQUE,
  chave_versao      INTEGER NOT NULL DEFAULT 1,
  email             TEXT,
  email_verificado  INTEGER NOT NULL DEFAULT 0,
  criado_em         TEXT NOT NULL,
  visto_em          TEXT,
  -- Quando saiu o aviso de que a conta ia ser apagada por estar parada.
  -- Volta a NULL assim que a pessoa aparece: quem voltou tem direito a um
  -- aviso novo da próxima vez, e não a ser apagado por causa de um antigo.
  avisada_em        TEXT,
  -- A conta que absorveu esta numa fusão. NULL = conta viva. Ver migracoes/010:
  -- uma conta que sai de uma fusão não se apaga, porque o número de cartão foi
  -- dito em voz alta ao balcão e escrito num guardanapo.
  fundida_em        TEXT,
  fundida_quando    TEXT
);
CREATE INDEX IF NOT EXISTS ix_clientes_email ON clientes(email);
CREATE INDEX IF NOT EXISTS ix_clientes_fundida
  ON clientes(fundida_em) WHERE fundida_em IS NOT NULL;
-- Uma morada verificada pertence a UMA conta. Parcial de propósito: uma morada
-- por verificar pode repetir-se à vontade, que são tentativas e não contas.
CREATE UNIQUE INDEX IF NOT EXISTS ix_clientes_email_unico
  ON clientes(email) WHERE email IS NOT NULL AND email_verificado = 1;
-- A limpeza diária pergunta por contas paradas: sem isto é uma varredura à
-- tabela toda, e as «linhas lidas» do D1 contam as percorridas, não as devolvidas.
CREATE INDEX IF NOT EXISTS ix_clientes_visto ON clientes(visto_em);

-- --- cartões ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cartoes (
  id               TEXT PRIMARY KEY,
  cliente_id       TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  programa_id      TEXT NOT NULL REFERENCES programas(id) ON DELETE CASCADE,
  negocio_id       TEXT NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  carimbos         INTEGER NOT NULL DEFAULT 0,   -- do ciclo actual
  pontos           INTEGER NOT NULL DEFAULT 0,
  total_carimbos   INTEGER NOT NULL DEFAULT 0,   -- de sempre
  premios_ganhos   INTEGER NOT NULL DEFAULT 0,
  aderiu_em        TEXT NOT NULL,
  -- O passe na Wallet. O `wallet_codigo` é um token PRÓPRIO e não o `publico`
  -- do cliente: um passe fotografado revoga-se sem mexer no cartão da pessoa.
  -- O `wallet_codigo` é de AMBAS as carteiras: é o mesmo código de barras, e é
  -- por ele que o balcão reconhece um passe (ver o ramo `W1.` do `carimbar`).
  wallet_codigo    TEXT,
  -- Estes dois são só da GOOGLE: «tem loyaltyObject lá fora» e «quando foi
  -- espelhado». Marcar um cartão só-Apple aqui punha o reconciliador da
  -- madrugada a bater num objecto que nunca existiu, todas as noites.
  wallet_em        TEXT,
  wallet_sincronizado TEXT,
  apple_em         TEXT,                          -- e este é o da Apple
  ultimo_em        TEXT,
  -- Como o BALCÃO trata este cliente — «a Joana da manhã». Escreve-a o café,
  -- nunca se pede ao cliente, e o cliente vê-a e pode tirá-la. Ver
  -- migracoes/011: é o que resolve «quem é o UTUEVN?» sem recolher nada.
  alcunha          TEXT,
  UNIQUE (cliente_id, programa_id)
);
CREATE INDEX IF NOT EXISTS ix_cartoes_cliente ON cartoes(cliente_id);
CREATE INDEX IF NOT EXISTS ix_cartoes_negocio ON cartoes(negocio_id, ultimo_em);
-- Os do passe. Estiveram onze linhas ACIMA do `CREATE TABLE cartoes`, entre os
-- índices dos clientes, e o ficheiro inteiro morria numa base vazia: o D1 corre
-- o `--file` numa transacção só, por isso o «no such table: cartoes» desfazia
-- até as tabelas que já tinham sido criadas. Em máquina de quem desenvolve
-- nunca se via — a base local sobrevive entre corridas e já tinha tudo.
-- O código é um token PRÓPRIO do passe: único, e só quando existe.
CREATE UNIQUE INDEX IF NOT EXISTS ix_cartoes_wallet_codigo
  ON cartoes(wallet_codigo) WHERE wallet_codigo IS NOT NULL;
-- O reconciliador da madrugada procura por aqui os passes atrasados.
CREATE INDEX IF NOT EXISTS ix_cartoes_wallet ON cartoes(wallet_em, wallet_sincronizado);

-- --- prémios ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS premios (
  id             TEXT PRIMARY KEY,
  cartao_id      TEXT NOT NULL REFERENCES cartoes(id) ON DELETE CASCADE,
  descricao      TEXT NOT NULL,
  ganho_em       TEXT NOT NULL,
  resgatado_em   TEXT,
  resgatado_por  TEXT,
  expira_em      TEXT
);
CREATE INDEX IF NOT EXISTS ix_premios_cartao ON premios(cartao_id, resgatado_em);

-- --- movimentos ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS movimentos (
  id          TEXT PRIMARY KEY,
  cartao_id   TEXT NOT NULL REFERENCES cartoes(id) ON DELETE CASCADE,
  tipo        TEXT NOT NULL,        -- adesao|carimbo|pontos|premio|resgate|anulado
  quantidade  INTEGER NOT NULL DEFAULT 0,
  nota        TEXT,
  operador    TEXT,
  manual      INTEGER NOT NULL DEFAULT 0,
  em          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_movimentos_cartao ON movimentos(cartao_id, em DESC);

-- --- operadores (quem carimba) ------------------------------------------

CREATE TABLE IF NOT EXISTS operadores (
  id          TEXT PRIMARY KEY,
  negocio_id  TEXT NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  nome        TEXT NOT NULL,
  email       TEXT,
  papel       TEXT NOT NULL DEFAULT 'balcao',   -- dono | balcao
  ativo       INTEGER NOT NULL DEFAULT 1,
  criado_em   TEXT NOT NULL,
  -- Última entrada. NULL = convidado e ainda não entrou, e o balcão di-lo: é a
  -- diferença entre um convite por usar e um colega que já cá esteve.
  visto_em    TEXT
);
CREATE INDEX IF NOT EXISTS ix_operadores_negocio ON operadores(negocio_id);
CREATE INDEX IF NOT EXISTS ix_operadores_email ON operadores(email);
-- E um operador activo por morada: entrar no balcão faz-se pelo email, e dois
-- activos com a mesma morada davam um balcão inalcançável.
CREATE UNIQUE INDEX IF NOT EXISTS ix_operadores_email_unico
  ON operadores(email) WHERE email IS NOT NULL AND ativo = 1;
-- E um NOME activo por balcão. O histórico guarda o nome de quem carimbou, e
-- não o identificador — para sobreviver a quem sai do café. Com dois «João»
-- activos, o histórico deixa de responder à pergunta que ter vários operadores
-- existe para responder. Sem maiúsculas e sem espaços à volta, que é como uma
-- pessoa lê dois nomes iguais.
CREATE UNIQUE INDEX IF NOT EXISTS ix_operadores_nome_unico
  ON operadores(negocio_id, lower(trim(nome))) WHERE ativo = 1;

-- --- sessões ------------------------------------------------------------
-- Guarda-se o resumo do testemunho, nunca o testemunho. Quem leve uma cópia
-- da base de dados não consegue entrar em conta nenhuma.

CREATE TABLE IF NOT EXISTS sessoes (
  resumo      TEXT PRIMARY KEY,
  sujeito     TEXT NOT NULL,        -- cliente:<id> | operador:<id>
  criada_em   TEXT NOT NULL,
  expira_em   TEXT NOT NULL,
  vista_em    TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessoes_sujeito ON sessoes(sujeito);
CREATE INDEX IF NOT EXISTS ix_sessoes_expira ON sessoes(expira_em);

-- --- códigos de entrada -------------------------------------------------
-- Um código de seis dígitos que se escreve, e não uma ligação que se clica.
--
-- A ligação é mais cómoda em quase todo o lado — mas dentro de uma app
-- instalada no iOS não funciona: o Safari e a app do ecrã principal têm
-- armazenamentos separados, e o iOS não sabe abrir ligações dentro de uma
-- PWA. Quem clicasse ficava com sessão iniciada no Safari e continuava sem
-- entrar na app que instalou. Um código escrito à mão funciona em todo o
-- lado, e é o mesmo email.
--
-- Seis dígitos são só um milhão de hipóteses, por isso `tentativas` e o
-- prazo curto é que fazem o trabalho: cinco erros e o código morre.

CREATE TABLE IF NOT EXISTS entradas (
  resumo      TEXT PRIMARY KEY,     -- resumo de "<email>|<codigo>"
  alvo        TEXT NOT NULL,        -- operador:<id> | cliente:<id>
  email       TEXT NOT NULL,
  tentativas  INTEGER NOT NULL DEFAULT 0,
  criada_em   TEXT NOT NULL,
  expira_em   TEXT NOT NULL,
  usada_em    TEXT
);
CREATE INDEX IF NOT EXISTS ix_entradas_email ON entradas(email);

-- Quantos códigos já saíram para cada morada, e quando.
--
-- Existe porque /v1/cliente/registar é aberto: qualquer pessoa cria uma
-- sessão e a seguir pede que se mande um código para a morada que lhe
-- apetecer. Sem tecto, isso é um relé de email gratuito montado em cima
-- do nosso domínio — e o preço não é a fatura, é o domínio ficar marcado
-- como fonte de spam e nenhum dos códigos a sério voltar a chegar.
--
-- Não se pode contar pela tabela `entradas`: um pedido novo apaga o
-- anterior, por isso a contagem lá dá sempre um.
CREATE TABLE IF NOT EXISTS envios (
  id     TEXT PRIMARY KEY,
  email  TEXT NOT NULL,
  em     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_envios_email ON envios(email, em);

-- --- quem cria contas em série (ver migracoes/008) -------------------------
-- Guarda-se um HMAC da origem, nunca a origem. Ver `travarRegistos`.
CREATE TABLE IF NOT EXISTS registos (
  origem TEXT NOT NULL,
  em     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_registos_origem ON registos(origem, em);

-- --- as formas de entrar numa conta (ver migracoes/009) --------------------
-- A identidade é `(provedor, sujeito)` e não a morada: o `sub` da Google e o
-- da Apple são espaços de nomes diferentes, e a mesma morada em dois
-- provedores não prova nada. O `email` daqui é PISTA, para escrever — nunca
-- para decidir de quem é a conta, e é por isso que o índice não é único.
CREATE TABLE IF NOT EXISTS identidades (
  id             TEXT PRIMARY KEY,
  cliente_id     TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  provedor       TEXT NOT NULL,        -- email | google | apple
  sujeito        TEXT NOT NULL,        -- morada em minúsculas, ou o `sub`
  email          TEXT,
  relay          INTEGER NOT NULL DEFAULT 0,   -- 1 = relay da Apple
  rotulo         TEXT,
  criada_em      TEXT NOT NULL,
  -- Não há estado «por verificar»: só chega a linha depois de provada.
  verificada_em  TEXT NOT NULL,
  usada_em       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_identidades_unica ON identidades(provedor, sujeito);
CREATE INDEX IF NOT EXISTS ix_identidades_cliente ON identidades(cliente_id);
CREATE INDEX IF NOT EXISTS ix_identidades_email ON identidades(email);
CREATE INDEX IF NOT EXISTS ix_entradas_expira ON entradas(expira_em);

-- --- a ida e a volta a um provedor de identidade (ver migracoes/012) -------
-- O estado que tem de sobreviver entre mandar o browser à Google e o browser
-- voltar. Vive aqui e não no browser porque a volta pode aterrar noutro
-- armazenamento — num iPhone com a app no ecrã principal, aterra. A app fica
-- com um BILHETE e vem cá perguntar se já está.
-- NUNCA guarda um testemunho de sessão: a sessão cunha-se na recolha.
CREATE TABLE IF NOT EXISTS ligacoes (
  id             TEXT PRIMARY KEY,
  provedor       TEXT NOT NULL,        -- google | apple
  estado_resumo  TEXT NOT NULL,        -- SHA-256 do `state`
  bilhete_resumo TEXT NOT NULL,        -- SHA-256 do bilhete que a app guarda
  verificador    TEXT NOT NULL,        -- PKCE (RFC 7636)
  nonce          TEXT NOT NULL,
  redireccao     TEXT NOT NULL,        -- o `redirect_uri` exacto
  sessao_resumo  TEXT,                 -- o resumo da sessão de quem pediu, se havia
  criada_em      TEXT NOT NULL,
  expira_em      TEXT NOT NULL,
  usada_em       TEXT,                 -- o `state` serve uma vez
  concluida_em   TEXT,
  cliente_id     TEXT,
  recuperada     INTEGER NOT NULL DEFAULT 0,
  entregues      INTEGER NOT NULL DEFAULT 0,
  pista          TEXT,                 -- 'mesma-morada': há outra conta com ela
  erro           TEXT                  -- um código curto, nunca o texto deles
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_ligacoes_estado ON ligacoes(estado_resumo);
CREATE UNIQUE INDEX IF NOT EXISTS ix_ligacoes_bilhete ON ligacoes(bilhete_resumo);
CREATE INDEX IF NOT EXISTS ix_ligacoes_prazo ON ligacoes(expira_em);

-- --- notificações (ver migracoes/013) -------------------------------------
-- Uma notificação por PRÉMIO GANHO, e mais nada: o momento em que o cartão
-- fica cheio é o momento em que a pessoa está a sair do café, e o carimbo foi
-- dado no aparelho do balcão. «Há dois meses que não apareces» é publicidade
-- com outro nome, e a página de privacidade promete que não a enviamos.
-- O `endereco` identifica um aparelho e não se pode guardar em resumo — é para
-- lá que se manda. As duas chaves são do BROWSER: só ele lê a mensagem.
CREATE TABLE IF NOT EXISTS subscricoes (
  id          TEXT PRIMARY KEY,
  cliente_id  TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  endereco    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  criada_em   TEXT NOT NULL,
  usada_em    TEXT,
  falhas      INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_subscricoes_endereco ON subscricoes(endereco);
CREATE INDEX IF NOT EXISTS ix_subscricoes_cliente ON subscricoes(cliente_id);

-- --- códigos já usados (anti-repetição) ---------------------------------
-- Um código só serve uma vez. Sem isto, a fotografia do ecrã de um amigo
-- valia carimbos durante os quinze segundos de vida do código.

CREATE TABLE IF NOT EXISTS codigos_usados (
  chave     TEXT PRIMARY KEY,       -- <publico>:<janela>
  usado_em  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_codigos_usados_em ON codigos_usados(usado_em);

-- =========================================================================
-- Convites
--
-- Quem pode abrir um balcão novo. Era um segredo do Worker igual para toda a
-- gente, com usos infinitos e sem forma de revogar um sem partir os outros —
-- e que nem o dono do produto conseguia ler de volta, porque o Cloudflare não
-- devolve segredos.
--
-- O código em claro nunca entra aqui: guarda-se o resumo SHA-256, como nas
-- sessões. Uma cópia desta base não dá um convite a ninguém.
-- =========================================================================
CREATE TABLE IF NOT EXISTS convites (
  resumo       TEXT PRIMARY KEY,
  etiqueta     TEXT,                              -- para quem é, em português
  email        TEXT,                              -- NULL = qualquer morada o pode gastar
  usos_max     INTEGER NOT NULL DEFAULT 1,
  usos         INTEGER NOT NULL DEFAULT 0,
  criado_em    TEXT NOT NULL,
  expira_em    TEXT,                              -- NULL = não expira
  revogado_em  TEXT,
  usado_em     TEXT
);
