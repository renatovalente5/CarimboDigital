# Sinete — plano

O que se decidiu, porquê, e o que falta. Escrito a partir de uma investigação
com 12 frentes (mercado, concorrência, wallets, alojamento gratuito,
autenticação, anti-fraude, PWA, interface, direito, nome, modelo de negócio),
cada uma verificada contra as fontes originais.

---

## 1. O que é

Um cartão de fidelidade digital para cafés, barbearias, cabeleireiros e afins.
O cliente mostra um código, o balcão aponta a câmara, o carimbo aparece nos
dois telemóveis.

Três aplicações, um repositório, zero euros por mês.

## 2. Onde está o espaço

O mercado existe e já tem gente. O que não tem é ninguém a fazê-lo de graça.

| Quem | Onde | Quanto custa |
|---|---|---|
| Tap2 (Tap2Loyal) | Amesterdão | **49,95 € / 4 semanas** por estabelecimento (~650 €/ano) |
| Fidelize.pt | Portugal | 29–199 €/mês + **200 € de instalação** |
| Fidely (ProcessLab) | Portugal | 14,99–59,99 €/mês + IVA |
| VoraPlex | Portimão | 77–149 €/mês + IVA |
| Loopy Loyalty | EUA | 25–95 $/mês |
| Stamp Me | Austrália | 49–199 $/mês |
| Loyty | Portugal | sem preços públicos; site parado desde 2014 |

Nenhum tem plano gratuito permanente. Um café que queira experimentar tem de
assinar antes de saber se serve.

**A abertura é essa.** Um café em Ovar não vai pagar 650 € por ano para
carimbar cartões — mas experimenta uma coisa que não custa nada e que abre no
telemóvel que já tem no bolso.

### O que a concorrência faz bem, e nós roubámos

- **«Substitua o cartão de papel. Mantenha o ritual.»** (Tap2) — a promessa
  certa. Não é modernizar por modernizar; é tirar o papel e deixar tudo o
  resto igual.
- **«Quase a ganhar»** como métrica *e* como gatilho. Saber quem está a dois
  carimbos do prémio é a informação mais accionável que um balcão pode ter.
- **Inactividade a 60 dias** como sinal de fuga.
- **Número curto e legível no cartão**, para o balcão poder resolver sem
  câmara.
- **Cartaz para imprimir**, porque a adesão acontece ao balcão e não online.

### O que fazemos diferente

- **Grátis.** Sem mensalidade, sem cartão de crédito, sem período que acaba.
- **Uma app, todos os cartões.** O Tap2 vive dentro do Apple/Google Wallet e
  por isso não tem app própria — o que significa que o cliente não tem uma
  carteira única, nem histórico, nem forma de descobrir quem mais participa.
  Nós temos.
- **Um código só.** Não é um código por estabelecimento: é um código por
  pessoa. O balcão é que sabe qual o cartão a carimbar.
- **Sem nome, sem telefone, sem morada.** A concorrência vende «a base de
  clientes é sua» e pede o telemóvel de toda a gente. Nós não pedimos nada.

## 3. Arquitectura

```
GitHub Pages  ─────────────────  Cloudflare Worker  ──  D1 (SQLite)
   site + as duas apps                  API
   (HTML, CSS, JS estáticos)     (100k pedidos/dia)   (5 GB, 100k escritas/dia)
```

### Porque é este e não outro

Das opções gratuitas, foi a única a passar os quatro filtros: **não adormece,
permite uso comercial, guarda os dados na Europa e é mesmo gratuita.**

- **Supabase** — adormece ao fim de 7 dias sem actividade na base de dados. Um
  cron para o acordar também morre: o GitHub desactiva workflows agendados ao
  fim de 60 dias sem commits.
- **Appwrite Cloud** — pior: adormece ao fim de 7 dias sem actividade *de
  desenvolvimento*, e diz expressamente que o tráfego dos utilizadores não
  conta.
- **Firebase** — nunca adormece, mas as Cloud Functions exigem plano pago, o
  Cloud Storage passou a exigir plano pago em Fevereiro de 2026, e o Firebase
  Auth é só nos Estados Unidos.
