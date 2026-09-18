/* =========================================================================
   Carimbo Digital — os emails

   Vive à parte do resto do Worker por duas razões: dá para ver e provar sem
   levantar um servidor (`node scripts/ver-emails.mjs`), e o HTML de email é
   uma linguagem à parte que não convém misturar com a lógica de negócio.

   As regras que mandam aqui, e porquê:

   · TABELAS, não divs. O Outlook para Windows desenha com o motor do Word,
     que não sabe o que é uma caixa moderna. Uma tabela de uma coluna é a
     única coisa que todos os clientes desenham igual. O corpo do email é uma
     tabela e cada parágrafo é uma linha dela — assim o espaço entre as
     partes é `height` numa célula, que o Word respeita, e não `margin`, que
     ele ignora.
   · ESTILOS EM LINHA. O Gmail corta o que está no cabeçalho do documento em
     boa parte dos casos; o que está no atributo `style` sobrevive sempre. O
     bloco `<style>` só serve para o que não se consegue pôr em linha — o
     modo escuro — e o email tem de ficar certo sem ele.
   · SEM IMAGENS no que é essencial. Quase todos os clientes bloqueiam
     imagens até a pessoa carregar em «mostrar». Um email de código cuja
     marca desaparece parece um email falso — e este é justamente o tipo de
     email que os burlões imitam. Por isso a marca é desenhada com HTML.
   · DUAS VERSÕES, HTML e texto. Não é um resto do passado: há clientes que
     só mostram texto, os leitores de ecrã dão-se melhor com ele, e um email
     só-HTML pontua pior nos filtros de spam.
   ========================================================================= */

/* A letra do sistema, pela ordem que cada plataforma entende. Nada de tipos
   de letra da web: metade dos clientes não os carrega e o que aparece é a
   letra por omissão, que raramente é a que se esperava. */
const LETRA = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, "
  + "'Helvetica Neue', Arial, sans-serif";
const LETRA_CODIGO = "'SF Mono', SFMono-Regular, Menlo, Consolas, "
  + "'Courier New', monospace";

/* Modo claro. Todos medidos contra o fundo em que assentam: o mais fraco
   (TINTA_3 no rodapé) dá 4,98 — a norma pede 4,5. O anterior, #8B8895,
   dava 3,32 e não passava; parecia bem no ecrã e não estava. */
/* O endereço do serviço, num sítio só. Estava escrito à mão em três — no
   rodapé do HTML e nas duas versões em texto — e um endereço repetido é um
   endereço à espera de divergir. */
const SITIO = 'carimbodigital.pt';

const TINTA = '#17161C';
const TINTA_2 = '#5B5966';
const TINTA_3 = '#6E6B79';
const MARCA = '#5A31E8';
const MARCA_FUNDO = '#EFEAFE';
const PAPEL = '#FBFAF7';
const LINHA = '#E7E4DD';
/* Não é branco: é branco menos um ponto de azul. Alguns clientes (o
   Outlook.com, o Gmail no Android) invertem à força o que for #FFFFFF
   exacto quando o telemóvel está em modo escuro, e passam por cima do que
   nós dizemos. Um valor a um passo do branco escapa a essa regra e fica
   indistinguível do branco a olho. */
const BRANCO = '#FFFFFE';

