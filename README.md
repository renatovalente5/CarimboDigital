# Carimbo Digital

**O cartão de carimbos, sem o papel.**
Todos os cartões de fidelidade num só sítio. O cliente mostra um código, o
balcão aponta a câmara, o carimbo aparece nos dois telemóveis.

> A marca é um pedaço do próprio produto: três casas carimbadas e uma por
> carimbar, com o mesmo tracejado que a app usa nas casas vazias.

**No ar:** https://carimbodigital.pt
**API:** `https://carimbodigital-api.renato-lima-valente-dcb.workers.dev`

---

## O que é

Três coisas no mesmo repositório:

| | O quê | Onde |
|---|---|---|
| **Site** | Apresentação, páginas legais | `/` |
| **App do cliente** | A carteira de cartões e o código | `/app/` |
| **Balcão** | O leitor de códigos do comerciante | `/balcao/` |
| **API** | Cloudflare Worker + D1 | `worker/` |

Tudo isto corre a **0 €/mês**. O único custo é o domínio.

## Como está feito

- **Sem dependências.** Não há `package.json`, não há `npm install`, não há
  passo de compilação. O gerador é Node puro; o front-end é JavaScript de
  módulos nativos. É o que faz isto continuar a publicar daqui a três anos
  sem ninguém lhe tocar.
- **O gerador de códigos QR é nosso** (`_fonte/js/qr.js`, 6 kB). Modo byte,
  níveis L/M/Q/H, versões 1 a 40, escolha de máscara pela penalização da
  norma. Está provado contra um descodificador independente escrito em
  Python — 320 matrizes, síndromes de Reed-Solomon a zero e o texto a voltar
  igual.
- **Funciona sem rede.** O código do cliente é calculado no telemóvel a
  partir de uma chave que lá vive. Numa cave sem sinal, o cartão aparece na
  mesma.

## Correr em casa

```bash
node scripts/gerar.mjs     # constrói para _site/
node scripts/servir.mjs    # http://localhost:4321/CarimboDigital/
```

O `_fonte/config.json` já aponta para a API publicada, por isso corre contra
o servidor a sério. Para trabalhar sem rede, esvazia o campo `api`.

**Modo de demonstração:** `?demo=1` em qualquer das apps liga uma
implementação completa das regras dentro do browser (arrefecimento, prémios,
movimentos), sem servidor nenhum. `?demo=0` sai, e há um botão «Sair» na barra
que ela põe no topo de todos os ecrãs.

Escreve-se à mão, e é de propósito: **não há botão nenhum no produto que lá
leve.** Havia — «Só quero ver como funciona», na entrada do balcão — e saiu a
18 de Setembro de 2026. A bandeira do modo vivia no `localStorage`, que as duas
aplicações partilham por serem do mesmo domínio: um toque nesse botão punha
TAMBÉM a app do cliente em demonstração, e para sempre. Um cartão de
demonstração é assinado com outro segredo, por isso o balcão a sério não o
carimba — e o que se via era uma app com o aspecto da certa e um carimbo que
não dava. Agora a bandeira vive no `sessionStorage`, morre com o separador, e
o código que a demonstração gera começa por `D1` em vez de `C1`, para o balcão
poder dizer «este código é de uma demonstração» em vez de «código inválido».

Os dados da demonstração ficam noutro espaço de chaves, por isso não tocam na
conta a sério — serve para mostrar o produto a um dono de café no próprio
telemóvel, e é o chão onde as duas baterias correm.

Para correr com a API a sério:

```bash
cd worker
npx wrangler d1 execute carimbodigital --local --file=esquema.sql
npx wrangler d1 execute carimbodigital --local --file=semear.sql
node -e "console.log('CHAVE_MESTRA=' + require('crypto').randomBytes(32).toString('base64url'))" > .dev.vars
npx wrangler dev --local
```

e põe `"api": "http://localhost:8787"` em `_fonte/config.json`.

## Provar

```bash
node scripts/mapa-portugal.mjs                           # redesenha o mapa dos concelhos (raro; ver «O mapa»)
node scripts/verificar-qr.mjs                            # 320 matrizes lidas por um descodificador independente
node scripts/verificar-leitor.mjs                        # o leitor, contra códigos tortos e desfocados
node scripts/com-worker.mjs worker/testes.mjs --limpo    # a API, contra um Worker e uma base a sério
node scripts/bateria.mjs                                 # a app conduzida num Chrome, ecrã a ecrã
node scripts/auditar.mjs                                 # ligações, prefixos, manifestos, dados legais, segredos
```