- **Vercel Hobby** — proíbe uso comercial nos termos.
- **PlanetScale, Xata, Fly.io, Railway, Koyeb** — deixaram de ter plano
  gratuito utilizável. **Render** adormece ao fim de 15 minutos.

Cloudflare: os termos não têm cláusula de não-comercial. Há uma restrição
real — o §2.2.1(h) proíbe processar dados de cartão de crédito em
propriedades gratuitas — que não nos toca, porque não há pagamentos.

**Desde 1 de Setembro de 2026** os limites do D1 passaram a ser impostos: ao
atingir o tecto, as consultas falham até à meia-noite UTC. Um carimbo escreve
3 linhas; 100 000 escritas por dia dão cerca de **30 000 carimbos por dia**.

### O código do cliente

```
C1.<público>.<janela>.<assinatura>
   EA4BFM     119237859  037185d8d536a29f
```

- `janela` = o tempo em fatias de 15 segundos.
- `assinatura` = HMAC-SHA256(segredo do aparelho, `público.janela`), 16 dígitos.
- O servidor aceita ±2 janelas (relógios desencontrados) e recusa a mesma
  janela duas vezes.

O segredo **não é guardado no servidor**: é derivado da chave-mestra com
`HMAC(CHAVE_MESTRA, "c1:" + id do cliente)`. Uma cópia da base de dados não
chega para forjar códigos.

No telemóvel, o segredo é uma **`CryptoKey` não-extraível** guardada no
IndexedDB. O browser assina com ela e recusa-se a devolvê-la: nem um script
injectado na página nem o dono do telemóvel pela consola a conseguem copiar
para outro aparelho. (Provado: `crypto.subtle.exportKey` devolve
`InvalidAccessError`.)

Como o cálculo é local, **o código aparece sem rede**. Quem precisa de ligação
é o balcão.

### As defesas

| Defesa | O que impede |
|---|---|
| Assinatura HMAC | inventar um código |
| 15 segundos de vida | usar uma fotografia do ecrã |
| Uso único (chave primária em `codigos_usados`) | usar o mesmo código duas vezes, mesmo com dois telemóveis ao mesmo tempo |
| Arrefecimento (1 h por omissão) | carimbar dez vezes seguidas |
| Tecto diário por cartão | um dia inteiro de abuso |
| Escrita condicional (compare-and-swap) | dois telemóveis a carimbar no mesmo instante |
| Anulação só nos primeiros 2 minutos | tirar carimbos a quem já foi embora |
| Sessão de operador obrigatória | um cliente carimbar-se a si próprio |

A entrada manual (`M1.<número>`) não é assinada — é o balcão a escrever o
número que o cliente tem no ecrã. Fica marcada como manual no histórico e
está sujeita às mesmas regras.

## 4. As duas aplicações

**Cliente** (`/app/`) — carteira, cartão, código, prémios, perfil. Barra de
baixo com o código ao centro, sempre a um toque.

**Balcão** (`/balcao/`) — câmara, resultado, hoje, clientes, o cartão. Sempre
escuro: para não cegar ninguém às sete da manhã, para a imagem da câmara se
destacar, e para quem tem as duas instaladas nunca abrir a errada.

### O leitor de códigos

O `BarcodeDetector` do browser resolve tudo no Chrome do Android e **não
existe no Safari** — ou seja, num balcão em cada três ou quatro. Por isso o
leitor é nosso (`_fonte/js/qr-leitor.js`): binarização por blocos, olhos pela
cadência 1:1:3:1:1, transformação de perspectiva pelo padrão de alinhamento,
e correcção de erros Reed-Solomon.

Provado contra códigos desenhados como uma câmara os vê: **95% dos fotogramas**
em 24 ângulos × 3 inclinações × 2 tamanhos, com desfoque, grão e luz de lado, a
**20 ms** cada. Onde o `BarcodeDetector` existe, é ele que trabalha.

## 5. Autenticação

**O cliente não tem conta.** Na primeira abertura o telemóvel regista-se
sozinho e recebe um número e um segredo. Não se pede nada.

