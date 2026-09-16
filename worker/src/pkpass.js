/* =========================================================================
   Carimbo Digital — o cartão na Apple Wallet

   O irmão do `wallet.js`, e feito com a mesma regra: aqui constrói-se e
   assina-se, não se fala com ninguém. Tudo o que está neste ficheiro é uma
   função pura ou uma assinatura, e as duas coisas provam-se sem rede.

   PORQUE É QUE ISTO É TÃO MAIOR DO QUE O DA GOOGLE. A Google recebe um JWT
   assinado — uma linha de texto, e o WebCrypto faz RS256 sozinho. A Apple
   quer um FICHEIRO: um ZIP com as imagens, um `pass.json`, um `manifest.json`
   com o SHA-1 de cada ficheiro, e uma assinatura PKCS#7 DESTACADA do
   manifesto, em DER, com a cadeia de certificados lá dentro.

   Nada disso existe nos Workers e não há dependências neste projecto, por
   isso está tudo aqui: o ZIP (só armazenado, sem compressão, que é o que a
   Apple quer), o CRC-32 que ele exige, o suficiente de DER para escrever uma
   estrutura CMS SignedData, e o bocadinho de leitura de X.509 preciso para
   tirar do certificado o emissor e o número de série.

   O QUE O WEBCRYPTO DÁ E O QUE NÃO DÁ. Dá o SHA-1, o SHA-256 e a assinatura
   RSASSA-PKCS1-v1_5 — que é o `rsaEncryption` do CMS. Não dá CMS nenhum:
   isso é o `cms()` aqui em baixo, escrito byte a byte.

   O QUE A APPLE EXIGE, verificado na documentação dela e não de memória:
   · `manifest.json` leva o SHA-1 de cada ficheiro, com o caminho por chave;
   · a `signature` é PKCS#7 destacada do manifesto, com a chave privada do
     certificado do Pass Type ID;
   · o arquivo é ZIP e a extensão é `.pkpass`;
   · o `pass.json` tem de ter `formatVersion`, `passTypeIdentifier`,
     `teamIdentifier`, `serialNumber`, `organizationName` e `description`;
   · todo o passe precisa de `icon.png`. O ícone são 38 pt e o logótipo tem
     50 pt de altura.
   ========================================================================= */

/* =========================================================================
   Bytes
   ========================================================================= */

const juntar = (...partes) => {
  const total = partes.reduce((s, p) => s + p.length, 0);
  const saida = new Uint8Array(total);
  let i = 0;
  for (const p of partes) { saida.set(p, i); i += p.length; }
  return saida;
};

