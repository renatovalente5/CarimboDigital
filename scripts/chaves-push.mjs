#!/usr/bin/env node
/* =========================================================================
   Um par de chaves VAPID, para as notificações.

   São duas metades de uma chave P-256:

     · a PÚBLICA vai no `_fonte/config.json` e daí para dentro da app — é ela
       que o browser guarda ao subscrever, e é por ela que o serviço de push
       reconhece os nossos envios. Não é segredo: viaja em cada subscrição.
     · a PRIVADA assina o JWT de cada envio, e vive fora do repositório:
         npx wrangler secret put PUSH_CHAVE

   TROCAR A CHAVE INVALIDA AS SUBSCRIÇÕES TODAS. O browser guarda a pública no
   momento em que subscreve, e um envio assinado por outra é recusado com 403
   para sempre. Se um dia for mesmo preciso trocar, é preciso apagar a tabela
   `subscricoes` e pedir a toda a gente para voltar a dizer que sim — por isso
   esta chave gera-se UMA vez e guarda-se.

   Uso:  node scripts/chaves-push.mjs
   ========================================================================= */

const par = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

const publica = Buffer.from(
  await crypto.subtle.exportKey('raw', par.publicKey)).toString('base64url');
/* A privada sai em JWK porque é lá que os 32 bytes do `d` cabem tal como são —
   a WebCrypto não exporta chaves privadas em `raw`, e o `push.js` volta a
   montar o JWK a partir deste `d` mais a pública. */
const { d } = await crypto.subtle.exportKey('jwk', par.privateKey);

console.log(`
PUSH_PUBLICA (não é segredo — vai no _fonte/config.json, campo "push"):

  ${publica}

PUSH_CHAVE (é segredo — nunca no repositório):

  ${d}

Para a pôr no Worker:

  cd worker && npx wrangler secret put PUSH_CHAVE

E no wrangler.toml, ao lado das outras variáveis públicas:

  PUSH_PUBLICA = "${publica}"
`);
