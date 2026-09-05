/* =========================================================================
   Carimbo Digital — os emails

   Vive à parte do resto do Worker por duas razões: dá para ver e provar sem
   levantar um servidor (`node scripts/ver-emails.mjs`), e o HTML de email é
   uma linguagem à parte que não convém misturar com a lógica de negócio.

   As regras que mandam aqui, e porquê:

   · TABELAS, não divs. O Outlook para Windows desenha com o motor do Word,
     que não sabe o que é uma caixa moderna. Uma tabela de uma coluna é a
     única coisa que todos os clientes desenham igual.
   · ESTILOS EM LINHA. O Gmail corta o que está no cabeçalho do documento em
     boa parte dos casos; o que está no atributo `style` sobrevive sempre.
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
const LETRA_CODIGO = "'SF Mono', SFMono-Regular, ui-monospace, 'Cascadia Mono', "
  + "'Roboto Mono', Menlo, Consolas, 'Courier New', monospace";

const TINTA = '#17161C';
const TINTA_2 = '#5B5966';
const TINTA_3 = '#8B8895';
const MARCA = '#5A31E8';
const MARCA_FUNDO = '#EFEAFE';
const PAPEL = '#FBFAF7';
const LINHA = '#E7E4DD';

/** Escapa o que vier de fora e vá parar ao HTML. */
function seguro(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* =========================================================================
   A marca, desenhada
   Quatro casas: três carimbadas e uma por carimbar. Cada casa é uma célula
   de tabela com um bloco redondo lá dentro. No Outlook o canto redondo não
   pega e as casas saem quadradas — continua a ler-se como a marca, que é o
   que interessa quando a alternativa é não aparecer nada.
   ========================================================================= */

function marca() {
  const casa = (cheia) => `<td width="13" style="padding:2px;line-height:0">`
    + `<div style="width:13px;height:13px;border-radius:13px;`
    + (cheia
      ? `background:#FFFFFF"`
      /* Cor sólida, não rgba(): o motor do Word não sabe o que isso é e o
         que sai é preto. #B4A2F4 é branco a 55% por cima do roxo da marca,
         já misturado. */
      : `border:2px solid #B4A2F4;box-sizing:border-box"`)
    + `>&nbsp;</div></td>`;

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"`
    + ` style="border-collapse:collapse">`
    + `<tr><td width="42" height="42" align="center" valign="middle"`
    + ` style="width:42px;height:42px;background:${MARCA};border-radius:11px">`
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0"`
    + ` style="border-collapse:collapse">`
    + `<tr>${casa(true)}${casa(true)}</tr>`
    + `<tr>${casa(true)}${casa(false)}</tr>`
    + `</table></td>`
    + `<td style="padding-left:12px;font-family:${LETRA};font-size:17px;`
    + `letter-spacing:-.02em;color:${TINTA};white-space:nowrap">`
    + `<b style="font-weight:800">Carimbo</b> `
    + `<span style="font-weight:500;color:${TINTA_2}">Digital</span>`
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
  const agrupado = limpo.length === 6
    ? `${limpo.slice(0, 3)} ${limpo.slice(3)}`
    : limpo;
  /* Os algarismos separados por espaço para o leitor de ecrã os dizer um a
     um, em vez de anunciar «trezentos e dezoito mil». */
  const soletrado = limpo.split('').join(' ');

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"`
    + ` style="border-collapse:collapse">`
    + `<tr><td align="center" style="padding:28px 16px;background:${MARCA_FUNDO};`
    + `border-radius:14px">`
    /* 34 px com 0,1em de espaçamento: sete caracteres dão cerca de 250 px,
       que cabem no cartão mesmo num ecrã de 320 px. Maior do que isto parece
       melhor no computador e parte no telemóvel — e é no telemóvel que isto
       vai ser lido. `white-space:nowrap` garante que os dois grupos nunca se
       separam por linhas. */
    + `<div style="font-family:${LETRA_CODIGO};font-size:34px;font-weight:700;`
    + `letter-spacing:.1em;color:${TINTA};line-height:1.15;white-space:nowrap"`
    + ` aria-label="${soletrado}">${agrupado}</div>`
    + `</td></tr></table>`;
}

/* =========================================================================
   O molde
   ========================================================================= */

function molde({ titulo, preheader, corpo, entidade }) {
  const e = {
    nome: 'Renato Lima Valente',
    nif: '273363620',
    sitio: 'carimbodigital.pt',
    ...entidade,
  };

  return `<!doctype html>
<html lang="pt-PT">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${seguro(titulo)}</title>
</head>
<body style="margin:0;padding:0;background:${PAPEL};-webkit-text-size-adjust:100%">

<!-- O pré-cabeçalho: o que aparece na lista de mensagens ao lado do assunto.
     Sem isto, o cliente de email vai buscar a primeira frase que encontrar,
     que costuma ser o nome da marca ou um pedaço de rodapé. -->
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">
${seguro(preheader)}
</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
       style="border-collapse:collapse;background:${PAPEL}">
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
         style="width:100%;max-width:560px;border-collapse:collapse;margin:0 auto">

    <tr><td style="padding-bottom:24px">${marca()}</td></tr>

    <tr><td style="background:#FFFFFF;border:1px solid ${LINHA};border-radius:18px;
                   padding:32px 26px">
${corpo}
    </td></tr>

    <tr><td style="padding:22px 6px 0;font-family:${LETRA};font-size:12px;
                   line-height:1.65;color:${TINTA_3}">
      ${seguro(e.nome)} · NIF ${seguro(e.nif)} ·
      <a href="https://${seguro(e.sitio)}" style="color:${TINTA_3};text-decoration:underline">${seguro(e.sitio)}</a><br>
      Este email foi enviado porque alguém pediu um código nesta morada.
      Não enviamos publicidade.
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

const p = (texto, extra = '') =>
  `<p style="margin:0 0 14px;font-family:${LETRA};font-size:16px;line-height:1.6;`
  + `color:${TINTA_2}${extra}">${texto}</p>`;

const h1 = (texto) =>
  `<h1 style="margin:0 0 16px;font-family:${LETRA};font-size:24px;font-weight:800;`
  + `letter-spacing:-.02em;line-height:1.25;color:${TINTA}">${texto}</h1>`;

const risca = () =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"`
  + ` style="border-collapse:collapse"><tr><td height="1"`
  + ` style="height:1px;background:${LINHA};line-height:1px;font-size:0">&nbsp;</td></tr></table>`;

/* =========================================================================
   Os dois emails
   ========================================================================= */

/** Código para o cliente guardar a conta e recuperar os cartões. */
export function emailCodigoCliente({ codigo, minutos = 15, entidade } = {}) {
  const codigoLimpo = String(codigo).replace(/\D/g, '');

  const corpo = [
    h1('O teu código'),
    p('Escreve-o na app para guardares os teus cartões. Assim, se mudares de '
      + 'telemóvel, eles vão contigo.'),
    `<div style="height:8px;line-height:8px;font-size:0">&nbsp;</div>`,
    blocoCodigo(codigoLimpo),
    `<div style="height:20px;line-height:20px;font-size:0">&nbsp;</div>`,
    p(`Vale ${minutos} minutos e só serve uma vez.`),
    `<div style="height:6px;line-height:6px;font-size:0">&nbsp;</div>`,
    risca(),
    `<div style="height:18px;line-height:18px;font-size:0">&nbsp;</div>`,
    p('Se não foste tu a pedir isto, ignora este email — não acontece nada, '
      + 'e o código deixa de valer sozinho.', `;font-size:14px;color:${TINTA_3};margin-bottom:0`),
  ].join('\n');

  return {
    assunto: `${codigoLimpo} — o teu código Carimbo Digital`,
    html: molde({
      titulo: 'O teu código Carimbo Digital',
      preheader: `Escreve ${codigoLimpo} na app. Vale ${minutos} minutos.`,
      corpo,
      entidade,
    }),
    texto: [
      'O teu código Carimbo Digital',
      '',
      `    ${codigoLimpo}`,
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
      'Carimbo Digital · carimbodigital.pt',
    ].join('\n'),
  };
}

/** Código para quem manda no negócio entrar no balcão. */
export function emailCodigoBalcao({ codigo, minutos = 15, negocio, entidade } = {}) {
  const codigoLimpo = String(codigo).replace(/\D/g, '');
  const onde = negocio ? ` de ${seguro(negocio)}` : '';

  const corpo = [
    h1('Entrar no balcão'),
    p(`Escreve este código no telemóvel do balcão${onde}.`),
    `<div style="height:8px;line-height:8px;font-size:0">&nbsp;</div>`,
    blocoCodigo(codigoLimpo),
    `<div style="height:20px;line-height:20px;font-size:0">&nbsp;</div>`,
    p(`Vale ${minutos} minutos e só serve uma vez.`),
    `<div style="height:6px;line-height:6px;font-size:0">&nbsp;</div>`,
    risca(),
    `<div style="height:18px;line-height:18px;font-size:0">&nbsp;</div>`,
    p('Se não foste tu, ignora este email. Ninguém entra no teu balcão sem '
      + 'este código.', `;font-size:14px;color:${TINTA_3};margin-bottom:0`),
  ].join('\n');

  return {
    assunto: `${codigoLimpo} — entrar no Carimbo Digital Balcão`,
    html: molde({
      titulo: 'Entrar no Carimbo Digital Balcão',
      preheader: `Escreve ${codigoLimpo} no telemóvel do balcão. Vale ${minutos} minutos.`,
      corpo,
      entidade,
    }),
    texto: [
      'Entrar no Carimbo Digital Balcão',
      '',
      `    ${codigoLimpo}`,
      '',
      `Escreve este código no telemóvel do balcão${negocio ? ` de ${negocio}` : ''}.`,
      `Vale ${minutos} minutos e só serve uma vez.`,
      '',
      'Se não foste tu, ignora este email. Ninguém entra no teu balcão sem este',
      'código.',
      '',
      '—',
      'Carimbo Digital · carimbodigital.pt',
    ].join('\n'),
  };
}