const texto = (s) => new TextEncoder().encode(s);

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Base64 → bytes. Aguenta o que vem de um PEM, com mudanças de linha. */
export function deBase64(s) {
  const limpo = String(s).replace(/[^A-Za-z0-9+/=]/g, '');
  const bin = atob(limpo);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Bytes → base64. */
export function paraBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/**
 * Tira o corpo de um PEM.
 *
 * Aceita qualquer rótulo — CERTIFICATE, PRIVATE KEY, RSA PRIVATE KEY — e
 * também aceita que já venha em base64 puro, sem cabeçalhos: é assim que ele
 * cabe numa variável de ambiente sem mudanças de linha.
 */
export function doPEM(entrada) {
  const todos = todosOsPEM(entrada);
  if (!todos.length) throw new Error('PEM vazio');
  return todos[0].bytes;
}

/**
 * SÓ os certificados de um PEM — e rebenta se lá vier uma chave privada.
 *
 * Isto existe por causa de uma fuga que eu próprio abri. Ao passar a ler
 * todos os blocos (para a cadeia da Apple caber numa variável), passei a
 * enfiar no CMS tudo o que encontrasse, sem olhar ao rótulo. E o ficheiro que
 * a receita normal produz — `openssl pkcs12 -in Certificates.p12 -nodes -out
 * bundle.pem`, que é como se tira o PEM do que o Acesso a Chaves exporta —
 * traz, por esta ordem: o certificado E A CHAVE PRIVADA.
 *
 * Medido: com esse ficheiro em `APPLE_CERTIFICADO`, os bytes completos da
 * chave de assinatura do Pass Type ID ficavam dentro do ficheiro `signature`
 * do `.pkpass` — que a rota ABERTA `GET /v1/passe/<bilhete>` serve a quem
 * tiver o endereço. De caminho, o CMS deixava de ser analisável e o iPhone
 * recusava o passe sem dizer porquê.
 *
 * Por isso NÃO se ignora a chave em silêncio: rebenta-se. Uma chave privada
 * na variável dos certificados quer dizer que um segredo foi colado no sítio
 * errado, e quem o fez tem de saber.
 */
export function certificadosDoPEM(entrada, onde = 'o certificado') {
  const todos = todosOsPEM(entrada);
  if (todos.some((b) => /PRIVATE KEY/i.test(b.rotulo))) {
    throw new Error(`Há uma CHAVE PRIVADA dentro de ${onde}. `
      + 'Isso é um segredo e não entra no passe: põe só os certificados aí, e a '
      + 'chave em APPLE_CHAVE. (O `openssl pkcs12 -nodes` escreve as duas coisas '
      + 'no mesmo ficheiro — é preciso separá-las.)');
  }
  return todos.filter((b) => !b.rotulo || /CERTIFICATE/i.test(b.rotulo)).map((b) => b.bytes);
}

/**
 * TODOS os blocos de um PEM, e não só o primeiro.
 *
 * O `match` sem `g` devolve uma ocorrência. Enquanto isto servia só para a
 * chave privada não fazia diferença — mas a cadeia da Apple são DOIS
 * certificados (o WWDR e a raiz), e quem os tem cola-os um a seguir ao outro
 * numa variável só, que é a forma normal de os guardar. O segundo era deitado
 * fora em silêncio: o passe saía assinado, o `openssl` verificava, os testes
 * passavam — e o iPhone recusava-o por não conseguir fechar a cadeia.
 *
 * O `\n` LITERAL tem de sair primeiro, e é a diferença entre isto funcionar e
 * não funcionar. Num ficheiro de variáveis de ambiente não há mudanças de
 * linha, por isso um PEM vai lá com os dois caracteres `\` e `n` no lugar
 * delas. O `deBase64` deita fora tudo o que não é base64 — e o `n` É base64:
 * só a barra saía, e ficavam «n» a mais no meio da chave.
 */
export function todosOsPEM(entrada) {
  const s = String(entrada || '').replace(/\\n/g, '\n').trim();
  if (!s) return [];
  /* O RÓTULO VAI JUNTO, e não é pormenor: é por ele que se distingue um
     certificado de uma chave privada. Ignorá-lo foi o que pôs a chave de
     assinatura dentro de um ficheiro servido publicamente. */
  const blocos = [...s.matchAll(/-----BEGIN ([^-]+)-----([\s\S]*?)-----END [^-]+-----/g)]
    .map((m) => ({ rotulo: m[1].trim(), bytes: deBase64(m[2]) }));
  /* Sem cabeçalhos nenhuns é base64 puro, que é como cabe numa variável. Não
     há rótulo para inspeccionar, e quem o põe assim sabe o que lá está. */
  return blocos.length ? blocos : [{ rotulo: '', bytes: deBase64(s) }];
}

/* =========================================================================
   O ZIP

   Só armazenado, sem compressão. Não é preguiça: poupa o `deflate`, que não
   existe aqui sem dependências, e um passe são umas dezenas de kilobytes de
   PNG, que já vêm comprimidos e não encolhiam nada.
   ========================================================================= */

/* A tabela do CRC-32 constrói-se uma vez e fica. Fazê-la a cada ficheiro era
   256 × 8 voltas por ficheiro, e o tecto de CPU de um Worker do plano
   gratuito são dez milissegundos. */
const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) {
    c = TABELA_CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const u16 = (n) => new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF]);
const u32 = (n) => new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]);

/**
 * Um ZIP a partir de `{ nome: bytes }`.
 *
 * A data vai a zeros de propósito: o mesmo passe pedido duas vezes tem de dar
 * o mesmo ficheiro, byte a byte. Com a hora lá dentro não dava, e um teste
 * que compare dois passes iguais passava a depender do relógio.
 */
export function zipar(ficheiros) {
  const entradas = Object.entries(ficheiros);
  const locais = [];
  const central = [];
  let posicao = 0;

  for (const [nome, dados] of entradas) {
    const nomeBytes = texto(nome);
    const soma = crc32(dados);
    const comum = juntar(
      u16(20),            // versão mínima
      u16(0),             // sinalizadores
      u16(0),             // método: 0 = armazenado
      u16(0), u16(0),     // hora e data — a zeros, para ser reprodutível
      u32(soma),
      u32(dados.length),  // comprimido
      u32(dados.length),  // por comprimir
      u16(nomeBytes.length),
      u16(0),             // extra
    );
    const cabecalho = juntar(u32(0x04034B50), comum, nomeBytes);
    locais.push(cabecalho, dados);

    central.push(juntar(
      u32(0x02014B50),
      u16(20),            // feito por
      comum,
      u16(0),             // comentário
      u16(0),             // disco
      u16(0),             // atributos internos
      u32(0),             // atributos externos
      u32(posicao),
      nomeBytes,
    ));
    posicao += cabecalho.length + dados.length;
  }

  const corpo = juntar(...locais);
  const indice = juntar(...central);
  const fim = juntar(
    u32(0x06054B50),
    u16(0), u16(0),
    u16(entradas.length), u16(entradas.length),
    u32(indice.length),
    u32(corpo.length),
    u16(0),
  );
  return juntar(corpo, indice, fim);
}

