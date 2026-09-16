# Login — uma conta, várias formas de entrar

Escrito a partir de um estudo com seis frentes (modelo de dados, SMS, Apple,
Google, código actual, direito), três arquitecturas independentes e doze
cépticos a atacá-las. O que se segue é a síntese, com as fontes verificadas.

O objectivo é o que foi pedido: um ecrã de entrada com telefone, email, Apple
e Google, e **um utilizador com vários logins na mesma conta**, entrando por
onde quiser e abrindo sempre a conta dele.

---

## 0. Decidido

**Telefone e SMS: fora.** Não se envia uma mensagem. O modelo aceita
`provedor = 'telefone'` desde o primeiro dia e o interruptor fica desligado —
se um dia houver dinheiro e um travão à entrada, liga-se sem tocar no esquema.
Ficam três portas: email, Google e Apple.

**Sem portão à entrada.** A app continua a abrir em «Começar agora», e o
carimbo continua a ser possível sem conta nenhuma. **O login pede-se quando a
pessoa toca no ícone do perfil pela primeira vez** — que é o momento certo:
está sentada, à procura dos cartões dela, e não na fila do café com o dono à
espera.

As duas decisões abaixo ficam escritas porque a fundamentação continua a
valer, e porque o dia em que alguém quiser reabrir o assunto é bom ter aqui os
números.

---

## 1. As duas decisões, e porquê

### 1.1 O SMS não fecha as contas — e isso já estava escrito

O `PLANO.md`, secção 5, diz: *«SMS está fora: ~0,05 € por mensagem para
Portugal»*. Fui confirmar hoje na tabela de preços da Twilio: **0,0501 USD por
mensagem para móveis portugueses**. O número não mudou.

A 1,3 mensagens por registo — há sempre reenvios e entradas em telemóvel novo:

| utilizadores novos / mês | mais barato (BulkGate, 0,014 €) | Twilio | Twilio Verify |
|---|---|---|---|
| 100 | ~2 € | ~7 $ | ~13 $ |
| 1 000 | ~18 € | ~65 $ | ~130 $ |
| 10 000 | ~182 € | ~651 $ | ~1 301 $ |

E isto é só o crescimento. As re-entradas de quem muda de telemóvel crescem
com a base instalada, não com o mês.

**O número que decide não é esse.** É este: o `POST /v1/cliente/registar` é
aberto — sem convite, sem Turnstile, sem limite por IP (`index.js:872`). Ligar
o SMS a uma rota assim é abrir a porta ao *SMS pumping*: alguém dispara
pedidos de código para números caros e fica com parte da receita da operadora.
A fatura é de quem envia. Um tecto diário em D1 não resolve — só transforma
«fatura enorme» em «produto desligado até à meia-noite», que é o mesmo ataque
com outro nome.

E há a promessa. A frase *«Não pedimos nome, telefone nem morada»* não está em
dois sítios: está em **seis** — `_fonte/app/app.js:1317`,
`_fonte/paginas/inicio.html:121-122`, `_fonte/paginas/privacidade.html:16` e
`:57`, `_fonte/balcao/balcao.js:528`, e o cabeçalho do `worker/esquema.sql`.

**Recomendo não pôr telefone.** O modelo abaixo aceita `provedor = 'telefone'`
desde o primeiro dia — a coluna existe, o código existe, o interruptor fica
desligado. No dia em que houver dinheiro para o pagar e um travão à entrada,
liga-se sem tocar no esquema.

> **Decisão tua:** telefone sim ou não. Se sim, as seis frases têm de mudar
> primeiro, e é preciso um travão anti-abuso antes de a primeira mensagem sair.

### 1.2 Portão à entrada, ou porta que se abre por dentro?

Pediste um ecrã como o da Airbnb, à cabeça. Há aqui uma diferença que vale a
pena medir: a Airbnb vende uma estadia de centenas de euros, com a pessoa
sentada, uma vez por trimestre. Este produto quer que alguém aceite um carimbo
**em três segundos, ao balcão, com o dono do café a olhar** — e o caminho mais
comum de entrada é apontar a câmara a um cartaz na montra.

Um portão nesse momento é o pior momento possível.

**A arquitectura é exactamente a mesma nos dois casos.** O que muda é uma
linha: se o ecrã de entrada aparece antes do primeiro carimbo, ou se a app
continua a abrir com «Começar agora» e o ecrã de entrada vive no perfil
(«Guardar os meus cartões») e no arranque de um telemóvel sem estado local.

**Recomendo começar sem portão e medir duas semanas.** É reversível numa
linha, e a decisão contrária não é.

