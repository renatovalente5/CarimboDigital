/* =========================================================================
   Carimbo Digital — o cartão na Wallet do telemóvel

   Vive à parte do resto do Worker pela mesma razão que os emails: dá para
   provar sem levantar servidor nenhum, e é uma linguagem à parte — a da
   Google, com os nomes dela e as regras dela — que não convém misturar com a
   lógica de negócio.

   O QUE ISTO FAZ, E O QUE NÃO FAZ. Constrói e assina. Não fala com a Google:
   quem faz pedidos é o `index.js`, que é onde vivem os segredos e o `fetch`.
   Assim tudo o que aqui está é uma função pura ou uma assinatura — e as duas
   coisas provam-se com um teste, sem rede.

   AS TRÊS PEÇAS:

   · a CLASSE é o cartão em abstracto — o nome do programa, o logótipo, a cor.
     É por PROGRAMA e não por negócio. Um negócio pode ter vários cartões (a
     tabela `programas` tem `negocio_id`), e uma classe por negócio dava ao
     segundo cartão o nome e o objectivo do primeiro.
   · o OBJECTO é o cartão de uma pessoa — quantos carimbos tem, e o código de
     barras que o balcão lê.
   · o JWT é o convite para o guardar. Vai num endereço
     `pay.google.com/gp/v/save/<JWT>`, e tem um limite de tamanho que morde em
     silêncio (ver `jwtDeGravacao`).

   PORQUE É QUE O WORKER CONSEGUE ASSINAR ISTO. O JWT é RS256, que é
   RSASSA-PKCS1-v1_5 com SHA-256, e o WebCrypto dos Cloudflare Workers
   suporta-o por inteiro. A chave da conta de serviço da Google vem em PKCS#8
   («-----BEGIN PRIVATE KEY-----»), que é exactamente o formato que o
   `importKey` aceita — não é preciso converter nada.
   ========================================================================= */

/* O rótulo do contador dentro do passe. A referência da Google recomenda no
   máximo nove caracteres, senão o telemóvel corta-o. */
const ROTULO_PONTOS = 'Carimbos';

/* =========================================================================
   Base64 para URL, e a assinatura
   ========================================================================= */