/* =========================================================================
   O manifesto

   SHA-1, que é o que a Apple manda. Não é uma escolha de segurança nossa: a
   assinatura por cima é que protege o manifesto, e essa é SHA-256.
   ========================================================================= */

export async function manifesto(ficheiros) {
  const saida = {};
  for (const [nome, dados] of Object.entries(ficheiros)) {
    saida[nome] = hex(new Uint8Array(await crypto.subtle.digest('SHA-1', dados)));
  }
  return saida;
}

/* =========================================================================
   DER, o suficiente para um CMS

   Um valor DER são três coisas: a etiqueta, o comprimento e o conteúdo. O
   comprimento é que tem manha — até 127 vai num byte, daí para cima vai o
   número de bytes do comprimento com o bit alto ligado, e depois o
   comprimento em bytes grandes primeiro.
   ========================================================================= */

function comprimento(n) {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

const der = (etiqueta, conteudo) =>
  juntar(new Uint8Array([etiqueta]), comprimento(conteudo.length), conteudo);

const sequencia = (...partes) => der(0x30, juntar(...partes));
const conjunto = (...partes) => der(0x31, juntar(...partes));
const octetos = (bytes) => der(0x04, bytes);
/* `[n] IMPLICIT`, construído: a etiqueta de contexto substitui a original. */
const contexto = (n, conteudo) => der(0xA0 | n, conteudo);

function inteiro(n) {
  const bytes = [];
  let v = n;
  do { bytes.unshift(v % 256); v = Math.floor(v / 256); } while (v > 0);
  /* Um DER é assinado: se o bit alto estiver ligado, um zero à frente evita
     que o número seja lido como negativo. */
  if (bytes[0] & 0x80) bytes.unshift(0);
  return der(0x02, new Uint8Array(bytes));
}

/** Um OID a partir da forma com pontos. */
function oid(texto) {
  const partes = texto.split('.').map(Number);
  const bytes = [partes[0] * 40 + partes[1]];
  for (const p of partes.slice(2)) {
    const grupo = [p & 0x7F];
    let v = Math.floor(p / 128);
    while (v > 0) { grupo.unshift((v & 0x7F) | 0x80); v = Math.floor(v / 128); }
    bytes.push(...grupo);
  }
  return der(0x06, new Uint8Array(bytes));
}

const nulo = () => new Uint8Array([0x05, 0x00]);
const algoritmo = (id, comParametro = true) =>
  sequencia(oid(id), ...(comParametro ? [nulo()] : []));

const OID = {
  dados: '1.2.840.113549.1.7.1',
  assinado: '1.2.840.113549.1.7.2',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsa: '1.2.840.113549.1.1.1',
  tipoConteudo: '1.2.840.113549.1.9.3',
  resumoMensagem: '1.2.840.113549.1.9.4',
  horaAssinatura: '1.2.840.113549.1.9.5',
};

/* =========================================================================
   Ler o certificado

   Só se quer duas coisas: o EMISSOR e o NÚMERO DE SÉRIE, que juntos são o
   nome pelo qual o CMS identifica quem assinou. Não se valida nada aqui —
   quem valida é o telemóvel, contra a cadeia da Apple.

   Um certificado é:  SEQUENCE { tbs SEQUENCE { [0] versão?, série INTEGER,
   algoritmo SEQUENCE, emissor SEQUENCE, ... }, ... }
   ========================================================================= */

/** Lê a etiqueta e o comprimento em `pos`, e devolve onde começa e acaba. */
function ler(bytes, pos) {
  const etiqueta = bytes[pos];
  let i = pos + 1;
  let tamanho = bytes[i];
  i += 1;
  if (tamanho & 0x80) {
    const n = tamanho & 0x7F;
    tamanho = 0;
    for (let k = 0; k < n; k += 1) { tamanho = tamanho * 256 + bytes[i]; i += 1; }
  }
  return { etiqueta, inicio: i, fim: i + tamanho, todo: bytes.subarray(pos, i + tamanho) };
}

export function emissorESerie(certificadoDER) {
  const b = certificadoDER;
  const fora = ler(b, 0);                    // Certificate
  const tbs = ler(b, fora.inicio);           // TBSCertificate
  let pos = tbs.inicio;
  /* A versão é `[0] EXPLICIT` e é opcional. Se lá estiver, salta-se. */
  if (b[pos] === 0xA0) pos = ler(b, pos).fim;
  const serie = ler(b, pos);                 // serialNumber INTEGER
  pos = serie.fim;
  pos = ler(b, pos).fim;                     // signature AlgorithmIdentifier
  const emissor = ler(b, pos);               // issuer Name
  return { serie: serie.todo, emissor: emissor.todo };
}

/* =========================================================================
   A assinatura: CMS SignedData, destacada
   ========================================================================= */

/**
 * Assina o manifesto e devolve os bytes do ficheiro `signature`.
 *
 * DESTACADA quer dizer que o conteúdo assinado NÃO vai lá dentro — o
 * `encapContentInfo` fica só com o tipo. O que se assina são os «atributos
 * assinados», e um deles é o SHA-256 do manifesto.
 *
 * A manha que se paga caro: os atributos assinados vivem no `SignerInfo` com
 * a etiqueta `[0] IMPLICIT`, mas o que se ASSINA é a mesma lista com a
 * etiqueta de `SET OF` (0x31). Assinar os bytes como estão no ficheiro dá uma
 * assinatura que não verifica em lado nenhum, e a mensagem de erro não diz
 * porquê.
 */
export async function assinar(conteudo, { certificado, chave, cadeia = [], quando }) {
  /* Junta-se TUDO o que vier, venha como vier. Quem exporta a identidade do
     Keychain recebe a folha e o WWDR no mesmo ficheiro; quem segue as
     instruções à letra põe um em cada variável. Os dois casos têm de dar o
     mesmo passe. O PRIMEIRO é o signatário — é a folha, em qualquer exportação
     que siga a convenção — e os outros vão como cadeia. */
  const todos = [
    ...certificadosDoPEM(certificado, 'APPLE_CERTIFICADO'),
    ...cadeia.filter(Boolean).flatMap((c) => certificadosDoPEM(c, 'APPLE_CADEIA')),
  ];
  if (!todos.length) throw new Error('Não há certificado nenhum para assinar.');
  const [certDER, ...cadeiaDER] = todos;
  const { serie, emissor } = emissorESerie(certDER);

  const resumo = new Uint8Array(await crypto.subtle.digest('SHA-256', conteudo));

  /* Os atributos assinados, por ordem de etiqueta — o DER de um `SET OF`
     exige-o, e um verificador rigoroso recusa se estiverem trocados. */
  const atributos = [
    sequencia(oid(OID.tipoConteudo), conjunto(oid(OID.dados))),
    sequencia(oid(OID.horaAssinatura), conjunto(horaUTC(quando))),
    sequencia(oid(OID.resumoMensagem), conjunto(octetos(resumo))),
  ];
  const paraAssinar = conjunto(...atributos);

  const chaveRSA = await crypto.subtle.importKey(
    'pkcs8', doPEM(chave),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const bruta = new Uint8Array(await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', chaveRSA, paraAssinar));

  const signerInfo = sequencia(
    inteiro(1),
    sequencia(emissor, serie),
    algoritmo(OID.sha256),
    contexto(0, juntar(...atributos)),   // os mesmos bytes, com [0] IMPLICIT
    algoritmo(OID.rsa),
    octetos(bruta),
  );

  const signedData = sequencia(
    inteiro(1),
    conjunto(algoritmo(OID.sha256)),
    sequencia(oid(OID.dados)),           // destacada: sem eContent
    contexto(0, juntar(certDER, ...cadeiaDER)),
    conjunto(signerInfo),
  );

  return sequencia(oid(OID.assinado), der(0xA0, signedData));
}

/** UTCTime, que é o formato de duas casas para o ano — o CMS pede-o assim. */
function horaUTC(quando) {
  const d = quando ? new Date(quando) : new Date();
  const p = (n, c = 2) => String(n).padStart(c, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return der(0x17, texto(s));
}

/* =========================================================================
   O passe
   ========================================================================= */

/* A cor vai em `rgb(r,g,b)` e não em `#rrggbb`: é o único formato que a
   referência da Apple aceita, e um `#` faz o passe ser recusado sem dizer
   porquê. */
function rgb(cor, alternativa = 'rgb(90,49,232)') {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(cor || ''));
  if (!m) return alternativa;
  const n = parseInt(m[1], 16);
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
}

/* Preto ou branco por cima da cor da marca, medido e não escolhido a olho.
   É a mesma conta que a app faz para o cartão no ecrã. */
function tintaSobre(cor) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(cor || ''));
  if (!m) return 'rgb(255,255,255)';
  const n = parseInt(m[1], 16);
  const canal = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const luz = 0.2126 * canal((n >> 16) & 255) + 0.7152 * canal((n >> 8) & 255) + 0.0722 * canal(n & 255);
  return (luz + 0.05) / 0.05 > (1.05 / (luz + 0.05)) ? 'rgb(0,0,0)' : 'rgb(255,255,255)';
}

/**
 * O `pass.json` de um cartão de fidelidade.
 *
 * É um `storeCard`, que é o que a Apple chama a um cartão de loja — e o que
 * traz a faixa por cima onde cabe o contador.
 */
export function passeDeCartao(cartao, programa, negocio, { passTipo, equipa, codigo, dominio }) {
  if (!passTipo || !equipa) throw new Error('falta o Pass Type ID ou a equipa');
  const pontos = programa.tipo === 'pontos'
    ? `${cartao.pontos ?? 0}`
    : `${cartao.carimbos ?? 0}/${programa.objetivo}`;

  const traseira = [
    { key: 'premio', label: 'Prémio', value: String(programa.premio || '') },
    { key: 'como', label: 'Como funciona',
      value: programa.tipo === 'pontos'
        ? 'Ganhas pontos em cada visita. Ao chegares a cada marco, o prémio fica disponível.'
        : `Cada visita vale um carimbo. Ao fim de ${programa.objetivo}, ganhas o prémio.` },
  ];
  if (programa.regras) {
    traseira.push({ key: 'regras', label: 'Regras', value: String(programa.regras) });
  }
  if (negocio.morada) {
    traseira.push({ key: 'onde', label: 'Onde fica',
      value: [negocio.morada, negocio.localidade].filter(Boolean).join('\n') });
  }
  traseira.push({ key: 'sitio', label: 'Carimbo Digital',
    value: `https://${dominio || 'carimbodigital.pt'}/app/` });

  return {
    formatVersion: 1,
    passTypeIdentifier: passTipo,
    teamIdentifier: equipa,
    /* O número de série é o do CARTÃO. A Apple diz que o par
       «identificador + série» é um passe único, e que adicionar outro com o
       mesmo par substitui o anterior — que é exactamente o que se quer
       quando o saldo muda. */
    serialNumber: String(cartao.id),
    organizationName: String(negocio.nome || 'Carimbo Digital').slice(0, 60),
    description: `Cartão de fidelidade de ${negocio.nome}`,
    logoText: String(negocio.nome || '').slice(0, 40),
    backgroundColor: rgb(negocio.cor),
    foregroundColor: tintaSobre(negocio.cor),
    labelColor: tintaSobre(negocio.cor),
    storeCard: {
      headerFields: [
        { key: 'saldo', label: programa.tipo === 'pontos' ? 'Pontos' : 'Carimbos', value: pontos },
      ],
      primaryFields: [],
      secondaryFields: [
        { key: 'premio', label: 'Prémio', value: String(programa.premio || '').slice(0, 60) },
      ],
      auxiliaryFields: [],
      backFields: traseira,
    },
    /* O `W1.` é o mesmo prefixo do código da Google: é por ele que o balcão
       sabe que está a ler um passe e não o código da app. */
    barcodes: [{
      format: 'PKBarcodeFormatQR',
      message: `W1.${codigo}`,
      messageEncoding: 'iso-8859-1',
      altText: String(codigo).slice(0, 12),
    }],
  };
}

/**
 * O ficheiro `.pkpass` inteiro, pronto a servir.
 *
 * As imagens vêm de fora porque quem as tem é o `index.js`, que fala com a
 * base — e este ficheiro não fala com ninguém.
 */
export async function construirPasse({ passe, imagens, certificado, chave, cadeia, quando }) {
  const ficheiros = { 'pass.json': texto(JSON.stringify(passe)) };
  for (const [nome, bytes] of Object.entries(imagens || {})) {
    if (bytes && bytes.length) ficheiros[nome] = bytes;
  }
  if (!ficheiros['icon.png']) throw new Error('todo o passe precisa de um icon.png');

  const lista = await manifesto(ficheiros);
  const manifestoBytes = texto(JSON.stringify(lista));
  const assinatura = await assinar(manifestoBytes, { certificado, chave, cadeia, quando });

  return zipar({
    ...ficheiros,
    'manifest.json': manifestoBytes,
    signature: assinatura,
  });
}