---

## 2. O modelo: a identidade é `(provedor, sujeito)`

```sql
CREATE TABLE IF NOT EXISTS identidades (
  id             TEXT PRIMARY KEY,
  cliente_id     TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,

  -- email | google | apple | telefone. O provedor faz parte da chave porque o
  -- `sub` da Google e o da Apple são espaços de nomes diferentes.
  provedor       TEXT NOT NULL,

  -- O identificador ESTÁVEL no provedor:
  --   email     → a morada em minúsculas
  --   google    → o `sub` do id_token, NUNCA o email
  --   apple     → o `sub` do id_token
  --   telefone  → o número em E.164
  sujeito        TEXT NOT NULL,

  -- A morada que o provedor mostrou. É PISTA, para lhe escrevermos — nunca
  -- para decidir de quem é a conta.
  email          TEXT,
  -- 1 quando é o relay da Apple. Um relay nunca vira identidade `email` e
  -- nunca é escolhido como morada de contacto: a pessoa pode desligá-lo.
  relay          INTEGER NOT NULL DEFAULT 0,
  rotulo         TEXT,

  criada_em      TEXT NOT NULL,
  -- Não existe estado «por verificar»: uma identidade só chega a ser linha
  -- depois de a pessoa a ter provado. É assim que o pré-registo morre de raiz.
  verificada_em  TEXT NOT NULL,
  usada_em       TEXT
);

-- A regra central do modelo inteiro.
CREATE UNIQUE INDEX IF NOT EXISTS ix_identidades_unica
  ON identidades(provedor, sujeito);
CREATE INDEX IF NOT EXISTS ix_identidades_cliente ON identidades(cliente_id);
-- NÃO é único, e é de propósito: duas contas podem mostrar a mesma morada sem
-- serem a mesma conta. O dia em que alguém puser UNIQUE aqui é o dia em que o
-- pré-registo entra.
CREATE INDEX IF NOT EXISTS ix_identidades_email ON identidades(email);
```

### A regra de ligação, que é uma só

> **Uma identidade nova só se cola a uma conta que JÁ provou ser daquela
> pessoa na mesma sessão. Nunca por coincidência de morada.**

Isto não é prudência: é a mitigação que o *Pre-hijacked accounts* (Sudhodanan
e Paverd, USENIX Security 2022) recomenda. O ataque é simples — crio uma conta
com o teu email antes de tu lá chegares, e fico com acesso quando entras pelo
Google.

**E o Worker já acerta nisto, sozinho.** O `/v1/cliente/entrar` resolve o dono
no momento do **resgate** do código, não no da emissão (`index.js` ~1042). É
exactamente a mitigação recomendada. Generaliza-se palavra por palavra para as
quatro portas; não se toca, estende-se.

Os casos, um a um:

| situação | o que acontece |
|---|---|
| identidade nova, sem conta nenhuma | nasce conta, a identidade é a primeira |
| identidade nova, com sessão **provada** | cola-se à conta da sessão |
| identidade já pertence a outra conta | **não se cola** — oferece-se fusão, com prova dos dois lados |
| email igual ao de outra conta | não decide nada. O email é pista |
| telefone que pode ter sido reciclado | caduca por inactividade, e nunca sozinho reclama uma conta |

---

## 3. Três dívidas que têm de ser pagas ANTES do login

Isto foi o que os cépticos mais atacaram, e não é login nenhum — é o que já
existe. Construir o login por cima sem pagar estas dívidas multiplica-as.

### 3.1 O «segredo do dispositivo» não é do dispositivo

`derivarSegredo` é `HMAC(CHAVE_MESTRA, "c1:<cliente_id>")` (`index.js:167`).
Não leva nada do aparelho lá dentro — o próprio teste diz à letra que *«o
segredo do aparelho é o mesmo: o QR de B vale tanto como o de A»*
(`testes.mjs:944`).

É uma **chave-mestra de conta**, distribuída a todos os aparelhos que lá
entrem, e **não há como a revogar**. A coluna prevista para isso,
`clientes.chave_versao`, está no esquema, tem um comentário a explicar que é
ela que revoga — e nunca é lida nem escrita em lado nenhum. Já o tinha
encontrado antes de o estudo o confirmar.

Com uma porta de entrada, isto é mau. Com quatro e várias sessões, perder o
telemóvel passa a não ter solução.

**Paga-se primeiro:** pôr o `chave_versao` a valer (entra no HMAC, incrementa
ao expulsar dispositivos), e um «sair em todos os aparelhos».