Depois, opcionalmente, deixa um email para poder recuperar os cartões noutro
telemóvel — e a recuperação é por **código de seis algarismos**, não por
ligação. A ligação seria mais cómoda, mas **dentro de uma app instalada no
iOS não funciona**: o Safari e a app do ecrã principal têm armazenamentos
separados, e quem clicasse ficava com sessão iniciada no sítio errado.

Seis algarismos são um milhão de hipóteses. O que os defende é o prazo (15
minutos), o uso único e o contador: cinco enganos e o código morre.

**Enviar email não é gratuito em todo o lado.** O Cloudflare Email Sending
precisa do plano pago de 5 $/mês para destinatários arbitrários. As opções a
zero: Brevo (300/dia, mas carimba «Sent with Brevo» no rodapé), Mailjet
(200/dia), **Resend (100/dia, 3 000/mês)** — que é a que está ligada —,
SMTP2GO (1 000/mês), Scaleway TEM (300/mês, francesa). O SendGrid acabou com o
plano gratuito em Maio de 2025; a AWS SES não tem plano gratuito para contas
criadas depois de 15 de Julho de 2025.

SMS está fora: ~0,05 € por mensagem para Portugal, o que a mil entradas por
mês dá 50 €/mês — infinito, quando o orçamento é zero.

## 6. Wallet do telemóvel

As duas plataformas não são simétricas, e é essa assimetria que decide o
plano.

**Google Wallet — gratuito e viável.** Projecto no Google Cloud, API activada,
conta de emissor no Google Pay & Wallet Console. Sem taxa e sem conta de
facturação. Começa em modo de demonstração; para publicar é preciso um perfil
de empresa (um empresário em nome individual serve), uma LoyaltyClass e
capturas de ecrã — a revisão leva 2 a 3 dias úteis. A distribuição é um JWT
RS256 anexado a `pay.google.com/gp/v/save/<JWT>`, e essa assinatura corre no
Worker sem problema. Actualizar pontos é um PATCH. **Mas não há app Google
Wallet no iOS.**

**Apple Wallet — 99 €/ano, sem volta a dar.** Um `.pkpass` é um ZIP assinado
com um certificado Pass Type ID, que só o titular de uma conta paga do Apple
Developer Program pode criar. As isenções existem só para instituições sem
fins lucrativos, ensino e governo. Não há forma legítima de auto-assinar.

Nota útil: ao contrário do que se diz por aí, **o GitHub Pages serve `.pkpass`
com o tipo MIME certo** — testado. O impedimento é o certificado, não o
alojamento.

**Decisão: a PWA primeiro.** O Google Wallet entra quando houver negócios que
o peçam; os 99 € da Apple pagam-se quando houver procura de iPhone provada.
Entretanto, o cartão no ecrã principal do telemóvel faz o mesmo trabalho — e
desde o iOS 26 qualquer site adicionado ao ecrã principal abre como aplicação.

## 7. Direito

Verificado contra os textos originais.

- **Duas camadas.** Na conta do consumidor (identificador opaco, sessão) somos
  **responsáveis pelo tratamento**. No registo de carimbos de cada
  estabelecimento, o estabelecimento é o responsável e nós somos
  **subcontratante** (art. 28.º do RGPD). Evita-se a responsabilidade conjunta
  do art. 26.º — que nasceria no dia em que fizéssemos campanhas ou perfis
  entre estabelecimentos.
- **Fundamento: contrato** (art. 6.º, n.º 1, al. b), não consentimento — um
  consentimento retirado partiria o serviço. As notificações promocionais é
  que precisam de consentimento próprio.
- **«Zero dados pessoais» não existe.** Um identificador de aparelho ligado a
  um histórico de visitas individualiza uma pessoa (considerando 26). São
  dados pseudonimizados, não anónimos. O mínimo viável é o que temos:
  identificador opaco + contador por estabelecimento + datas.
- **Registo de actividades (art. 30.º) é obrigatório desde o primeiro dia.** A
  isenção para menos de 250 trabalhadores não se aplica: o tratamento é
  regular, não ocasional.
