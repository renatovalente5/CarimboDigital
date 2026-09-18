<!-- O que se trouxe do fresha.com, e o que se recusou.

     Escrito a 18 de Setembro de 2026, a partir de cinco agentes que NAVEGARAM
     o site (333 chamadas de ferramenta), mais um a decidir. Uma das cinco
     lentes era o advogado do diabo, com direito de veto sobre as outras
     quatro — o Fresha é um mercado com milhões de utilizadores e nós temos um
     aderente, e copiar a forma sem ter a substância faz um site que mente.

     A secção (c) é a mais importante: o que se recusa para sempre. -->

Server stopped, test copy left in the scratchpad (`/private/tmp/claude-501/-Users-renatovalente-Websites/32a6c505-2f4c-4392-82cb-e820c6431eed/scratchpad/teste`). Nothing in `/Users/renatovalente/Websites/CarimboDigital` foi tocado.

# A decisão

**Uma barra só.** Um único `_fonte/parciais/cabecalho.html`, três portas no HTML, e a página diz de quem é trocando o preenchimento por uma classe no `<body>`. O `scripts/gerar.mjs:429` já faz `.split('{{CLASSE}}').join(meta.classe || '')` e o `molde.html` já tem `<body class="{{CLASSE}}">` — zero alterações ao gerador, zero JavaScript, zero duplicação. Duas barras em dois ficheiros é o que o Fresha faz porque tem dois front-ends e duas equipas; com quatro páginas seria só duas cópias a divergir à primeira distracção.

**O botão cheio é o da audiência da página.** Em `/`, `/privacidade/`, `/termos/` e `/404`: «Os meus cartões» cheio, «Para negócios» de contorno. Em `/negocios/`: «Os meus cartões» passa a contorno e «Abrir o balcão» fica cheio. Três razões, e a terceira decide:

1. **Espelha o herói que já lá está.** `/` tem «Abrir a minha carteira» cheio; `/negocios/` tem um botão cheio para o balcão. Inverter a barra punha as duas metades do mesmo ecrã a discordar sobre o que se deve fazer a seguir, e quem tem de desempatar vai-se embora.
2. **O dono de negócio não fica pior — fica muito melhor.** Medi no site actual: `_fonte/estilos/site.css:47` tem `.cabecalho-ligacoes { display: none }` e só as devolve em `@media (min-width: 760px)`. Ou seja, **hoje, num telemóvel, o cabeçalho é o logótipo e «Abrir a app» e mais nada — a palavra «negócios» não existe na barra.** Passar de inexistente a pílula de 44 px sempre presente é um salto muito maior do que a diferença entre cheio e contorno.
3. **O argumento saiu do código.** `_fonte/balcao/cartaz.html:182` codifica o QR como `${SITIO}/app/?n=<slug>` — vai directo à app, nunca passa por `/`. Mas a linha 140 imprime `{{DOMINIO}}` em texto no rodapé do cartaz. Quem chega a `/` é precisamente aquele a quem o QR falhou: está ao balcão, com fila atrás, a escrever o endereço à mão. Esse não lê a página, procura a palavra «cartões». Custar ao dono de café um contorno em vez de um preenchimento não é o mesmo que ter um cliente parado à frente da caixa.

**Não copiamos o Fresha no ponto que interessa.** Emulei 375×812 e medi: em `fresha.com` o cabeçalho fica com `[logótipo 75×48]` + `[Menu 32×32]` e mais nada — «Log in» **e** «For businesses» desaparecem os dois dentro do ☰. Copiar isso era fazer o contrário do pedido. Nós mostramos as duas portas a **todas** as larguras a partir de 320 px, sem hambúrguer nenhum.

---

## As palavras