> **PAGA — 16 set 2026.** `derivarSegredo(env, id, versao)`; a versão 1 mantém
> a fórmula antiga byte a byte, senão partia o QR de todas as apps instaladas
> (a cópia no telemóvel de alguém é de há semanas). `POST /v1/cliente/sair-dos-outros`
> apaga as outras sessões, sobe a versão e devolve o segredo novo a quem mandou
> — senão o próprio aparelho expulsava-se a si mesmo.
>
> **E revoga também o `wallet_codigo`, que era a dívida 3.2 a chegar mais cedo
> do que o plano previa.** Ao escrever o teste viu-se que o caminho `W1.` não
> leva assinatura nenhuma: o código É a credencial, e o `carimbar()` nem olha
> para a versão da chave nesse ramo. Subir a versão não lhe tocava, e o passe
> do telemóvel perdido continuava a carimbar para sempre. Um botão que diz
> «expulsei os outros aparelhos» e deixa lá dentro uma credencial viva é uma
> mentira, por isso a rota põe `wallet_codigo`, `wallet_em` e `apple_em` a NULL
> e expira os objectos do lado da Google. O preço — o passe morre também no
> aparelho que ficou — vai na resposta em `passesRevogados`, para a app avisar
> em vez de deixar falhar ao balcão.

### 3.2 O `wallet_codigo` é um portador

O passe na carteira do telemóvel carrega um código que carimba. A fusão
reparenteia cartões — e se o código for com eles, **o passe que está na minha
carteira passa a abrir o cartão da outra pessoa**. Três cépticos chegaram lá
por caminhos diferentes.

**Paga-se com a fusão (fase 3), e não antes:** o `wallet_codigo` é revogado e
reemitido em qualquer mudança de dono de cartão, e o objecto da Google é
expirado do lado dela. Antes da fusão não há mudança de dono nenhuma, e
construir o mecanismo sem quem o chame é construir às cegas.

> **METADE PAGA — 16 set 2026.** O *mecanismo* de revogação já existe e está
> provado (ver 3.1): a rota de expulsar aparelhos põe as três colunas a NULL e
> expira o objecto na Google. O que falta é **chamá-lo na fusão**, que é onde
> muda o dono de um cartão — e isso continua a ser da fase 3, como estava.

### 3.3 O registo é uma porta aberta

`POST /v1/cliente/registar` não tem travão nenhum. Hoje custa uma linha no
D1; com SMS custaria dinheiro, e com fusão custa superfície de ataque.

**Paga-se primeiro:** limite por IP dentro do Worker, com o `CF-Connecting-IP`.

> **PAGA — 16 set 2026.** `travarRegistos`: 60 contas por origem por hora,
> tabela `registos` (migração 008), limpa na madrugada. **O que se guarda não é
> o endereço, é um HMAC dele com a chave-mestra** — a política de privacidade
> enumera o que é recolhido e o endereço não estava lá; um resumo simples
> também não servia, que os quatro mil milhões de IPv4 se percorrem numa tarde.
> A secção 2 da política ganhou a linha correspondente, com fundamento no
> interesse legítimo. Sem cabeçalho não há trava — na borda a Cloudflare põe-no
> sempre e substitui o que o cliente mandar, por isso faltar só acontece em
> desenvolvimento local.
>
> **Risco conhecido, por vigiar:** os operadores móveis em Portugal usam CGNAT,
> ou seja, muitos clientes partilham o mesmo IPv4. Com um negócio a sério o
> tecto nunca se alcança; com centenas de cafés, sessenta contas novas por hora
> vindas do mesmo operador deixa de ser impossível, e o que a pessoa vê é «não
> consigo criar o cartão». Por isso a trava escreve no log quando dispara — se
> aparecer no `wrangler tail`, troca-se o limite por origem por um tecto global
> diário, que protege o orçamento de escritas sem castigar quem partilha IP.

*Não* Turnstile: ele carrega um script de `challenges.cloudflare.com`, e a
página de privacidade promete que o site «não carrega tipos de letra, mapas ou
scripts de terceiros» (secção 4). Seria partir a mesma promessa que nos fez
recusar o One Tap da Google, e por uma coisa que um `SELECT` resolve.

É a mesma razão por que o Google e a Apple entram por **redireccionamento
puro**: a página não carrega script nenhum deles — navega para lá e volta. A
promessa dos scripts de terceiros mantém-se intacta.

---

## 4. A fusão, que é a parte perigosa

Quando alguém prova ser dono de duas contas:

- **Os cartões reparenteiam-se** (`UPDATE cartoes SET cliente_id`), nunca se
  recriam. O objecto da Google é `<emissor>.<cartao.id>` e o `serialNumber` do
  `.pkpass` é o `cartao.id`: recriar cartões mataria todos os passes já
  guardados.
