-- =========================================================================
-- Sinete — esquema da base de dados (Cloudflare D1, que é SQLite)
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
  logotipo     TEXT,
  morada       TEXT,
  localidade   TEXT,
  telefone     TEXT,
  sitio        TEXT,
  estado       TEXT NOT NULL DEFAULT 'ativo',   -- ativo | suspenso
  criado_em    TEXT NOT NULL
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
  criado_em      TEXT NOT NULL
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
  visto_em          TEXT
);
CREATE INDEX IF NOT EXISTS ix_clientes_email ON clientes(email);

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
  ultimo_em        TEXT,
  UNIQUE (cliente_id, programa_id)
);
CREATE INDEX IF NOT EXISTS ix_cartoes_cliente ON cartoes(cliente_id);
CREATE INDEX IF NOT EXISTS ix_cartoes_negocio ON cartoes(negocio_id, ultimo_em);

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
  criado_em   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_operadores_negocio ON operadores(negocio_id);
CREATE INDEX IF NOT EXISTS ix_operadores_email ON operadores(email);

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
CREATE INDEX IF NOT EXISTS ix_entradas_expira ON entradas(expira_em);

-- --- códigos já usados (anti-repetição) ---------------------------------
-- Um código só serve uma vez. Sem isto, a fotografia do ecrã de um amigo
-- valia carimbos durante os quinze segundos de vida do código.

CREATE TABLE IF NOT EXISTS codigos_usados (
  chave     TEXT PRIMARY KEY,       -- <publico>:<janela>
  usado_em  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_codigos_usados_em ON codigos_usados(usado_em);