O CI corre-os todos. Se algum falhar, não se publica.

As duas baterias reprovam também o que NINGUÉM PEDIU que elas vissem: a do
browser afirma «nada rebentou por baixo» a cada módulo, e a do Worker reprova
a corrida se ele atirar um erro por atender. É a classe de defeito que não
aparece em teste nenhum — um erro dentro de um `ctx.waitUntil()` corre depois
de a resposta ter saído, e o pedido dá 200 na mesma. A guarda encontrou um à
primeira corrida.

Os dois últimos merecem uma nota, porque fazem perguntas diferentes. O auditor
lê o que foi construído; a bateria **conduz** — carrega nos botões com o rato,
escreve nos campos e vê o que aparece. Ler o código apanhou 90 defeitos e
conduzir a app apanhou outros 42, e a intersecção é pequena. O defeito mais
caro desta casa até hoje passou por um `node --check` limpo, por um auditor
limpo e pelos testes todos da API: uma função da app tinha sido renomeada e
duas chamadas ficaram com o nome velho, dentro de um `try` que transformava o
`TypeError` numa frase educada. Quem o apanhou foi a bateria, porque percorre
a volta do login até ao fim em vez de a ler.

## Publicar

### O site (GitHub Pages)

Empurrar para `main` chega. O workflow prova, constrói, audita e publica.

Enquanto não houver domínio próprio, o site vive em `/CarimboDigital/` e o gerador
mete esse prefixo em todos os caminhos sozinho. **Assim que o domínio
existir**, cria um ficheiro `CNAME` na raiz com o domínio lá dentro: o
prefixo desaparece e tudo passa a apontar para a raiz.

> **Já aconteceu, a 11 de Setembro de 2026.** O site vivia em
> `renatovalente5.github.io/CarimboDigital` e passou a viver na raiz de
> `carimbodigital.pt`. As contas dos clientes são guardadas por ORIGEM
> (`localStorage` + `IndexedDB`), e a origem mudou: quem tivesse a app
> instalada no endereço antigo abre o novo e encontra uma conta vazia. Os
> cartões não se perderam — estão no servidor, presos à conta antiga — mas o
> caminho de volta é a recuperação por email, e só serve a quem tenha
> deixado a morada antes.
>
> Custou zero porque ainda ninguém a usava a sério. Se voltar a mudar de
> endereço, já não é assim.

### A API (Cloudflare Worker)

**Já está publicada.** A base de dados D1 vive na Europa Ocidental
(`--location=weur`) e os segredos estão postos. Para voltar a publicar depois
de mexer no `worker/src/index.js`:

```bash
cd worker && npx wrangler deploy --config ./wrangler.toml
```

O `--config` não é decoração — ver «Aquilo em que se pode tropeçar».

**Publica-se daqui, e só daqui. Não há workflow para a API,** e a ausência é
uma decisão: os tokens de Workers do Cloudflare não se conseguem limitar a um
Worker — são da conta inteira. Um token guardado neste repositório podia
reescrever os outros cinco Workers da conta, um deles o que trata de
pagamentos noutro projecto. Aqui no Mac o wrangler entra por OAuth e não fica
chave guardada em lado nenhum. E publicar a API a meio de um serviço é coisa
que se quer decidir, não sofrer — um botão não ajudava nisso.

Se um dia for preciso recomeçar do zero:

```bash
cd worker
npx wrangler d1 create carimbodigital --location=weur
# copia o database_id para o wrangler.toml
npx wrangler d1 execute carimbodigital --remote --file=esquema.sql
npx wrangler secret put CHAVE_MESTRA      # 32 bytes em base64url
npx wrangler secret put MAIL_TOKEN        # o correio, ver «Emails»

# As carteiras do telemóvel. Sem estes, as rotas do passe respondem 404 e os
# botões não aparecem — o serviço funciona à mesma, só sem passes.
npx wrangler secret put GOOGLE_CHAVE      # a private_key da conta de serviço
npx wrangler secret put APPLE_CERTIFICADO # SÓ o certificado, sem a chave
npx wrangler secret put APPLE_CHAVE       # a chave privada, em PKCS#8
npx wrangler secret put APPLE_CADEIA      # o intermédio WWDR da Apple

npx wrangler deploy --config ./wrangler.toml
```