- **Dois cartões do mesmo programa:** o ciclo em curso fica pelo **maior**,
  nunca pela soma. Somar é pagar fraude — o arrefecimento e o tecto diário são
  por *cartão*, não por pessoa.
  *Mas* — e os cépticos têm razão — isso não fecha a fraude sozinho: os
  **prémios já ganhos passam todos**, e são eles que valem dinheiro. Ou os
  prémios por levantar passam a precisar de confirmação do balcão numa fusão,
  ou a fusão só se oferece quando não há prémios pendentes dos dois lados.
- **Sessões:** dois modos, e confundi-los é um ataque. *Fusão provada* (as
  duas contas autenticadas no acto) → as sessões reapontam-se. *Absorção* de
  uma conta anónima que ninguém provou → as sessões dela **morrem**.
- **A conta que sai não se apaga:** fica como sombra, para o número de cartão
  antigo — que foi lido em voz alta e fotografado — continuar a carimbar. Mas
  a sombra **não pode** manter o segredo antigo a valer: é aí que entra o
  `chave_versao` da dívida 3.1.

---

## 5. As portas

**Email** — já existe. Só muda de casa: passa de `clientes.email` para
`identidades`. Custo zero, sai pela Hostinger.

**Google** — ~200 linhas no Worker, gratuito. **Por redireccionamento, nunca
One Tap:** o One Tap escreve um cookie `g_state` no nosso domínio e carrega um
script de `accounts.google.com` antes de qualquer clique, o que parte à letra
as duas frases publicadas («não carrega scripts de terceiros», «não instala
cookies») e traz de volta o aviso de cookies. O ecrã de consentimento tem de
ficar **publicado**, não em *Testing* — em Testing os logins morrem ao fim de
sete dias.

**Apple** — ~350 linhas. Precisa de um **App ID primário** com Sign in with
Apple, de um **Services ID** (é esse o `client_id` da web) e de uma **chave
.p8 nova** — a da Wallet não serve. Armadilha que custa um dia: a página
«Verifying a user» da Apple manda verificar «the JWS E256 signature» e **isso
está errado** — o `openid-configuration` dela declara `RS256`. O ES256 é só do
nosso *client secret*.

**Telefone** — ver §1.1.

---

## 6. As fases

| # | o quê | esforço | depende de ti |
|---|---|---|---|
| ~~0~~ | ~~Dívidas 3.1 e 3.3, mais o `/v1/cliente/eu`~~ — **feita, 16 set 2026** (e metade da 3.2 veio atrás) | — | nada |
| 1 | Migração `identidades` + email a passar por lá | 1–2 dias | correr a migração em remoto |
| 2 | `GET /v1/cliente/eu` e a sombra | meio dia | nada |
| 3 | A fusão, com a bateria a prová-la | 2–3 dias | decidir a regra dos prémios |
| 4 | Ecrã de entrada e os seis textos, **mais o botão «sair nos outros aparelhos»** que a fase 0 deixou sem quem o chame | 2–3 dias | **aprovar os textos** |
| 5 | Continuar com Google | 3–4 dias | 3 passos de consola |
| 6 | Continuar com Apple | 4–5 dias | 4 passos de consola |
| ~~7~~ | ~~Telefone~~ | — | **fora, decidido** |

**A ordem de publicação é sempre a mesma, e é regra desta casa:** SQL primeiro,
Worker depois, app por último. E a API **acrescenta, não renomeia** — a PWA no
telemóvel de alguém pode ser de há semanas.

Um aviso sobre os números acima: um céptico argumentou, com o histórico deste
repositório na mão, que a estimativa de código está errada por um factor
próximo de dez quando se contam os testes, o condutor de demonstração e a
bateria de browser. Trata as fases como ordem, não como calendário.

---

## 7. O que fica por resolver

- **O telefone reciclado.** A ANACOM fixa um «tempo de guarda» de seis meses,
  ao fim do qual um número pode ser reatribuído. A engenharia reduz, não fecha.
- **A caixa de correio é agora o tecto do produto.** Se o email for a única
  porta de recuperação, o limite diário da Hostinger passa a ser o limite de
  quantas pessoas conseguem recuperar a conta por dia.
- **O `.pkpass` da Apple não se actualiza sozinho** sem o serviço web de
  actualização — que é mais uma peça por construir.
- **As passkeys** resolvem melhor do que o telefone o problema que o telefone
  ia resolver, e custam zero. Vale a pena olhar, depois.
