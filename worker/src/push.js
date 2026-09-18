/* =========================================================================
   Carimbo Digital — Web Push, à mão

   Duas normas, e as duas de graça:

   · RFC 8292 (VAPID) — como é que o servidor se identifica ao serviço de push
     do browser. Um JWT assinado com ES256 e a chave pública ao lado. Sem isto,
     a Mozilla e a Apple recusam, e a Google aceita mas não diz a quem
     reclamar quando alguma coisa corre mal.
   · RFC 8291 + RFC 8188 (aes128gcm) — como é que o TEXTO da notificação viaja
     cifrado, de nós até ao telemóvel, sem o serviço de push o poder ler. A
     chave sai de um ECDH entre uma chave nossa de UMA mensagem e a chave que o
     browser gerou ao subscrever.

   PORQUE É QUE O TEXTO VAI CIFRADO NO CORPO, e não «acorda e vai buscar».
   A alternativa é mandar um push vazio e deixar o service worker ir buscar o
   texto à API — e essa parece mais simples até se ver que o service worker
   NÃO TEM ACESSO AO `localStorage`, que é onde vive o testemunho da sessão.
   Sem sessão não há nada para ir buscar, e o que sobrava era uma notificação
   a dizer «tens novidades», que é o género de coisa que se desliga à segunda.

   O que aqui NÃO se guarda: nada. Este ficheiro não fala com a base de dados.

   Prova-se de ponta a ponta no `worker/testes.mjs`: gera-se uma subscrição
   como um browser a geraria, manda-se uma mensagem, e DECIFRA-SE do outro
   lado com as chaves do «browser». Uma cifra que só se prova de um lado é uma
   cifra por provar.
   ========================================================================= */

const cru = (s) => new TextEncoder().encode(s);

function base64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deBase64url(texto) {
  const s = String(texto).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

function juntar(...pedacos) {
  const total = pedacos.reduce((n, p) => n + p.length, 0);
  const saida = new Uint8Array(total);
  let i = 0;
  for (const p of pedacos) { saida.set(p, i); i += p.length; }
  return saida;
}

/** Um número de 32 bits, em big-endian — é assim que o cabeçalho os quer. */
function de32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

/**
 * HKDF (RFC 5869), pela WebCrypto. Extrai e expande de uma vez.
 *
 * Fazer isto à mão com dois HMAC é o caminho que a maior parte das bibliotecas
 * de push segue, e é mais código para o mesmo resultado: o `deriveBits` do
 * HKDF é exactamente extract-then-expand.
 */
async function hkdf(ikm, sal, info, bytes) {
  const chave = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: sal, info }, chave, bytes * 8);
  return new Uint8Array(bits);
}

/* =========================================================================
   VAPID (RFC 8292)
   ========================================================================= */

/**
 * A chave privada VAPID vem em base64url — 32 bytes, que é o `d` de uma chave
 * P-256. A WebCrypto não importa `raw` para chaves privadas, por isso
 * monta-se um JWK, que é onde os 32 bytes cabem tal como estão.
 *
 * O `x` e o `y` são obrigatórios no JWK mesmo para assinar, e saem da chave
 * PÚBLICA que anda com ela: os 65 bytes começam por 0x04 e depois são X e Y,
 * 32 cada.
 */