> **O certificado da Apple caduca a 16 de Outubro de 2027.** Nesse dia deixam
> de sair passes novos; os que já estiverem nas carteiras das pessoas ficam lá,
> com o saldo do dia em que foram guardados. O Worker avisa no registo a partir
> dos 30 dias antes e recusa-se a assinar depois de caducado, com a data na
> mensagem. Renova-se no portal da Apple com um CSR novo — o caminho todo está
> em `_dev/apple/LEIA-ME.md`, que não vai no repositório.

### Criar um negócio

Um negócio nasce em **Balcão › Deram-me um código**, com um convite. Os
convites geram-se da linha de comandos:

```bash
node scripts/convite.mjs criar --para "Barbearia Tó"
node scripts/convite.mjs criar --para "Feira do Livro" --lote 5 --dias 30
node scripts/convite.mjs listar
node scripts/convite.mjs revogar 3f9a1c22
```

Cada convite é uma linha da tabela `convites`, com usos, validade e revogação
próprios, e **só o resumo SHA-256 do código lá vive** — uma cópia da base não
dá um convite a ninguém. Em troca, um código perdido não se recupera: revoga-se
pela ref e gera-se outro.

O comando imprime também uma ligação `…/balcao/#c=CÓDIGO`, que abre o
formulário com o campo já preenchido. Vai no **fragmento** e não na query
string de propósito: o que está depois do `#` não entra no cabeçalho `Referer`
nem nos registos de servidor nenhum, e o balcão limpa-o da barra de endereço
mal o lê.

### O mapa

O «Descobrir» tem um mapa com os estabelecimentos aderentes, e ele é
**desenhado dentro da app**: as fronteiras dos 308 concelhos, já projectadas,
vivem em `_fonte/dados/portugal.json` (100 KB) e vão no casco do service
worker como qualquer outro ficheiro do site.

Não há mosaicos de servidor nenhum, não há chave de API, não há um único
domínio novo. É isso que deixa a página de privacidade continuar a dizer, à
letra, que *«não carrega tipos de letra, mapas ou scripts de terceiros»* — e é
isso que faz o mapa funcionar sem rede. O `auditar.mjs` tem uma guarda que
reprova se algum ficheiro publicado passar a carregar o que quer que seja de
fora.

**O que ele não tem: ruas.** Mostra a forma do concelho e onde o
estabelecimento cai lá dentro; responde a «isto é perto de mim?» e não a «é
naquela esquina?». A segunda responde-se com o «Como chegar» de cada cartão,
que abre a aplicação de mapas do próprio telemóvel. O zoom trava onde o
desenho ainda diz alguma coisa — os contornos foram simplificados para a
escala do país, e deixar aproximar mais era prometer precisão que não existe.

Três folhas: continente, Açores e Madeira, cada uma com a sua escala. Os
Açores medem 570 km de ponta a ponta; numa caixa ao canto do continente, São
Miguel ficava com 26 unidades e a Graciosa com três. O mapa abre na folha onde
estão os negócios e só oferece as outras quando houver negócios nelas.

Para regenerar o desenho (só se a Carta Administrativa mudar):

```bash
node scripts/mapa-portugal.mjs
```

**«Ver os mais perto de mim»** ordena a lista por distância. A posição é lida
pelo telemóvel, usada para a conta ali mesmo, e **não sai de lá**: não vai num
endereço, não é guardada, não chega ao servidor — e a bateria afirma-o, a
espiar o `fetch` e o armazenamento depois de carregar no botão. Quem não tem
coordenada fica no fim da lista, e não no princípio.

O mapa não come a roda do rato: aproximar pede `ctrl`/`⌘` mais roda, ou uma
pinça. Um mapa no meio de uma página que rola e que apanha a roda simples é
uma armadilha. As setas do teclado arrastam-no, o mais e o menos aproximam, o
zero reenquadra — e isso está escrito por baixo dele e ligado por
`aria-describedby`, porque ninguém adivinha.

**As coordenadas vêm do telemóvel de quem está ao balcão**, em «O cartão ›
Onde fica» — não de um geocodificador. O balcão é usado ao balcão, e um botão
«Estou no estabelecimento» dá precisão ao nível da porta; perguntar a morada
ao Nominatim ou ao Photon devolve o centro da rua, a oitenta metros, porque o
número de porta não está no OpenStreetMap. Daria pior, e acrescentava um
domínio à política de privacidade para dar pior.

### Quem carimba

Um café com três turnos tem três pessoas a atender, e junta-se cada uma em
**Balcão › O cartão › Quem carimba**. Cada uma entra com **o email dela** — não
há PIN nem palavra-passe partilhada, que ao balcão é sempre um papelinho ao
lado da caixa.