- **Sem banner de cookies.** Um testemunho de sessão em armazenamento local é
  «estritamente necessário» (Lei 41/2004, art. 5.º, n.º 2). Mas qualquer
  estatística, mesmo auto-alojada, precisaria de consentimento em Portugal —
  por isso não há nenhuma.
- **Os carimbos não são moeda electrónica** (Directiva 2009/110/CE, art. 2.º,
  n.º 2, exige valor emitido contra a recepção de fundos) nem serviço de
  pagamento — desde que continuem gratuitos, intransmissíveis e de um só
  estabelecimento.
- **Acessibilidade:** quase de certeza fora do Ato Europeu da Acessibilidade,
  e isento como microempresa de qualquer modo. Constrói-se para WCAG 2.1 AA à
  mesma — a isenção evapora-se ao décimo trabalhador.
- **A base de dados fica na Europa.** O D1 aceita `--location=weur`, e aceita
  `--jurisdiction eu` para garantia jurídica. Escolhe-se na criação e não se
  muda depois.

## 8. O que falta

### Antes de mostrar a alguém

1. **Comprar o domínio.** `sinete.pt` e `sinete.app` estavam livres. As contas
   dos clientes são guardadas por origem: mudar de
   `renatovalente5.github.io/Sinete` para `sinete.pt` apaga todas as que já
   existirem. Com dois utilizadores não custa nada; com duzentos, custa os
   duzentos.
2. **Preencher `entidade` no `_fonte/config.json`** e pôr `producao: true`.
   Sem isso as páginas legais têm marcadores «POR PREENCHER» à vista, e a
   auditoria avisa.
3. **Publicar o Worker** e pôr o endereço em `config.json`. Enquanto isso não
   acontecer, tudo corre em modo de demonstração dentro do browser.

### Versão 2

- Vários programas por estabelecimento, e cartões de pontos com marcos
  editáveis no balcão.
- Vários operadores, com PIN por pessoa e histórico de quem carimbou.
- Notificações: «faltam-lhe dois carimbos» e «há dois meses que não aparece».
  Web Push funciona no iOS 16.4+ **apenas em apps instaladas no ecrã
  principal**, e pode ser enviado de graça do Worker com VAPID.
- Cartaz para imprimir, com o código de adesão do estabelecimento.
- Google Wallet.

### Versão 3

- Apple Wallet (99 €/ano).
- Descobrir estabelecimentos por perto.
- Convites: cada cliente traz outro, e ganham os dois.

## 9. Riscos

| Risco | O que fazer |
|---|---|
| Os limites gratuitos deixam de chegar | 30 000 carimbos/dia dá muito tempo. Ao aproximar-se, o Workers Paid custa 5 $/mês. |
| Um comerciante fecha e os clientes ficam com carimbos por levantar | Termos já dizem que o programa é do estabelecimento. Avisar na app quando um cartão fica inactivo. |
| A Cloudflare muda os planos gratuitos | O Worker é um ficheiro de 900 linhas contra uma base SQLite. Muda-se de casa num dia. |
| Ninguém adere | O custo de tentar é zero para os dois lados. É a única vantagem que nenhum concorrente pode copiar sem deitar fora a receita. |
| Alguém copia a ideia | A ideia não é defensável; a execução e o preço são. |

## 10. O nome

`Sinete` — o anel de selar, o objecto que deixa a marca. Do latim *signum*.

Seis letras, três sílabas abertas, sem acento e sem ambiguidade ao telefone.
Nomeia o objecto e não a marca que ele deixa, o que o torna sugestivo em vez
de descritivo — a classe de nome que é registável, ao contrário de «Carimbo»
ou «Selo».

O nome que se ia usando era **Carimbi**, e foi abandonado com razão:
`karimbou.com` é um produto vivo chamado **Karimbo**, cartão de fidelidade
digital, em português — e `carimbi.com` é uma aplicação brasileira que
transforma fotografias em «stamps». Duas colisões no mesmo campo semântico e
no mesmo mercado de língua.

**Tagline:** *Cada visita deixa a sua marca.*