async function chaveVAPID(privadaB64, publicaB64) {
  const publica = deBase64url(publicaB64);
  if (publica.length !== 65 || publica[0] !== 0x04) {
    throw new Error('A chave pública VAPID não é um ponto P-256 sem compressão.');
  }
  return crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    d: privadaB64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    x: base64url(publica.slice(1, 33)),
    y: base64url(publica.slice(33, 65)),
    ext: false,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/**
 * O cabeçalho `Authorization` de um envio.
 *
 * O `aud` é a ORIGEM do endereço de push — não o endereço inteiro. Pôr o
 * caminho lá dentro é o erro que faz a Mozilla responder 401 com uma mensagem
 * que não explica nada.
 */
export async function autorizacaoVAPID(env, endereco) {
  const chave = await chaveVAPID(env.PUSH_CHAVE, env.PUSH_PUBLICA);
  const cabecalho = base64url(cru(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const corpo = base64url(cru(JSON.stringify({
    aud: new URL(endereco).origin,
    /* Doze horas. O tecto da norma é 24, e quem lá chega descobre que alguns
       serviços recusam por causa de relógios desencontrados. */
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    /* Quem responde por estes envios. A norma quer um `mailto:` ou um `https:`
       por onde o serviço de push possa reclamar de nós. */
    sub: `mailto:${env.APOIO_EMAIL || 'geral@carimbodigital.pt'}`,
  })));
  const assinatura = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, chave, cru(`${cabecalho}.${corpo}`));
  /* A WebCrypto devolve `r || s` em cru, 64 bytes, que é exactamente o que um
     JWS ES256 quer. (O `node:crypto` devolveria DER, e aí era preciso
     converter — é a armadilha clássica deste caminho.) */
  const jwt = `${cabecalho}.${corpo}.${base64url(assinatura)}`;
  return `vapid t=${jwt}, k=${env.PUSH_PUBLICA}`;
}

/* =========================================================================
   A cifra (RFC 8291 sobre RFC 8188)
   ========================================================================= */

/**
 * Cifra `texto` para uma subscrição, e devolve o corpo pronto a enviar.
 *
 * A chave efémera é de UMA mensagem: gera-se aqui, vai dentro do corpo, e
 * morre. É isso que faz com que uma mensagem interceptada hoje não ajude a ler
 * a de amanhã.
 */
export async function cifrarParaSubscricao({ p256dh, auth }, texto) {
  const uaPublica = deBase64url(p256dh);
  const segredoAuth = deBase64url(auth);
  if (uaPublica.length !== 65 || uaPublica[0] !== 0x04) {
    throw new Error('A chave do browser não é um ponto P-256 sem compressão.');
  }
  if (segredoAuth.length !== 16) {
    throw new Error('O segredo de autenticação da subscrição não tem 16 bytes.');
  }

  const efemero = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublica = new Uint8Array(await crypto.subtle.exportKey('raw', efemero.publicKey));
  const doBrowser = await crypto.subtle.importKey(
    'raw', uaPublica, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const partilhado = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: doBrowser }, efemero.privateKey, 256));

  /* O `key_info` amarra a chave às DUAS pontas: sem ele, a mesma mensagem
     servia para outra subscrição que partilhasse o segredo. */
  const infoChave = juntar(cru('WebPush: info\0'), uaPublica, asPublica);
  const ikm = await hkdf(partilhado, segredoAuth, infoChave, 32);

  const sal = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, sal, cru('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, sal, cru('Content-Encoding: nonce\0'), 12);

  /* O 0x02 é o delimitador de ÚLTIMO registo do RFC 8188. Com 0x01 o browser
     fica à espera de mais um registo que nunca vem e deita a mensagem fora,
     em silêncio — do lado de cá tudo parece ter corrido bem. */
  const claro = juntar(cru(texto), new Uint8Array([0x02]));
  const chaveAES = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, chaveAES, claro));

  /* O cabeçalho do RFC 8188: sal, tamanho do registo, e a chave pública desta
     mensagem — o browser precisa dela para fazer o mesmo ECDH do outro lado. */
  return juntar(sal, de32(4096), new Uint8Array([asPublica.length]), asPublica, cifrado);
}

/* =========================================================================
   O envio
   ========================================================================= */

/**
 * Manda uma notificação. Devolve o que aconteceu, sem atirar.
 *
 * NÃO ATIRA de propósito: isto corre ao lado de um carimbo e de uma limpeza
 * nocturna, e nenhuma das duas pode falhar porque o telemóvel de alguém trocou
 * de subscrição. Quem chama decide o que fazer com o `estado`.
 *
 * O 404 e o 410 são a resposta normal a uma subscrição que morreu — a app foi
 * desinstalada, os dados do site foram limpos. Quem chama apaga a linha.
 */
export async function enviarPush(env, subscricao, texto, { segundos = 3600 } = {}) {
  let corpo;
  try {
    corpo = await cifrarParaSubscricao(subscricao, texto);
  } catch (erro) {
    console.error('push: não deu para cifrar', String(erro));
    return { ok: false, estado: 0, morta: false };
  }

  let r;
  try {
    r = await fetch(subscricao.endereco, {
      method: 'POST',
      headers: {
        authorization: await autorizacaoVAPID(env, subscricao.endereco),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(segundos),
        /* Uma notificação de carimbo não vale a pena acordar o telemóvel a
           meio da noite; o serviço de push entrega quando puder. */
        urgency: 'normal',
      },
      body: corpo,
      ...(typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? { signal: AbortSignal.timeout(8000) } : {}),
    });
  } catch (erro) {
    console.error('push: o envio nem chegou a sair', String(erro));
    return { ok: false, estado: 0, morta: false };
  }

  const morta = r.status === 404 || r.status === 410;
  if (!r.ok && !morta) console.error('push: o serviço recusou', r.status);
  return { ok: r.ok, estado: r.status, morta };
}

/** Está configurado? Sem as duas chaves, nada disto existe. */
export const pushPronto = (env) => Boolean(env.PUSH_CHAVE && env.PUSH_PUBLICA);