Tudo o que é estranho nesta parte sai de uma decisão antiga: **o histórico de
cada cartão guarda o NOME de quem carimbou, e não o identificador.** É o que o
faz sobreviver a quem sai do café — e é por isso que:

- **dois nomes iguais e activos são recusados.** Com dois «João», o histórico
  deixa de responder à pergunta que isto existe para responder. Diz-se porquê,
  e «João da tarde» resolve;
- **quem sai desactiva-se, não se apaga**, e o índice do nome é parcial: sair
  liberta o nome para quem vier a seguir;
- **tirar alguém fecha-lhe a sessão no mesmo gesto** e queima os códigos por
  usar — senão continuava a carimbar depois de sair.

Só o dono junta e tira, não se pode tirar a si próprio nem despromover-se
sendo o último, e cabem dez pessoas por balcão.

### Traz um amigo

«Cada cliente traz outro, e ganham os dois.» Cada cliente pode partilhar um
link do cartão que já tem; quando a pessoa convidada for **carimbada pela
primeira vez** naquele café, os dois ganham os carimbos que o café escolheu.

**Nasce desligado** — zero carimbos dos dois lados. Quem paga é o café, e é o
café que decide, em **O cartão › Traz um amigo**. O tecto de três carimbos por
lado não é gosto: é o que impede que um «30» em vez de um «3» ofereça um
cartão inteiro a cada pessoa que entra pela porta.

Três coisas seguram isto, e cada uma fecha uma porta diferente:

- **O convite vai assinado.** Leva o número público de quem convida mais uma
  assinatura da chave-mestra. Sem ela, bastava saber um número público — que é
  dito em voz alta ao balcão todos os dias — para atribuir convites a quem
  nunca convidou ninguém.
- **A recompensa só acontece no primeiro carimbo a sério.** Não na adesão.
  Criar contas vazias não dá nada, porque é preciso alguém ir ao balcão e ser
  carimbado por uma pessoa.
- **Ninguém se convida a si próprio**, nem convida quem já é cliente, e há um
  tecto de convites premiados por pessoa. Quem *chega* ganha sempre, mesmo com
  o tecto cheio: castigá-lo pelo amigo que convidou muita gente seria castigar
  a pessoa errada.

O balcão vê «veio por um convite» no ecrã do carimbo — um cartão que salta
dois carimbos sem explicação parece um erro da app.

### Nada é carregado de fora

O `auditar.mjs` tem uma guarda que faz esta promessa falhar em teste e não em
produção, e ela pergunta ao contrário do que é costume: **existe algum
endereço de outro domínio num ficheiro publicado?** Não enumera etiquetas —
uma lista de `script src`, `img src` e afins perde sempre para a décima sexta
maneira de a contornar, e uma revisão adversarial encontrou quinze (um
`srcset`, um `poster`, um `<use href>`, um atributo sem aspas, um `fetch()`
escrito em JavaScript).

A única excepção automática é o `<a href>`, que é uma ligação e não um
carregamento. Tudo o resto tem de ser **declarado** na lista `PERMITIDOS`, com
a razão escrita ao lado — hoje são os namespaces de XML, o schema.org, a nossa
própria API, e os dois destinos do «Como chegar».

> **Isto era um segredo do Worker, o `CODIGO_FUNDADOR`** — um código igual para
> toda a gente, com usos infinitos, sem validade, sem registo de quem o usou, e
> impossível de anular sem partir todos os outros. Pior: o Cloudflare não
> devolve segredos, por isso nem quem o pôs o conseguia ler de volta.

O problema do primeiro operador é real e não tem volta a dar: para entrar é
preciso sessão, para ter sessão é preciso um código por email, e para receber
o código é preciso já existir um operador. O convite é quem corta o nó.

### Emails

Uma coisa só: `geral@carimbodigital.pt` é uma caixa da **Hostinger**, onde o
domínio está alojado. Recebe o correio e é de lá que saem os códigos de
entrada, pela API de correio que vem incluída no plano.

Chegou-se aqui depois de a Resend estar planeada e quase montada. O que a
desfez foram três factos, verificados em Setembro de 2026:

- **Não sai da União Europeia.** Com a Resend, a morada de quem pede o
  código, a data e o estado de entrega ficavam guardados nos Estados Unidos —
  a escolha de região só muda de onde o email *parte*, e mesmo essa é do
  plano pago. Era uma transferência a declarar e um subcontratante a mais
  para um serviço que manda seis algarismos.