O Fresha, medido: no cabeçalho de consumidor os três controlos têm **a mesma geometria** (48 px de altura, `border-radius: 999px`, 16 px peso 400) e nenhum é cheio; em `/for-business` a única pílula cheia é «Sign up» (#141414) e a porta para a outra audiência («Marketplace») é de contorno. **A hierarquia é feita só com tinta.** É essa a regra que vale a pena roubar — não os rótulos.

| Destino | Pílula do cabeçalho / rodapé | Botões grandes |
|---|---|---|
| `/app/` | **Os meus cartões** (curto: «Cartões») | **Abrir os meus cartões** |
| `/negocios/` | **Para negócios** (curto: «Negócios») | **Tenho um negócio** |
| `/balcao/` | **Abrir o balcão** (curto: «Balcão») | **Abrir o balcão** |

Regra que impede a deriva: **o substantivo é fixo, o verbo é opcional.** Hoje há cinco nomes sem regra nenhuma — «Abrir a app», «Abrir a minha carteira», «Experimentar o balcão», «Abrir o balcão», «Entrar no balcão».

**«Aceder» está vetado, e não por gosto.** O `/Users/renatovalente/Websites/CarimboDigital/PLANO-LOGIN.md:20` diz, à letra: «**Sem portão à entrada.** A app continua a abrir em "Começar agora", e o carimbo continua a ser possível sem conta nenhuma.» «Aceder» promete um ecrã de autenticação que não existe, e diz a quem está na fila do café que primeiro tem de fazer uma conta — que é exactamente a fricção que aquele plano evitou. No Fresha «Log in» é honesto porque lá não se faz nada sem conta. Aqui seria mentira. Pela mesma razão, **«Entrar no balcão» sai do rodapé**: a `/negocios/` promete «O balcão abre já… Não pedimos nada para experimentar», e «Entrar» contradiz isso.

Também recusado: «Para empresas» (o site inteiro diz «negócios», e um café com um empregado não se reconhece em «empresa»); «Abrir a app» (promete uma instalação que não existe e nomeia a embalagem em vez do conteúdo); «A minha carteira» (o site já usa «Carteira» para a Apple Wallet e a Carteira do Google em duas perguntas — duas «carteiras» no mesmo site é pior do que um verbo menos elegante).

---

## 1. `_fonte/parciais/cabecalho.html` — ficheiro completo

```html
<header class="cabecalho" id="cabecalho">
  <div class="cabecalho-linha">
    <a class="marca" href="{{BASE}}/" aria-label="Carimbo Digital — início">
      <svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8.5" fill="#5A31E8"/><circle cx="11.2" cy="11.2" r="4.35" fill="#FFFFFF"/><circle cx="20.8" cy="11.2" r="4.35" fill="#FFFFFF"/><circle cx="11.2" cy="20.8" r="4.35" fill="#FFFFFF"/><circle cx="20.8" cy="20.8" r="3.6" fill="none" stroke="#FFFFFF" stroke-width="1.5" stroke-opacity=".55" stroke-dasharray="2.6 2.2" stroke-linecap="round"/></svg>
      <span class="marca-palavra"><b>Carimbo</b><i>Digital</i></span>
    </a>
    <span class="cabecalho-espaco"></span>
    <nav class="cabecalho-ligacoes" aria-label="Secções">
      <a href="{{BASE}}/#como">Como funciona</a>
      <a href="{{BASE}}/#perguntas">Perguntas</a>
    </nav>
    <!-- As portas. A ORDEM é sempre a mesma — cliente à esquerda, negócio à
         direita — e só o preenchimento muda de página para página. Trocar a
         ordem obrigava o olho a reencontrar os botões a cada navegação;
         trocar a tinta não.

         A terceira porta está sempre aqui e é escondida com `display:none`
         nas páginas de cliente. `display:none` tira-a mesmo da ordem de
         tabulação e da árvore de acessibilidade — o atributo `hidden`, nas
         mesmas circunstâncias, já falhou noutro sítio deste projecto. -->
    <nav class="portas" aria-label="Aplicações">
      <a class="btn btn-pequeno porta-app" href="{{BASE}}/app/"><span class="porta-longa">Os meus cartões</span><span class="porta-curta">Cartões</span></a>
      <a class="btn btn-pequeno porta-negocio" href="{{BASE}}/negocios/"><span class="porta-longa">Para negócios</span><span class="porta-curta">Negócios</span></a>
      <a class="btn btn-pequeno porta-balcao" href="{{BASE}}/balcao/"><span class="porta-longa">Abrir o balcão</span><span class="porta-curta">Balcão</span></a>
    </nav>
  </div>
</header>
```

**O que sai:** «Para negócios» deixa a lista de secções (passou a pílula) e o `<a class="btn btn-cheio btn-pequeno">Abrir a app</a>` desaparece. Ficam duas âncoras, que é também o que dá espaço às pílulas.

**E uma linha nova** no bloco `---` de `/Users/renatovalente/Websites/CarimboDigital/_fonte/paginas/negocios.html`, a seguir a `prioridade: 0.8`:

```
classe: pagina-negocios
```

## 2. `_fonte/estilos/site.css` — substitui as linhas 33 a 53

Não se toca em `.cabecalho` (linhas 8 a 32): é ele que faz o pegajoso, o `backdrop-filter: saturate(1.8) blur(20px)` e a linha por `animation-timeline: scroll()` sem uma linha de JavaScript. Isso já é melhor do que o deles — o `saturate` impede que as cores por baixo desbotem ao atravessar o desfoque. Substitui-se de `.cabecalho-linha {` até `@media (min-width: 760px) { .cabecalho-ligacoes { display: flex; } }`, inclusive.

```css
.cabecalho-linha {
  display: flex; align-items: center; gap: var(--e-3);
  max-width: var(--coluna-larga); margin-inline: auto;
  padding: var(--e-3) var(--e-5);
  min-height: 60px;
}
.marca {
  display: inline-flex; align-items: center; gap: var(--e-3);
  font-size: 1.125rem; letter-spacing: -.03em;
}
.marca svg { width: 32px; height: 32px; flex: 0 0 auto; }
.marca .marca-palavra { font-size: 1.125rem; }
/* O nome por extenso ocupa 171,5 px que as duas portas precisam mais do que
   ele. Sai abaixo de 560; o símbolo fica, continua a ser o link para a
   inicial, e o `aria-label` diz o nome a quem não o vê. */
@media (max-width: 559px) { .marca .marca-palavra { display: none; } }

.cabecalho-espaco { flex: 1; min-width: var(--e-2); }

/* Um item de navegação é uma coisa em que se carrega. Medido no site
   actual: 22,5 px de altura, abaixo dos 24×24 do 2.5.8 da WCAG 2.2 e muito
   abaixo dos 44 que este projecto promete. Dar-lhe corpo de pílula resolve o
   alvo e dá superfície onde pintar o estado do rato. O `gap` desce de 24
   para 4 px porque o enchimento passa a dar o espaço. */
.cabecalho-ligacoes { display: none; gap: var(--e-1); }
.cabecalho-ligacoes a {
  display: inline-flex; align-items: center;
  min-height: 44px; padding-inline: var(--e-3);
  border-radius: var(--r-max);
  font-size: .9375rem; font-weight: 600; color: var(--tinta-2);
  transition: background-color var(--t-1) ease, color var(--t-2) ease;
}
/* 880 e já não 760: entre as duas, as âncoras cabiam mas empurravam uma
   porta contra o bordo. Uma âncora de secção que empurra uma porta vale
   menos do que a porta — e está repetida no rodapé. */
@media (min-width: 880px) { .cabecalho-ligacoes { display: flex; } }
/* Em /negocios/ estas duas âncoras levariam o dono de negócio para as
   secções da página do CLIENTE. A barra ali tem um trabalho só: as portas. */
body.pagina-negocios .cabecalho-ligacoes { display: none; }

/* --- as duas portas ------------------------------------------------------ */
.portas { display: flex; align-items: center; gap: var(--e-2); flex: 0 0 auto; }

/* Os rótulos longos entram a partir de 480 px, que é o `--coluna` deste
   projecto. Medido no browser com esta folha: o par mais largo é o de
   /negocios/ («Os meus cartões» 147,3 px + «Abrir o balcão»). Abaixo disso
   cedem as palavras acessórias — «Os meus», «Para», «Abrir o» — e nunca as
   portas, que são a razão de a barra existir. */
.porta-curta { display: inline; }
.porta-longa { display: none; }
@media (min-width: 480px) {
  .porta-curta { display: none; }
  .porta-longa { display: inline; }
}

/* O contorno é `--linha-campo` e NÃO `--linha-forte`. Medido com a fórmula
   do scripts/auditar.mjs, com o rgba já composto sobre o papel:
   --linha-forte dá 1,46:1 no claro (#D2D1D0 sobre #FBFAF7) e 1,80:1 no
   escuro. O 1.4.11 da WCAG pede 3:1 ao contorno que identifica um controlo.
   --linha-campo dá 3,37:1 e 3,62:1. Aqui o contorno não é decoração: é o que
   faz a segunda porta ler-se como irmã da primeira. Sem ele, o desenho
   inteiro desfaz-se num botão roxo e num texto solto. */
.porta-app     { background: var(--marca); color: var(--marca-texto); }
.porta-negocio { border-color: var(--linha-campo); color: var(--tinta); }
.porta-balcao  { display: none; }

/* Em /negocios/ a ênfase troca de lado. É só isto. */
body.pagina-negocios .porta-negocio { display: none; }
body.pagina-negocios .porta-balcao {
  display: inline-flex;
  background: var(--marca); color: var(--marca-texto);
}
body.pagina-negocios .porta-app {
  background: none;
  border-color: var(--linha-campo); color: var(--tinta);
}

@media (hover: hover) {
  .cabecalho-ligacoes a:hover { background: var(--veu); color: var(--tinta); }
  .porta-app:hover     { background: var(--marca-cima); }
  .porta-negocio:hover { background: var(--veu); }
  body.pagina-negocios .porta-balcao:hover { background: var(--marca-cima); }
  body.pagina-negocios .porta-app:hover    { background: var(--veu); }
}
```

## 3. `_fonte/estilos/nucleo.css` — três correcções que o cabeçalho obriga

**(a) `.btn` ganha um contorno-base transparente.** Medido: `.btn-contorno` é **3 px mais largo** que as outras variantes, porque só ele declara `border`. Duas pílulas lado a lado com variantes diferentes não alinham, e trocar a variante entre páginas faz a barra saltar. Na regra `.btn` (linha ~231), a seguir a `padding: 0 var(--e-6);`:

```css
  border: 1.5px solid transparent;
```

**(b) `.btn-contorno` passa a `--linha-campo`.** Linha 256, o que sai e o que entra:

```css
/* sai */ .btn-contorno { border: 1.5px solid var(--linha-forte); color: var(--tinta); }
/* entra */ .btn-contorno { border-color: var(--linha-campo); color: var(--tinta); }
```

Isto **não é só do cabeçalho**: o «Tenho um negócio» do herói, o «Ver as perguntas» da `/negocios/` e os `btn-contorno` que o `_fonte/app/app.js` e o `_fonte/balcao/balcao.js` pintam têm todos o mesmo contorno a 1,46:1. Está invisível em todo o lado e ninguém deu por isso — que é precisamente o ponto do comentário que já está escrito no auditor. O `.apelo .btn-contorno` continua a funcionar: declara `border-color` e herda a espessura do `.btn`.

**(c) Cinco fichas novas**, porque a folha não tem uma única regra `:hover` para botões enquanto declara `transition: background-color .2s` — uma transição para um estado que não existe. No `:root`, a seguir a `--marca-texto`:

```css
  --marca-cima:   #4A28C4;   /* rato em cima: o roxo desce um degrau */
  --marca-baixo:  #3E21A4;   /* carregado */
  --veu:          rgba(23, 22, 28, .05);
  --veu-forte:    rgba(23, 22, 28, .09);
```

E **nos dois blocos escuros** (o do `prefers-color-scheme` e o do `:root[data-tema="escuro"]` — o auditor reprova se se separarem):

```css
  --marca-cima:   #AE99FF;   /* no escuro clareia em vez de escurecer */
  --marca-baixo:  #BFAFFF;
  --veu:          rgba(255, 255, 255, .07);
  --veu-forte:    rgba(255, 255, 255, .12);
```

Contrastes calculados com a fórmula do auditor: branco sobre `#4A28C4` = **8,78:1**; branco sobre `#3E21A4` = **10,72:1**; `#0E0D12` sobre `#AE99FF` = **8,11:1**; sobre `#BFAFFF` = **9,95:1**. Todos melhores do que o `#5A31E8` actual (6,91:1).

E as variantes globais, no fim do bloco dos botões:

```css
@media (hover: hover) {
  .btn-cheio:hover    { background: var(--marca-cima); }
  .btn-contorno:hover { background: var(--veu); }
  .btn-suave:hover    { background: var(--veu-forte); }
  .btn-fantasma:hover { background: var(--veu); color: var(--tinta); }
}
.btn-cheio:active { background: var(--marca-baixo); }
```

**Armadilha a fechar ao mesmo tempo:** `site.css:231` tem `.apelo .btn-cheio { background: var(--papel) }`. Sem o par correspondente, o botão branco dentro do painel escuro ficava **roxo** ao passar o rato. Em `site.css`:

```css
@media (hover: hover) {
  .apelo .btn-cheio:hover    { background: color-mix(in srgb, var(--papel) 90%, var(--tinta)); }
  .apelo .btn-contorno:hover { background: rgba(255, 255, 255, .12); }
}
```

## 4. `scripts/auditar.mjs` — para não voltar a partir-se

A lista `PARES` (linha ~510) já obriga `--linha-campo` a estar acima de 3 sobre `--papel` e `--papel-2`, mas **exclui `--papel-3`** — que é exactamente o fundo das `.faixa-recuada` onde há botões de contorno na `/`. Medi: 3,09:1 no claro e 3,05:1 no escuro. Passa, mas por pouco, e é isso que justifica medi-lo. Troca-se:

```js
/* sai */  ...PAPEIS.filter((f) => f !== 'papel-3').map((f) => ['linha-campo', f, 3]),
/* entra */ ...PAPEIS.map((f) => ['linha-campo', f, 3]),
```

---

## Verificado no browser, não lido no código

Construí a proposta sobre uma cópia do `_site` real, servi-a em `http://localhost:8971` e medi. Não é uma simulação da folha de estilos — é a folha.

- **Sem transbordo horizontal** a 320, 360, 375, 390, 414, 430, 480, 560, 720, 760, 880, 1024, 1120 e 1280 px, nas duas páginas.
- **As duas portas presentes em todas essas larguras**, sempre com **44 px** de altura. A barra fica em **68 px** (12 + 44 + 12) em todas.
- Margem ao bordo de **20 px** em todas as larguras (a mesma do `.dentro`, por isso o logótipo alinha com o conteúdo por baixo).
- Rótulos: abaixo de 480 «Cartões · Negócios» (e «Cartões · Balcão» na `/negocios/`); a partir de 480 os longos; a partir de 560 volta o nome por extenso; a partir de 880 entram «Como funciona · Perguntas».
- **Ordem de tabulação**, lida do DOM: `Saltar para o conteúdo → marca → Como funciona → Perguntas → Os meus cartões → Para negócios → conteúdo`. A `.porta-balcao` sai com `display: none` — não está na tabulação nem na árvore.
- **Foco com Tab** (carregado mesmo, não `.focus()` programático): `outline: 2px solid var(--marca)` com 2 px de folga, e a pílula **mantém a forma** — `border-radius` computado = `999px`, porque `.btn` vem depois de `:focus-visible` no `nucleo.css` e ganha por ordem de origem.
- **Modo escuro**: contorno a 3,62:1 e a pílula cheia com `#0E0D12` sobre `#9A80FF` a 6,36:1. Confirmado com `prefers-color-scheme: dark` emulado.
- **`.apelo`**: os dois botões passam a ter larguras de caixa iguais (acabou o salto de 3 px) e o contorno translúcido de dentro do painel escuro continua a ganhar.

Falta uma coisa que não consegui provar no ecrã e digo-o em vez de a afirmar: `nucleo.css` tem `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important } }`, e a linha do cabeçalho é `animation: cabecalho-linha; animation-timeline: scroll()` **sem** `!important`. Pela cascata, quem tem movimento reduzido ligado nunca vê a linha. Uma animação ligada ao scroll não se mexe sozinha — o estado segue o dedo de quem rola — por isso devolvê-la é correcto, mas **tem de ser vista no ecrã com a preferência ligada** antes de se dar por feita, porque a interacção entre o atalho `animation` e o `animation-timeline` é o género de coisa que a leitura do CSS acerta e o ecrã desmente:

```css
@media (prefers-reduced-motion: reduce) {
  .cabecalho { animation-name: cabecalho-linha !important; animation-timeline: scroll() !important; }
}
```

---

## As contradições entre as lentes, resolvidas

| Contradição | Decisão | Porquê |
|---|---|---|
| «Aceder» (empresas) vs. «Os meus cartões» (cabeçalho) vs. veto (não-copiar) | **Veto ganha.** «Os meus cartões». | O `PLANO-LOGIN.md:20` já decidiu que não há portão. A lente não-copiar tem direito de veto e usou-o bem. |
| Cheio = negócio (empresas) vs. cheio = cliente (cabeçalho) | **Cheio = a audiência da página.** | A regra que medi no próprio Fresha, e a única que não põe o cabeçalho a discordar do herói. |
| Uma barra (cabeçalho) vs. dois blocos com marcador no gerador (empresas) | **Uma barra, classe no `<body>`.** | O mecanismo já existe (`gerar.mjs:429`). Dois blocos é dívida por antecipação. |
| Menu ☰ com `<details>` (simplicidade) vs. sem menu (cabeçalho, não-copiar) | **Sem menu.** | Com quatro páginas não há nada para esconder. Um `<details>` não fecha com Escape nem devolve o foco ao botão — o Fresha faz as duas coisas bem, e a comparação seria desfavorável. |
| Manter três âncoras (hoje) vs. duas (cabeçalho) | **Duas, e nenhuma na `/negocios/`.** | «Para negócios» virou pílula; as outras duas levariam o dono de negócio para a página do cliente. |
| Botões a preto como o Fresha (visual, e a própria lente recusa) | **Fica o roxo.** | O `#141414` deles funciona porque as fotografias fazem o trabalho da cor. Sem fotografias, o site ficava sem cor nenhuma — e o roxo é a anilina do carimbo, é a metáfora do produto. |

---

# (a) O que se faz agora

**Por esta ordem.** As três primeiras são uma peça só e publicam-se juntas.

**A1. O cabeçalho.** Ficheiros: `_fonte/parciais/cabecalho.html` (completo acima), `_fonte/estilos/site.css` (linhas 33–53 substituídas), `_fonte/estilos/nucleo.css` (3a, 3b, 3c), `_fonte/paginas/negocios.html` (`classe: pagina-negocios`), `scripts/auditar.mjs` (`PARES`).
*Como se confirma:* `node scripts/auditar.mjs` passa; e as medições da secção anterior repetidas — 320/375/480/560/880/1280, nas duas páginas, nos dois temas, com Tab a acender as duas pílulas sem lhes esquadrar a forma.

**A2. Um nome por porta.** Ficheiros e substituições exactas:
- `_fonte/parciais/rodape.html:15` — «Abrir a app» → **«Os meus cartões»**; linha 17 — «Entrar no balcão» → **«Abrir o balcão»**.
- `_fonte/paginas/inicio.html:17` e o apelo final — «Abrir a minha carteira» → **«Abrir os meus cartões»**.
- `_fonte/paginas/inicio.html:167` — «Experimentar o balcão» → **«Abrir o balcão»**.
- `_fonte/paginas/negocios.html:17` — «Experimentar o balcão» → **«Abrir o balcão»**.
- `_fonte/paginas/404.html:16` — «Abrir a minha carteira» → **«Abrir os meus cartões»**, e acrescenta-se uma terceira saída: `<a class="btn btn-contorno" href="{{BASE}}/negocios/">Tenho um negócio</a>`. Hoje quem se engana no endereço recebe duas saídas e as duas são do lado do cliente.
*Como se confirma:* `grep -rn "Abrir a app\|Entrar no balcão\|Experimentar o balcão\|a minha carteira" _fonte/` devolve zero linhas.

**A3. Defeito encontrado ao ler a página: a `/negocios/` manda o dono para o FAQ do cliente.** `_fonte/paginas/negocios.html:18` tem `href="{{BASE}}/#perguntas"` — que é a **página inicial**. A `/negocios/` tem o seu próprio acordeão («Perguntas de dono para dono») e **não tem `id` nenhum** (`grep -n 'id=' _fonte/paginas/negocios.html` devolve vazio). Quem carrega em «Ver as perguntas» na página de negócios sai da página e aterra nas perguntas do consumidor.
*Entra:* `id="perguntas"` na `<section>` do acordeão da `/negocios/`, e o botão passa a `href="#perguntas"`.
*Como se confirma:* carregar no botão em `/negocios/` e ficar na mesma página, com o acordeão no ecrã.

**A4. A melhor peça de argumentação está na página errada.** A tabela «Plataformas de fidelização 49,95 €/4 semanas» contra «Carimbo Digital 0 €/sempre» está em `_fonte/paginas/inicio.html:139–166` — a página do **cliente**, que a investigação de SEO mostrou não ser onde está quem decide. E aqui o Fresha é o contra-exemplo perfeito: eles escondem o preço porque 19,95 €/mês é a **objecção** deles. Para nós o preço é o **argumento**, e hoje fazemos o mesmo que eles sem termos a razão deles — a única menção a preço na `/negocios/` é «Nada.» dentro de um `<details>` fechado, ou seja, zero pixels visíveis.
*Sai de `inicio.html`:* o `<div class="preco">` inteiro. Fica no lugar o olho, o `h2` e o parágrafo, mais um `.btn-contorno` «Tenho um negócio» → `/negocios/#preco`.
*Entra em `negocios.html`:* segunda secção, logo a seguir ao herói, com `id="preco"`, `<span class="olho">Quanto custa</span>` e `<h2 class="seccao-titulo-grande">Grátis. E sem asterisco nenhum.</h2>`.
*Sai também do acordeão da `/negocios/`:* a pergunta «Quanto custa?», que passa a ser uma secção. Abre-se o acordeão com «Tenho de instalar alguma coisa?».
*Como se confirma:* `node scripts/auditar.mjs`; e as duas páginas lidas de cima a baixo a 375 px.

**A5. Uma costura de números na `/`.** `inicio.html:132` diz «Os outros cobram **50 € por mês**» e a caixa por baixo diz «49,95 € / **4 semanas**», com a nota a admitir «Cerca de 650 € por ano». Quatro semanas não é um mês: são treze pagamentos por ano, 649,35 €. O título subestima o concorrente e obriga o leitor a resolver a diferença sozinho.
*Entra:* «Os outros cobram quase **650 € por ano**.» — que é o número que a nossa própria nota já dá, e é mais forte.

**A6. A palavra que vendemos não está na página que a vende.** «Fidelidade» aparece zero vezes na `/negocios/`. Três sítios, e é literalmente o nome do que fazemos:
- `titulo:` do bloco `---`: «o cartão de carimbos» → «o cartão de fidelidade».
- Primeira frase do `.entrada-texto` do herói, a nomear a categoria.
- «O que é preciso para começar.» → **«Um programa de fidelidade em cinco minutos.»**

**A7. A objecção mais silenciosa, resolvida com duas linhas.** A `/negocios/` já diz «Não pedimos nada para experimentar» — mas a 92 % da altura da página, onde quase ninguém chega. Sobe para debaixo dos botões do herói, em `--tinta-2`: *«Abre já, com um cartão de exemplo. Não pedimos conta, nem cartão de crédito.»* É o equivalente honesto do «Watch an overview» deles — e melhor, porque o nosso balcão abre mesmo em vez de mostrar um vídeo de si próprio.

**A8. Uma captura do balcão a sério no herói da `/negocios/`.** A página não tem uma única imagem. O que entra é o ecrã **verdadeiro** do leitor com um carimbo a dar — não o ecrã de entrada, não um desenho — cortado pela margem inferior da secção, que é o convite a rolar mais barato que existe. Ficheiro nosso, servido do nosso domínio, com `{{BASE}}` no `src` e texto alternativo que descreve o ecrã, não a marca.

**A9. Um aderente, nomeado.** Se o dono do **Titi BarberShop** autorizar: um cartão curto antes do acordeão, com o nome, «São João da Madeira» e — se ele escrever — uma frase entre aspas assinada. Sem estrelas, sem carrossel, sem percentagens. Um caso verdadeiro e datado vale mais do que vinte testemunhos que repetem «the best salon software». Se ele não autorizar, **não se põe nada** e a página não fica pior.

**A10. O rodapé fecha a ideia.** `_fonte/parciais/rodape.html`: a coluna «Carimbo Digital» parte-se em duas com os títulos a nomear a audiência — **«Para clientes»** (Os meus cartões · Perguntas) e **«Para negócios»** (Para negócios · Abrir o balcão). É a lição do menu ☰ deles (o título nomeia o mundo) aplicada onde não custa JavaScript nenhum. O `.rodape-grelha` passa a `1.4fr 1fr 1fr 1fr` a partir de 720 px.

---

# (b) Quando houver dez ou vinte aderentes

- **A lista de nomes.** Não «mais de 20 negócios» — os nomes e as terras, escritos. Com vinte, uma lista honesta é mais convincente do que «130.000+», porque se pode verificar. É o mesmo lugar da página (antes das perguntas), com conteúdo a sério em vez de um lugar vazio.
- **A grelha de tipos de negócio**, sem links e sem fotografias: café e pastelaria, barbearia, cabeleireiro, unhas, lavagem auto, restauração, ginásio, loja de bairro. Custa um `<ul>` e a `.grelha-3` que já existe. Ganho: quem lê encontra a sua palavra. Faz-se já hoje se se quiser — mas ganha muito quando os nomes reais puderem ser a legenda.
- **Uma página por tipo de negócio — uma, não doze.** Só quando os dados reais mostrarem um tipo destacado, e só com conteúdo próprio. Doze páginas seriam a mesma página com outra morada, que é um erro já registado neste projecto.
- **Números medidos, se algum dia se puderem medir.** Só saídos da nossa base, só irregulares (um número redondo soa a slogan), e só com a data ao lado.

---

# (c) O que se recusa para sempre

1. **«Aceder», «Entrar», «Iniciar sessão»** no cabeçalho enquanto a app e o balcão abrirem sem conta. Não é gosto: é o `PLANO-LOGIN.md` a dizer que não há portão, e um rótulo que promete um portão assusta quem está na fila.
2. **O hambúrguer.** A 375 px o Fresha esconde as duas portas dentro do ☰ (a media query é 768 px) e o gatilho tem 32×32 — abaixo dos 44. Copiar isso era desfazer o pedido.
3. **Qualquer alvo abaixo de 44 px e qualquer rótulo truncado com reticências.** Contei no Fresha ao telemóvel o «Sign up» a 85×36 e o ✕ do menu a 24×24. A promessa de uma classe não vale nada precisamente onde ela é mais precisa, que é o polegar. Se o cabeçalho não couber, corta-se o texto do logótipo — nunca a altura das pílulas.
4. **Números de escala e contadores ao vivo.** O deles subiu de 750 7xx para 751 332 enquanto o mediam — é verdadeiro. O nosso equivalente diria «1», e a tentação seguinte era escolher um denominador maior até o número já não querer dizer nada. Temos um aderente; diz-se um.
5. **Testemunhos que não foram escritos por uma pessoa real com nome e autorização.** Os deles repetem «Fresha is the top salon software» em depoimentos de cidades diferentes. Fabricar dois «no mesmo estilo» é inventar avaliações — e em Portugal isso é prática comercial enganosa.
6. **Qualquer ficheiro servido de fora.** Tipografia, script, estatística, mapa, medalha de avaliação. O `scripts/auditar.mjs` reprova a publicação, e o rodapé deixa de poder dizer «Sem cookies. Sem rastreio. Sem publicidade.» — que é a nossa melhor frase contra quem põe doze cookies antes de perguntar.
7. **Esconder o preço.** É a única coisa em que copiar o Fresha nos custaria mais caro do que não ter site nenhum.
8. **Prometer apoio que não existe** — 24/7, gestor de conta, «award winning». Somos uma pessoa, e o inverso é que vende: fala-se com quem escreveu o código.
9. **Revelar conteúdo ao rolar.** Trinta e oito elementos deles começam a `opacity: 0` à espera do JavaScript. As nossas páginas não correm JavaScript: ficariam invisíveis para sempre.
10. **Uma caixa de pesquisa no herói.** É o produto deles e seria uma sala vazia no nosso — uma pesquisa que devolve um resultado prova que não há nada lá dentro.
11. **Uma página-garfo à entrada** (o `/user-flow` deles). Quem chega pelo QR está de pé com o dono à espera; perguntar-lhe «quem és tu?» antes de mostrar seja o que for é o pior clique que lhe podemos pedir. Resolvemos a mesma ambiguidade de graça, nomeando o destino em vez do acto. *(Nota: uma das lentes relatou que `fresha.com` reencaminha sozinho para `/for-business` ao fim de ~1 s a partir de Portugal. Naveguei o site hoje e **não** reproduzi esse reencaminhamento — não o afirmo como facto. O princípio mantém-se: se algum dia quisermos mandar alguém para o lado certo, é por um link visível.)*
12. **Títulos e `alt` entupidos de palavras-chave.** O `<title>` da página de negócios deles tem 177 caracteres com oito barras verticais — confirmei-o hoje no separador do browser. E um `alt` escrito para a Google é um anúncio lido em voz alta a quem não vê a imagem. Os nossos títulos são frases de gente; trocá-los seria trocar a coisa boa pela má.
13. **Encolher o cabeçalho ao rolar.** Nem eles o fazem, e por boa razão: obriga o olho a reencontrar os botões a cada movimento e obriga o código a um relógio e a uma banda de histerese para não tremer. A nossa barra fica nos 68 px e não se mexe.

---

**O que não se toca, porque já é melhor do que o modelo:** o salto para o conteúdo (o primeiro Tab deles cai no logótipo); o anel de foco (medi nove elementos deles com `outline: 2px solid rgba(0,0,0,0)` — um anel **transparente** — incluindo o «Sign up», que é o botão de conversão mais importante do site deles); o `backdrop-filter` com `saturate`; a linha do cabeçalho sem JavaScript; e o texto — 373 palavras e 10,4 por frase na nossa `/negocios/` contra 3 173 e 19,7 na deles. Se alguma coisa mudar nessa página, que seja para tirar, não para pôr.