/** Bytes → base64url, sem `=` no fim, que é o que um JWT quer. */
function base64url(bytes) {
  let binario = '';
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const texto = (s) => base64url(new TextEncoder().encode(s));

/**
 * A chave privada, importada uma vez.
 *
 * Guardada em variável de módulo de propósito: o plano gratuito dá 10 ms de
 * CPU por pedido, e importar uma chave RSA custa uma fatia disso. O isolate
 * sobrevive a muitos pedidos, e a chave é sempre a mesma — importá-la a cada
 * carimbo era pagar o mesmo preço vezes sem conta.
 *
 * A cache é por PEM e não global: se o segredo for trocado sem o Worker
 * reiniciar, a chave antiga não fica presa.
 */
let chaveEmCache = null;

export async function chavePrivada(pem) {
  if (chaveEmCache && chaveEmCache.pem === pem) return chaveEmCache.chave;
  /* O `\n` LITERAL tem de sair antes dos brancos, e é a diferença entre isto
     funcionar e não funcionar. A chave vem do JSON da conta de serviço, onde
     as mudanças de linha estão escritas como os dois caracteres `\` e `n`; e
     num ficheiro de variáveis de ambiente não há mudanças de linha de todo,
     por isso também lá vai assim. Um `replace(/\s+/)` não os apanha — não são
     brancos, são texto — e o que sobrava não era base64 nenhum. */
  const corpo = String(pem || '')
    .replace(/\\n/g, '')
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s+/g, '');
  if (!corpo) throw new Error('A chave da conta de serviço está vazia.');
  const der = Uint8Array.from(atob(corpo), (c) => c.charCodeAt(0));
  const chave = await crypto.subtle.importKey(
    'pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  );
  chaveEmCache = { pem, chave };
  return chave;
}

/** Assina `{cabeçalho}.{corpo}` e devolve o JWT inteiro. */
export async function assinarRS256(pem, corpo) {
  const cabecalho = texto(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const dados = `${cabecalho}.${texto(JSON.stringify(corpo))}`;
  const chave = await chavePrivada(pem);
  const assinatura = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', chave, new TextEncoder().encode(dados));
  return `${dados}.${base64url(new Uint8Array(assinatura))}`;
}

/* =========================================================================
   A classe: o cartão em abstracto
   ========================================================================= */

/**
 * @param {object} programa  linha da tabela `programas`
 * @param {object} negocio   linha da tabela `negocios`
 * @param {object} opcoes    { emissor, logotipo } — o id de emissor e o
 *                           endereço público do logótipo
 */
export function classeDePrograma(programa, negocio, { emissor, logotipo }) {
  if (!emissor) throw new Error('Falta o id de emissor da Google.');
  /* O logótipo é OBRIGATÓRIO na classe de fidelização. Sem ele a Google
     recusa, e é por isso que o botão da Wallet só aparece a negócios que já
     tenham imagem — mais vale não oferecer do que oferecer e falhar. */
  if (!logotipo) throw new Error('Este negócio ainda não tem logótipo.');

  return {
    id: `${emissor}.${programa.id}`,
    issuerName: String(negocio.nome).slice(0, 60),
    programName: String(programa.nome).slice(0, 60),
    programLogo: { sourceUri: { uri: logotipo } },
    /* `underReview` e não `draft`: com `draft` a Google não deixa criar
       objectos nenhuns, e a plataforma passa-o sozinha a `approved`. */
    reviewStatus: 'underReview',
    hexBackgroundColor: /^#[0-9a-fA-F]{6}$/.test(String(negocio.cor || ''))
      ? negocio.cor : '#5A31E8',
    ...(negocio.morada || negocio.localidade ? {
      locations: undefined,   // sem coordenadas não se inventa um ponto no mapa
    } : {}),
    /* A letra pequena do cartão vai para onde a Google a espera. */
    ...(programa.regras ? {
      textModulesData: [{
        header: 'Como funciona',
        body: String(programa.regras).slice(0, 240),
        id: 'regras',
      }],
    } : {}),
  };
}

/* =========================================================================
   O objecto: o cartão de uma pessoa
   ========================================================================= */

/**
 * O saldo, como texto curto.
 *
 * A referência recomenda no máximo sete caracteres no `balance`, e é pouco: um
 * «10 de 10» tem oito e já não cabe, e num cartão de vinte carimbos isso
 * acontece todos os dias. Daí a barra em vez da palavra.
 */
export function saldoDoCartao(cartao, programa) {
  if (programa.tipo === 'pontos') return { int: Number(cartao.pontos) || 0 };
  return { string: `${Number(cartao.carimbos) || 0}/${programa.objetivo}` };
}

/**
 * @param {object} opcoes { emissor, codigo } — `codigo` é o `wallet_codigo`
 *                        do cartão, o token permanente do passe.
 */
export function objetoDeCartao(cartao, programa, { emissor, codigo }) {
  if (!emissor) throw new Error('Falta o id de emissor da Google.');
  if (!codigo) throw new Error('Falta o código do passe.');
  return {
    id: `${emissor}.${cartao.id}`,
    classId: `${emissor}.${programa.id}`,
    state: 'ACTIVE',
    /* O código de barras leva um token PRÓPRIO do passe, com prefixo `W1.`, e
       não o número público do cliente. Duas razões: um passe fotografado
       revoga-se sozinho sem mexer no cartão da pessoa, e o balcão consegue
       distinguir um carimbo vindo da Wallet de um escrito à mão. */
    barcode: { type: 'QR_CODE', value: `W1.${codigo}` },
    accountId: codigo,
    loyaltyPoints: {
      label: ROTULO_PONTOS,
      balance: saldoDoCartao(cartao, programa),
    },
  };
}

/* =========================================================================
   O JWT de gravação
   ========================================================================= */

/* O tecto que a Google publica para o endereço de gravação. Acima disto os
   browsers cortam o endereço — e o que acontece não é um erro: é a gravação
   falhar em silêncio. É por isso que há um teste só sobre este número. */
export const JWT_MAX = 1800;

/**
 * O endereço que grava o passe na carteira.
 *
 * Leva SÓ `{id, classId}` e não o objecto inteiro. O objecto é criado antes,
 * pela API REST — é isso que mantém o endereço muito abaixo do tecto. Mandar
 * o objecto todo aqui dentro funciona enquanto os nomes forem curtos e parte
 * no dia em que um café tiver um nome comprido.
 */
export async function ligacaoDeGravacao(pem, { emissorEmail, objeto, origem }) {
  const corpo = {
    iss: emissorEmail,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    origins: [origem],
    payload: { loyaltyObjects: [{ id: objeto.id, classId: objeto.classId }] },
  };
  const jwt = await assinarRS256(pem, corpo);
  const ligacao = `https://pay.google.com/gp/v/save/${jwt}`;
  return { jwt, ligacao, comprimento: jwt.length };
}

/* =========================================================================
   A actualização do saldo
   ========================================================================= */

/* Os únicos campos que, ao mudarem, fazem o telemóvel tocar. O nosso contador
   é um deles — o carimbo dado ao balcão chega ao cliente sem ele abrir nada.

   O valor do enum é `NOTIFY_ON_UPDATE`. A página HTML de referência está
   desactualizada e fala de `NOTIFY`/`DO_NOT_NOTIFY`; o documento de descoberta
   a sério (walletobjects.googleapis.com/$discovery/rest?version=v1) declara
   só dois valores, e este não tem alias em camelCase. */
export const NOTIFICAR = 'NOTIFY_ON_UPDATE';

/**
 * O corpo do PATCH que muda o saldo.
 *
 * O `notifyPreference` é transitório — vive só neste pedido e tem de ser
 * reposto em cada um que queira notificar. E gasta-se com conta: o tecto é de
 * três notificações por passe em 24 horas, por isso só se notifica no carimbo
 * que FECHA o cartão. Gastá-lo nos do meio deixava em silêncio o único que a
 * pessoa quer sentir no bolso.
 */
export function actualizacaoDeSaldo(cartao, programa, { notificar = false } = {}) {
  return {
    loyaltyPoints: { label: ROTULO_PONTOS, balance: saldoDoCartao(cartao, programa) },
    ...(notificar ? { notifyPreference: NOTIFICAR } : {}),
  };
}