- **O tecto é outro:** mil a três mil por **dia** por caixa, contra três mil
  por **mês** no plano gratuito da Resend.
- **Já está pago**, e não é mais uma conta para manter.

> **Porque não o Email Sending da própria Cloudflare**, já que o Worker está
> lá? Porque exige o plano **Workers Paid**. No plano gratuito só entrega a
> endereços previamente verificados na conta — o que serve para avisos a nós
> próprios e não serve para recuperação de conta, onde o destinatário é
> qualquer cliente. Verificado contra a documentação e contra a própria conta
> (a API responde `Unauthorized`).
>
> E porque não SMTP directo? Os Workers têm a porta 25 bloqueada, e as outras
> obrigariam a escrever um cliente de SMTP à mão — algumas centenas de linhas
> de protocolo cujos defeitos são silenciosos: um email que não chega.

**O DNS não precisa de nada.** É a vantagem que decidiu isto: o SPF, os três
CNAME de DKIM e o DMARC já lá estão desde que a caixa foi criada. Com a
Resend eram mais três registos num subdomínio `send.`, e um deles é uma chave
de duzentos caracteres que se cola à mão.

Para pôr a funcionar:

```bash
# 1. o token: hPanel › Emails › API. Ver o que ele abre, abaixo.
#    Descobre o identificador da caixa e confere o DNS:
MAIL_TOKEN=... node scripts/email.mjs

# 2. o identificador vai para o wrangler.toml, em MAIL_CAIXA (não é segredo)

# 3. o token vai para o Worker — escrito por ti, para não passar por mais
#    lado nenhum:
cd worker
npx wrangler secret put MAIL_TOKEN
npx wrangler deploy --config ./wrangler.toml

# 4. e uma prova a sério, com o email a chegar à caixa:
MAIL_TOKEN=... MAIL_CAIXA=AC... node scripts/email.mjs --enviar
```

> **O token abre a caixa toda.** A API da Hostinger não tem âmbito
> só-de-envio: o mesmo token lê, procura e apaga o correio de `geral@`. É a
> única coisa em que a Resend era melhor, onde a chave só servia para enviar.
> Por isso ele vive num segredo do Worker, nunca no repositório, e nunca numa
> variável de CI que se possa ler.

**Duas coisas que se perderam com a troca**, e que convém ter presentes:

- **Idempotência.** A Resend aceitava uma chave que impedia um pedido
  repetido de mandar um segundo email. Aqui quem segura isso é o
  `podeEnviar()` do Worker, que recusa dois pedidos para a mesma morada a
  menos de 45 segundos um do outro.
- **Uma cópia de cada envio fica em `INBOX.Sent`.** A API grava-a sempre. Ao
  volume de códigos de entrada isso é inofensivo, e até útil para conferir;
  se um dia o volume crescer, é uma caixa a encher.

**Se um envio falhar**, o motivo fica na consola do Worker:

```bash
cd worker && npx wrangler tail
```

A app não finge que enviou: se o email não sair, diz-o e deixa tentar outra
vez, em vez de mandar esperar por um código que nunca vem.

**A jurisdição da base de dados escolhe-se na criação e não se muda depois.**
`--location=weur` põe-na na Europa Ocidental. Para a garantia jurídica de
residência europeia usa-se
`npx wrangler d1 create carimbodigital --jurisdiction eu` — mas isso é
irreversível, por isso decide-se antes.


## Contas grátis

| Serviço | Limite gratuito | Quando é que dói |
|---|---|---|
| GitHub Pages | 100 GB/mês, 10 construções/hora | nunca, para um site destes |
| Cloudflare Workers | 100 000 pedidos/dia | ~30 000 carimbos/dia |
| Cloudflare D1 | 5 GB, 5 M linhas lidas/dia, 100 000 escritas/dia | um carimbo escreve 3 linhas |
| Hostinger (email) | 1 000–3 000/dia por caixa, conforme o plano | só se usa para entrar e recuperar contas |

Desde 1 de setembro de 2026 os limites do D1 são **impostos**: passado o
tecto as consultas falham até à meia-noite UTC, em vez de serem toleradas.

## Aquilo em que se pode tropeçar

- **O segredo do dispositivo nunca sai do telemóvel.** É guardado como
  `CryptoKey` não-extraível no IndexedDB: nem um script injectado nem o dono
  do telemóvel o conseguem copiar para outro aparelho. O servidor não o
  guarda — volta a derivá-lo da `CHAVE_MESTRA`.