/** Escapa o que vier de fora e vá parar ao HTML. */
function seguro(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* =========================================================================
   A marca, desenhada
   Quatro casas: três carimbadas e uma por carimbar. Cada casa é uma célula
   de tabela pintada com `bgcolor` — não um div com largura em CSS, que o
   motor do Word não desenha. No Outlook o canto redondo não pega e as casas
   saem quadradas; continua a ler-se como a marca, que é o que interessa
   quando a alternativa é não aparecer nada.

   As duas casas têm de ocupar exactamente o mesmo espaço, senão a grelha
   entorta. A cheia é 13 px com 2 px de folga à volta; a vazia é 13 px com
   2 px de contorno. Dezassete de fora nas duas, com ou sem `box-sizing` —
   que também não existe no Word.
   ========================================================================= */

function marca() {
  const cheia = `<td class="ponto-cheio" width="13" height="13" bgcolor="${BRANCO}"`
    + ` style="width:13px;height:13px;padding:2px;background:${BRANCO};`
    + `border-radius:13px;line-height:13px;font-size:0">&nbsp;</td>`;

  /* Cor sólida, não rgba(): o motor do Word não sabe o que isso é e o que
     sai é preto. #B4A2F4 é branco a 55% por cima do roxo da marca, já
     misturado. */
  const vazia = `<td class="ponto-vazio" width="13" height="13"`
    + ` style="width:13px;height:13px;padding:0;border:2px solid #B4A2F4;`
    + `border-radius:13px;line-height:13px;font-size:0">&nbsp;</td>`;

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"`
    + ` style="border-collapse:separate;border-spacing:0">`
    + `<tr><td class="marca-caixa" width="42" height="42" align="center" valign="middle"`
    + ` bgcolor="${MARCA}" style="width:42px;height:42px;background:${MARCA};`
    + `border-radius:11px">`
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0"`
    + ` style="border-collapse:separate;border-spacing:0">`
    + `<tr>${cheia}${cheia}</tr>`
    + `<tr>${cheia}${vazia}</tr>`
    + `</table></td>`
    /* O espaçamento entre letras vai em px, não em em: o Word lê o número e
       ignora a unidade `em`, e -0,02 vira -0,02 pt, ou seja nada. */
    + `<td class="t1" style="padding-left:12px;font-family:${LETRA};font-size:17px;`
    + `letter-spacing:-0.3px;color:${TINTA};white-space:nowrap;`
    + `mso-line-height-rule:exactly">`
    + `<b style="font-weight:800">Carimbo</b> `
    + `<span class="t2" style="font-weight:500;color:${TINTA_2}">Digital</span>`
    + `</td></tr></table>`;
}

/* =========================================================================
   O bloco do código
   É a única coisa que a pessoa veio aqui buscar. Grande, espaçado, e com os
   algarismos em três e três — é assim que se lê um número em voz alta e é
   assim que se copia sem enganos.
   ========================================================================= */

function blocoCodigo(codigo) {
  const limpo = String(codigo).replace(/\D/g, '');
  /* OS ALGARISMOS FICAM COLADOS, e isso é por causa do teclado.
     
     Havia aqui um `&#160;` a meio, para o código se ler em dois grupos de
     três — mais fácil de decorar do balcão para o campo. Mas é o iOS e o
     Android que lêem este email para OFERECEREM o código por cima do teclado,
     e o que eles procuram é uma sequência de dígitos CONTÍGUA perto de uma
     palavra como «código». Com o espaço a meio, o que lá está são dois
     números de três algarismos e não um de seis, e a sugestão não aparece.
     
     A legibilidade não se perde: o espaço passa a ser `letter-spacing`, que é
     desenho e não texto — o detector não o vê, e o olho vê-o na mesma. */
  /* Os algarismos separados por espaço para o leitor de ecrã os dizer um a
     um, em vez de anunciar «trezentos e dezoito mil». */
  const soletrado = limpo.split('').join(' ');

  return `<tr><td style="padding:0">`
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"`
    + ` style="width:100%;border-collapse:separate;border-spacing:0">`
    + `<tr><td class="codigo-caixa" align="center" bgcolor="${MARCA_FUNDO}"`
    + ` style="padding:26px 16px;background:${MARCA_FUNDO};border-radius:14px">`
    /* 36 px com 7 px de espaçamento: seis algarismos dão cerca de 190 px,
       que cabem à larga num ecrã de 320 px. Maior do que isto parece melhor
       no computador e parte no telemóvel — e é no telemóvel que isto vai
       ser lido. */
    + `<div class="codigo" style="font-family:${LETRA_CODIGO};font-size:36px;`
    + `font-weight:700;letter-spacing:7px;color:${TINTA};line-height:1.15;`
    + `white-space:nowrap;mso-line-height-rule:exactly"`
    + ` aria-label="${soletrado}">${limpo}</div>`
    + `</td></tr></table></td></tr>`;
}

/* =========================================================================
   As linhas do corpo
   Devolvem `<tr>` inteiros: o corpo é uma tabela, e o espaço entre as
   partes é uma célula com altura — não uma margem, que o Word não vê.
   ========================================================================= */

const TEXTO_BASE = `font-family:${LETRA};mso-line-height-rule:exactly`;

const h1 = (texto) =>
  `<tr><td class="t1" style="${TEXTO_BASE};font-size:24px;font-weight:800;`
  + `letter-spacing:-0.5px;line-height:1.25;color:${TINTA}">${texto}</td></tr>`;

const p = (texto) =>
  `<tr><td class="t2" style="${TEXTO_BASE};font-size:16px;line-height:1.6;`
  + `color:${TINTA_2}">${texto}</td></tr>`;

const miudo = (texto) =>
  `<tr><td class="t3" style="${TEXTO_BASE};font-size:14px;line-height:1.6;`
  + `color:${TINTA_3}">${texto}</td></tr>`;

const espaco = (altura) =>
  `<tr><td height="${altura}" style="height:${altura}px;line-height:${altura}px;`
  + `font-size:0">&nbsp;</td></tr>`;

const risca = () =>
  `<tr><td class="risca" height="1" bgcolor="${LINHA}" style="height:1px;`
  + `background:${LINHA};line-height:1px;font-size:0">&nbsp;</td></tr>`;

/* =========================================================================
   O molde
   ========================================================================= */

/* A razão por que o email chegou. Vai no rodapé, e é diferente conforme o
   email: dizer «alguém pediu um código nesta morada» num aviso que ninguém
   pediu é escrever uma falsidade no sítio onde a pessoa vai procurar se isto
   é a sério. */
const PORQUE_RECEBEU = 'Este email foi enviado porque alguém pediu um código '
  + 'nesta morada. Não enviamos publicidade.';

function molde({ titulo, preheader, corpo, entidade, porque = PORQUE_RECEBEU }) {
  const e = {
    nome: 'Renato Lima Valente',
    sitio: SITIO,
    ...entidade,
  };

  return `<!doctype html>
<html lang="pt-PT" xmlns="http://www.w3.org/1999/xhtml"
      xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${seguro(titulo)}</title>

<!-- Sem isto o Outlook para Windows desenha tudo a 120 pontos por polegada e
     o email aparece um quarto maior do que foi desenhado. -->
<!--[if mso]>
<xml><o:OfficeDocumentSettings>
  <o:AllowPNG/>
  <o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings></xml>
<style>
  .codigo { font-family: Consolas, 'Courier New', monospace !important; }
</style>
<![endif]-->

<style>
  /* O modo escuro a sério, para os clientes que perguntam ao sistema em vez
     de inverterem as cores à bruta: Apple Mail, Mail do iPhone, Outlook do
     Mac. Os que invertem sozinhos (Gmail no Android) ignoram isto e fazem à
     maneira deles — daí as cores em linha terem de ficar certas por si.

     Vai tudo com !important porque um estilo em linha ganha sempre a uma
     regra do cabeçalho, e é precisamente o estilo em linha que queremos
     substituir aqui. */
  @media (prefers-color-scheme: dark) {
    .pagina    { background: #0E0D12 !important; }
    .cartao    { background: #17161C !important; border-color: #2E2B37 !important; }
    .t1        { color: #F4F2F7 !important; }
    .t2        { color: #A9A6B4 !important; }
    .t3, .t3 a { color: #918E9B !important; }
    /* Uma palavra destacada dentro de um parágrafo. Em claro é a tinta cheia;
       sem esta linha, em escuro ficava tinta escura sobre fundo escuro e a
       frase desaparecia do meio do texto — invisível, não ilegível. */
    .forte     { color: #F4F2F7 !important; }
    .risca     { background: #2E2B37 !important; }
    .codigo-caixa { background: #241D46 !important; }
    .codigo    { color: #F4F2F7 !important; }
    .marca-caixa  { background: #6B45F0 !important; }
    .ponto-vazio  { border-color: #CBBFF8 !important; }
  }
</style>
</head>
<body class="pagina" style="margin:0;padding:0;background:${PAPEL};
      -webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">

<!-- O pré-cabeçalho: o que aparece na lista de mensagens ao lado do assunto.
     Sem isto, o cliente de email vai buscar a primeira frase que encontrar,
     que costuma ser o nome da marca ou um pedaço de rodapé.

     A fieira de caracteres invisíveis no fim serve para empurrar o resto: sem
     ela, o cliente enche o que sobra da pré-visualização com o texto que vem
     a seguir, e a linha acaba a meio de uma frase do corpo. -->
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">
${seguro(preheader)}
&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
       class="pagina" bgcolor="${PAPEL}"
       style="border-collapse:separate;border-spacing:0;background:${PAPEL}">
<tr><td align="center" style="padding:32px 14px">

  <!-- Largura à prova de tudo.

       Uma tabela com width="560" não encolhe num telemóvel: o atributo ganha
       ao max-width e o email fica a transbordar para fora do ecrã — foi
       exactamente o que aconteceu na primeira versão, e a maior parte das
       pessoas lê isto no telemóvel.

       A forma que funciona em todo o lado é esta: a tabela a 100% com um
       max-width, e uma tabela-fantasma só para o Outlook, que ignora o
       max-width mas obedece ao comentário condicional. O Outlook vê 560 px
       fixos; toda a gente vê uma tabela que encolhe. -->
  <!--[if mso]>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" align="center">
  <tr><td>
  <![endif]-->

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
         style="width:100%;max-width:560px;border-collapse:separate;border-spacing:0;margin:0 auto">

    <tr><td style="padding-bottom:24px">${marca()}</td></tr>

    <tr><td class="cartao" bgcolor="${BRANCO}"
            style="background:${BRANCO};border:1px solid ${LINHA};border-radius:18px;
                   padding:32px 26px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
             style="width:100%;border-collapse:separate;border-spacing:0">
${corpo}
      </table>
    </td></tr>

    <!-- Só o nome e o sítio. A identificação completa — número de
         contribuinte, morada — está nas páginas legais do site, onde a lei a
         quer; num email de código não faz falta a ninguém e espalha os dados
         de um particular por caixas de correio que não os pediram. -->
    <tr><td class="t3" style="padding:22px 6px 0;font-family:${LETRA};font-size:12px;
                   line-height:1.65;color:${TINTA_3};mso-line-height-rule:exactly">
      ${seguro(e.nome)} ·
      <a href="https://${seguro(e.sitio)}" style="color:${TINTA_3};text-decoration:underline">${seguro(e.sitio)}</a><br>
      ${seguro(porque)}
    </td></tr>

  </table>

  <!--[if mso]>
  </td></tr>
  </table>
  <![endif]-->

</td></tr>
</table>
</body>
</html>`;
}

/* =========================================================================
   Os dois emails
   ========================================================================= */

/** Código para o cliente guardar a conta e recuperar os cartões. */
export function emailCodigoCliente({ codigo, minutos = 15, entidade } = {}) {
  const codigoLimpo = String(codigo).replace(/\D/g, '');

  const corpo = [
    h1('O teu código'),
    espaco(14),
    p('Escreve-o na app para guardares os teus cartões. Assim, se mudares de '
      + 'telemóvel, eles vão contigo.'),
    espaco(22),
    blocoCodigo(codigoLimpo),
    espaco(20),
    p(`Vale ${minutos} minutos e só serve uma vez.`),
    espaco(24),
    risca(),
    espaco(18),
    miudo('Se não foste tu a pedir isto, ignora este email — não acontece nada, '
      + 'e o código deixa de valer sozinho.'),
  ].join('\n');

  return {
    /* Ver o comentário no `emailCodigoBalcao`: a palavra «código» vai colada
       aos algarismos, nos dois sítios que aparecem na notificação, porque é
       isso que o telemóvel lê para oferecer o código por cima do teclado. */
    assunto: `Código ${codigoLimpo} — Carimbo Digital`,
    html: molde({
      titulo: 'O teu código Carimbo Digital',
      preheader: `O teu código é ${codigoLimpo}. Escreve-o na app. `
        + `Vale ${minutos} minutos.`,
      corpo,
      entidade,
    }),
    texto: [
      'O teu código Carimbo Digital',
      '',
      `O teu código é ${codigoLimpo}`,
      '',
      'Escreve-o na app para guardares os teus cartões. Assim, se mudares de',
      'telemóvel, eles vão contigo.',
      '',
      `Vale ${minutos} minutos e só serve uma vez.`,
      '',
      'Se não foste tu a pedir isto, ignora este email — não acontece nada, e o',
      'código deixa de valer sozinho.',
      '',
      '—',
      `Carimbo Digital · ${SITIO}`,
    ].join('\n'),
  };
}

/**
 * Aviso de que a conta vai ser apagada por estar parada.
 *
 * Escrito para ser lido por quem não se lembra de ter isto. Por isso diz o que
 * é, quanto tempo falta, e o que fazer — que é uma coisa só: abrir a app. Não
 * pede que se carregue em lado nenhum: um email que manda clicar num botão
 * para «manter a conta activa» é exactamente a forma de um email de burla, e
 * este vai para pessoas que não falam com o serviço há dois anos.
 *
 * Também não leva ligação para apagar já. Quem quiser apagar tem o botão no
 * perfil, e uma ligação de apagar num email é uma ligação que qualquer pessoa
 * que leia o email por cima do ombro pode carregar.
 */
export function emailContaAApagar({ dias = 30, meses = 24, entidade } = {}) {
  const corpo = [
    h1('Os teus carimbos vão desaparecer'),
    espaco(14),
    p(`Há ${meses} meses que ninguém abre esta conta do Carimbo Digital e `
      + 'ninguém lhe carimba um cartão. Guardar dados de quem já não os usa é '
      + 'coisa que não se faz — por isso vamos apagá-la.'),
    espaco(18),
    p(`<strong class="forte" style="color:${TINTA}">Tens ${dias} dias.</strong> Para a `
      + 'manteres, basta abrires a app: mais nada, e não é preciso carregar em '
      + 'coisa nenhuma neste email.'),
    espaco(22),
    risca(),
    espaco(18),
    miudo('Quando a conta for apagada, vão com ela os cartões, os carimbos e os '
      + 'prémios por levantar. Não há como os trazer de volta.'),
    espaco(10),
    /* O PASSE DA APPLE FICA, E ISSO TEM DE SER DITO AQUI. Quem recebe este
       email não carregou em botão nenhum — vai ser apagado por inactividade —
       e este é o único aviso que recebe. Um `.pkpass` não tem serviço web, por
       isso não há como o tirar do telemóvel a partir daqui: fica lá com o
       saldo velho e deixa de carimbar. Calar isso era deixar a pessoa com um
       cartão morto na carteira e nenhuma pista do que aconteceu. */
    miudo('Se guardaste algum cartão na Carteira do iPhone, apaga-o também lá: '
      + 'esse fica no telemóvel e nós não conseguimos tirá-lo de lá.'),
    espaco(10),
    miudo(`Se preferires apagá-la já, está no perfil da app, em «Apagar a conta».`),
  ].join('\n');

  return {
    assunto: `A tua conta Carimbo Digital vai ser apagada em ${dias} dias`,
    html: molde({
      titulo: 'A tua conta Carimbo Digital vai ser apagada',
      preheader: `Abre a app nos próximos ${dias} dias e fica tudo como estava.`,
      corpo,
      entidade,
      porque: 'Este email foi enviado porque esta morada está ligada a uma conta '
        + 'do Carimbo Digital que vai ser apagada. Não enviamos publicidade.',
    }),
    texto: [
      'Os teus carimbos vão desaparecer',
      '',
      `Há ${meses} meses que ninguém abre esta conta do Carimbo Digital e`,
      'ninguém lhe carimba um cartão. Guardar dados de quem já não os usa é',
      'coisa que não se faz — por isso vamos apagá-la.',
      '',
      `Tens ${dias} dias. Para a manteres, basta abrires a app: mais nada, e`,
      'não é preciso carregar em coisa nenhuma neste email.',
      '',
      'Quando a conta for apagada, vão com ela os cartões, os carimbos e os',
      'prémios por levantar. Não há como os trazer de volta.',
      '',
      'Se preferires apagá-la já, está no perfil da app, em «Apagar a conta».',
      '',
      '—',
      `Carimbo Digital · ${SITIO}`,
    ].join('\n'),
  };
}

/** Código para quem manda no negócio entrar no balcão. */
export function emailCodigoBalcao({ codigo, minutos = 15, negocio, entidade } = {}) {
  const codigoLimpo = String(codigo).replace(/\D/g, '');
  const onde = negocio ? ` de ${seguro(negocio)}` : '';

  const corpo = [
    h1('Entrar no balcão'),
    espaco(14),
    p(`Escreve este código no telemóvel do balcão${onde}.`),
    espaco(22),
    blocoCodigo(codigoLimpo),
    espaco(20),
    p(`Vale ${minutos} minutos e só serve uma vez.`),
    espaco(24),
    risca(),
    espaco(18),
    miudo('Se não foste tu, ignora este email. Ninguém entra no teu balcão sem '
      + 'este código.'),
  ].join('\n');

  return {
    /* A PALAVRA «CÓDIGO» TEM DE ESTAR COLADA AOS ALGARISMOS, e isto não é
       estilo: é o que decide se o telemóvel oferece o código por cima do
       teclado ou se a pessoa o escreve à mão.

       Até ao iOS 18 isto só funcionava com o Mail da Apple. No iOS 26 passou a
       funcionar com o Gmail e o resto — mas lendo o TEXTO DA NOTIFICAÇÃO, à
       procura de um padrão do género «o teu código de verificação é 123456».

       O que estava aqui era `123840 — entrar no Carimbo Digital Balcão` e
       `Escreve 123840 no telemóvel do balcão`. Em nenhum dos dois a palavra
       «código» aparece ao pé do número: um traz o número solto seguido de um
       travessão, o outro traz um verbo. Foi visto numa captura de um iPhone a
       sério, com a notificação do Gmail em cima do ecrã e a barra do teclado
       vazia por baixo. */
    assunto: `Código ${codigoLimpo} — entrar no Carimbo Digital Balcão`,
    html: molde({
      titulo: 'Entrar no Carimbo Digital Balcão',
      preheader: `O teu código é ${codigoLimpo}. Escreve-o no telemóvel do balcão. `
        + `Vale ${minutos} minutos.`,
      corpo,
      entidade,
    }),
    texto: [
      'Entrar no Carimbo Digital Balcão',
      '',
      `O teu código é ${codigoLimpo}`,
      '',
      `Escreve este código no telemóvel do balcão${negocio ? ` de ${negocio}` : ''}.`,
      `Vale ${minutos} minutos e só serve uma vez.`,
      '',
      'Se não foste tu, ignora este email. Ninguém entra no teu balcão sem este',
      'código.',
      '',
      '—',
      `Carimbo Digital · ${SITIO}`,
    ].join('\n'),
  };
}

/**
 * «Puseram-te no balcão do X.»
 *
 * NÃO LEVA CÓDIGO NENHUM, e isso é de propósito. Um código dentro de um email
 * de convite é um código que fica na caixa de correio de alguém à espera de
 * ser usado por quem lá chegar; e este email pode ficar por abrir uma semana.
 * O que ele traz é o caminho — abre o balcão, escreve esta morada, e o código
 * chega nesse momento, a valer quinze minutos. Uma volta a mais, e uma coisa
 * a menos para correr mal.
 *
 * Também não traz botão. O balcão vive num endereço que se escreve à mão uma
 * vez e fica no ecrã principal do telemóvel; um botão num email leva-o a abrir
 * dentro do cliente de correio, que é precisamente onde ele não deve viver.
 */
export function emailConviteOperador({ negocio, quem, entidade } = {}) {
  const onde = negocio ? seguro(negocio) : 'um balcão';
  const porQuem = quem ? ` ${seguro(quem)}` : ' alguém';

  const corpo = [
    h1('Já podes carimbar'),
    espaco(14),
    p(`${porQuem} juntou-te ao balcão de <strong class="forte" `
      + `style="color:${TINTA}">${onde}</strong> no Carimbo Digital. `
      + 'A partir de agora podes carimbar os cartões dos clientes com o teu '
      + 'próprio telemóvel.'),
    espaco(20),
    p(`<strong class="forte" style="color:${TINTA}">Abre ${SITIO}/balcao/</strong> `
      + 'e entra com esta morada de email. Chega-te um código nesse momento.'),
    espaco(18),
    p('Depois de entrares, guarda a página no ecrã principal: passa a abrir '
      + 'como uma aplicação e não tens de voltar a escrever o endereço.'),
    espaco(24),
    risca(),
    espaco(18),
    miudo('Cada carimbo que deres fica com o teu nome no histórico do cartão — '
      + 'é assim que o balcão sabe quem atendeu.'),
    espaco(10),
    miudo('Não te pedimos palavra-passe nenhuma: entra-se sempre com um código '
      + 'que chega a esta morada.'),
    espaco(10),
    miudo('Se isto não te diz nada, ignora este email. Sem o código, ninguém '
      + 'entra em balcão nenhum.'),
  ].join('\n');

  return {
    assunto: `Já podes carimbar no balcão de ${negocio || 'um negócio'}`,
    html: molde({
      titulo: 'Já podes carimbar',
      preheader: `Abre ${SITIO}/balcao/ e entra com esta morada de email.`,
      corpo,
      entidade,
      porque: 'Este email foi enviado porque esta morada foi junta ao balcão de '
        + 'um negócio no Carimbo Digital. Não enviamos publicidade.',
    }),
    texto: [
      'Já podes carimbar',
      '',
      `${quem || 'Alguém'} juntou-te ao balcão de ${negocio || 'um negócio'} no`,
      'Carimbo Digital. A partir de agora podes carimbar os cartões dos',
      'clientes com o teu próprio telemóvel.',
      '',
      `Abre ${SITIO}/balcao/ e entra com esta morada de email. Chega-te um`,
      'código nesse momento.',
      '',
      'Depois de entrares, guarda a página no ecrã principal: passa a abrir',
      'como uma aplicação e não tens de voltar a escrever o endereço.',
      '',
      'Cada carimbo que deres fica com o teu nome no histórico do cartão.',
      '',
      'Se isto não te diz nada, ignora este email.',
      '',
      '—',
      `Carimbo Digital · ${SITIO}`,
    ].join('\n'),
  };
}