- **Mudar a `CHAVE_MESTRA` invalida todos os códigos.** Existe uma coluna
  `chave_versao` na tabela `clientes` para uma futura rotação; enquanto não
  estiver implementada, não se muda a chave.
- **O leitor de códigos também é nosso** (`_fonte/js/qr-leitor.js`), porque o
  `BarcodeDetector` não existe no Safari e sem ele um balcão com iPhone ficava
  sem câmara. Faz binarização por blocos, encontra os olhos pela cadência
  1:1:3:1:1, monta uma transformação de perspectiva pelo padrão de alinhamento
  e corrige erros por Reed-Solomon. Lê o código real em 95% dos fotogramas em
  24 ângulos × 3 inclinações × 2 tamanhos, com desfoque, grão e luz de lado —
  e a 20 ms por fotograma. Onde o `BarcodeDetector` existe, é ele que trabalha.
- **Links de email não funcionam dentro de uma app instalada no iOS.** Por
  isso a recuperação de conta por email é por **código de seis algarismos**, e
  não por ligação. A outra porta — **entrar com a Google** — é por
  redireccionamento puro, e a volta aterra dentro de `/app/`, que é o âmbito
  declarado no manifesto: para fora dele, um iPhone abre o Safari e não volta.
- **Quem conclui uma entrada por um provedor tem de ser quem a começou.** A app
  guarda um bilhete antes de sair, e sem ele o servidor recusa a volta. Sem
  isso, bastava mandar a alguém o endereço da ida — um endereço verdadeiro da
  Google ou da Apple — para lhe levar a conta: o `state`, o PKCE e o `nonce`
  são todos do lado de quem começa.
- **Da Apple não vem morada de email.** Ela só a manda se a volta for por POST,
  e a volta aterra no GitHub Pages, que só serve GET. Quem entra só pela Apple
  não deixa por onde lhe escrever — e é por isso que o aviso de conta parada
  não lhe chega, e que a app lhe oferece juntar outra porta. Ver PLANO-LOGIN §6.3.
- **As notificações são uma só: o cartão ficou cheio.** «Há dois meses que não
  apareces» seria publicidade, e a página promete que não a enviamos. O texto
  vai cifrado no corpo do push (RFC 8291) e não se vai buscar à API — um
  service worker não tem acesso ao `localStorage`, que é onde vive a sessão.
- **Publica-se sempre com `--config ./wrangler.toml`.** O wrangler 4.131
  estreou uma «autoconfig» que, quando não encontra configuração à primeira,
  escreve uma por sua conta — e escreveu-a na **pasta-mãe** (`~/Websites/`),
  com um Worker chamado `ebsites` e a pasta do projecto ao lado como assets.
  A partir daí passou a publicar por esse ficheiro em vez deste. A publicação
  falhou por acaso, num binário grande; se a pasta apanhada fosse pequena,
  tinha corrido bem e publicado o site de outro projecto como um Worker novo.
  Sintomas: o nome do Worker no output não é `carimbodigital-api`, ou fala de
  ficheiros de outra pasta.
- **O `_site/` não vai para o repositório.** É gerado.

## Estrutura

```
_fonte/          o que se edita
  config.json      nome, domínio, endereço da API, dados da entidade
  paginas/         as páginas do site
  parciais/        molde, cabeçalho, rodapé
  app/             a aplicação do cliente
  balcao/          a aplicação do comerciante
  estilos/         nucleo (fichas de design) + app + balcao + site
  js/              nucleo, api, qr
  imagens/         marca e ícones
scripts/         gerar, servir, auditar, icones, verificar-qr
worker/          a API: esquema.sql, src/index.js, testes.mjs
_site/           o que se publica (gerado)
```

## Marca

| | |
|---|---|
| Tinta (primária) | `#5A31E8` |
| Papel (fundo) | `#FBFAF7` |
| Tinta escura (texto) | `#17161C` |
| Logótipo | `_fonte/imagens/marca.svg` |
| Ícones | `node scripts/icones.mjs` (regenera tudo a partir do símbolo) |

O nome escreve-se sempre em duas espessuras: **Carimbo** pesado, *Digital*
leve e mais claro. A classe `.marca-palavra` faz isso. Nunca em maiúsculas
todas, nunca com o símbolo esticado.

## Licença

Sem licença definida. Todos os direitos reservados até haver decisão.
