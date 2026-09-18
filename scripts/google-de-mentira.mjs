#!/usr/bin/env node
/* =========================================================================
   Uma Google de mentira

   Levanta um servidor que responde como a API da Wallet e guarda tudo o que
   recebe. Existe para o caminho do passe poder ser provado por inteiro —
   testemunho de acesso, criar a classe, criar o objecto, actualizar o saldo,
   expirar — sem conta na Google, sem chave verdadeira e sem Internet.

   Sem isto, a única forma de saber se o Worker fala bem com a Google era
   falar com a Google a sério: obriga a ter conta, gasta quota, não corre no
   CI, e não há maneira de provar o que acontece quando ela responde mal.

   O que ela NÃO é: uma imitação fiel. Não valida o JWT que recebe nem os
   campos do passe — para isso há os testes do `wallet.js`, que verificam a
   assinatura com o `node:crypto`. Esta serve para provar o que o `index.js`
   faz: em que ordem chama, o que envia, o que grava a seguir, e o que faz
   quando a resposta é má.

   Faz DUAS Googles, que na vida real são duas casas diferentes:

     · a da CARTEIRA — testemunho de acesso, classes e objectos do passe;
     · a de ENTRAR — o ecrã de consentimento e a troca do código por um
       `id_token`. É a fase 5 do login.

   O ecrã de consentimento é uma página de mentira com um campo para a morada:
   escrever a mesma morada duas vezes é a mesma pessoa a entrar duas vezes, que
   é o que permite provar o caminho todo. O `sub` — que é o que DECIDE de quem
   é a conta — deriva-se da morada, e nunca é a morada.

   O QUE ISTO NÃO PROVA, e fica dito em vez de fingido: a assinatura do
   `id_token`. O `id_token` que sai daqui vem com uma assinatura de mentira, e
   o Worker não a verifica — de propósito, porque o token chega-lhe por TLS
   directamente do endereço de troca, e o OpenID Connect Core §3.1.3.7 permite
   trocar a verificação da assinatura pela do servidor de TLS. Quem garante a
   autenticidade é o TLS mais o segredo do cliente, e nenhum dos dois se imita
   aqui.

   Uso:  node scripts/google-de-mentira.mjs [porta]

   Endereços próprios, fora da imitação:
     GET  /__visto      tudo o que recebeu, por ordem
     POST /__limpar     esquece tudo
     POST /__avariar    a próxima chamada responde 500 (para provar que uma
                        falha da Google não faz falhar um carimbo)
   ========================================================================= */

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const PORTA = Number(process.argv[2]) || 8799;

let visto = [];
let avariarProximo = 0;
/* As notificações que chegaram, e as subscrições que já «morreram» (410). */
let entregues = [];
const mortas = new Set();
/* Os códigos de autorização por resgatar: código → o que foi pedido. */
const codigos = new Map();

const base64url = (b) => Buffer.from(b).toString('base64url');
const s256 = (texto) => createHash('sha256').update(texto).digest('base64url');
const escapar = (v) => String(v ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* O `sub` é o identificador ESTÁVEL da pessoa na Google, e não a morada — é
   isso que o produto guarda e é isso que decide de quem é a conta. Aqui
   deriva-se da morada para o teste poder fazer entrar «a mesma pessoa» duas
   vezes sem ter de andar com números na mão. */
const sujeitoDe = (email) => `sub-${s256(String(email).toLowerCase()).slice(0, 21)}`;

/* Um `id_token` com assinatura de mentira. Ver o cabeçalho: a assinatura não é
   o que garante isto, nem do lado de lá. */
function idTokenDeMentira({ cliente, sujeito, email, nonce, verificado = true }) {
  const agora = Math.floor(Date.now() / 1000);
  const cabecalho = base64url(JSON.stringify({ alg: 'RS256', kid: 'de-mentira', typ: 'JWT' }));
  const corpo = base64url(JSON.stringify({
    iss: 'https://accounts.google.com',
    aud: cliente,
    sub: sujeito,
    email,
    email_verified: verificado,
    nonce,
    iat: agora,
    exp: agora + 3600,
  }));
  return `${cabecalho}.${corpo}.${base64url('assinatura-de-mentira')}`;
}

/* A página de consentimento. Não imita o aspecto da Google — imita o que ela
   FAZ: mostra em nome de quem, deixa escolher a conta, e devolve o browser ao
   endereço de onde veio com um código ou com uma recusa. */
function paginaDeConsentimento({ redireccao, estado, sugestao }) {
  return `<!doctype html><html lang="pt"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Escolher uma conta (Google de mentira)</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 32px; background: #fff; color: #202124; }
  main { max-width: 420px; margin: 0 auto; }
  h1 { font-size: 22px; font-weight: 400; }
  label { display: block; margin: 16px 0 6px; font-size: 13px; color: #5f6368; }
  input { width: 100%; box-sizing: border-box; padding: 12px; font-size: 16px;
          border: 1px solid #dadce0; border-radius: 4px; }
  .botoes { display: flex; gap: 12px; justify-content: flex-end; margin-top: 28px; }
  button { font: inherit; padding: 10px 22px; border-radius: 4px; border: 0; cursor: pointer; }
  .principal { background: #1a73e8; color: #fff; }
  .fantasma { background: transparent; color: #1a73e8; }
  .aviso { margin-top: 28px; font-size: 12px; color: #80868b; }
</style></head><body><main>
<h1>Entrar no <b>Carimbo Digital</b></h1>
<form method="POST" action="/o/oauth2/v2/aprovar">
  <input type="hidden" name="redireccao" value="${redireccao}">
  <input type="hidden" name="estado" value="${estado}">
  <label for="email">Conta da Google</label>
  <input id="email" name="email" type="email" value="${sugestao}" autocomplete="off">
  <div class="botoes">
    <button type="submit" name="decisao" value="nao" class="fantasma" id="cancelar">Cancelar</button>
    <button type="submit" name="decisao" value="sim" class="principal" id="continuar">Continuar</button>
  </div>
</form>
<p class="aviso">Isto não é a Google. É o servidor de mentira que existe para
este caminho poder ser provado sem Internet e sem conta nenhuma.</p>
</main></body></html>`;
}

/**
 * O corpo em BYTES, e quem quiser texto que o converta.
 *
 * Chegou a devolver texto. Isso bastou enquanto tudo o que entrava era JSON —
 * e deixou de bastar no dia em que passou a entrar um push, que é binário: sal,
 * chave efémera e ciframento. Mas a correcção óbvia (ler tudo como `binary`)
 * partiu o outro lado, e de uma forma que não grita: os corpos da carteira têm
 * acentos, o latin-1 desfaz o UTF-8 deles byte a byte, e o que reprovou foi um
 * teste de «mudar o nome do café» a dizer que `Café Rebaptizado` não era
 * `Café Rebaptizado`. Bytes à entrada, e cada caminho decide como os lê.
 */
function corpoDe(pedido) {
  return new Promise((resolve) => {
    const pedacos = [];
    pedido.on('data', (p) => pedacos.push(p));
    pedido.on('end', () => resolve(Buffer.concat(pedacos)));
  });
}

const responder = (res, estado, dados) => {
  const corpo = JSON.stringify(dados);
  res.writeHead(estado, { 'content-type': 'application/json' });
  res.end(corpo);
};

const servidor = createServer(async (pedido, res) => {
  const url = new URL(pedido.url, `http://localhost:${PORTA}`);
  const caminho = url.pathname;
  const bytes = await corpoDe(pedido);
  const corpo = bytes.toString('utf8');

  /* --- os endereços de controlo ---------------------------------------- */
  if (caminho === '/__visto') return responder(res, 200, visto);
  if (caminho === '/__limpar') {
    visto = []; avariarProximo = 0; codigos.clear();
    entregues = []; mortas.clear();
    return responder(res, 200, { ok: true });
  }
  if (caminho === '/__avariar') {
    avariarProximo = Number(url.searchParams.get('n') || 1);
    return responder(res, 200, { avariar: avariarProximo });
  }

  /* --- a imitação -------------------------------------------------------- */
  let json = null;
  try { json = corpo ? JSON.parse(corpo) : null; } catch { /* o token vai em form */ }
  visto.push({ metodo: pedido.method, caminho, corpo: json, bruto: json ? null : corpo });

  if (avariarProximo > 0) {
    avariarProximo -= 1;
    return responder(res, 500, { error: { message: 'a Google teve um mau dia' } });
  }

  /* --- a Google que ENTREGA NOTIFICAÇÕES --------------------------------- */
  /* O serviço de push do Chrome é mesmo da Google (`fcm.googleapis.com`), por
     isso ele vive aqui e não noutro sítio. Guarda o corpo CIFRADO tal como
     chegou: quem decifra é o teste, com as chaves do «browser» que ele próprio
     gerou — é a única forma de provar que a cifra funciona dos dois lados.

     Também se guarda o cabeçalho `authorization`, que é onde vai o VAPID. */
  if (caminho.startsWith('/wp/')) {
    const id = caminho.slice(4);
    if (mortas.has(id)) return responder(res, 410, { error: 'gone' });
    entregues.push({
      id,
      autorizacao: pedido.headers.authorization || '',
      codificacao: pedido.headers['content-encoding'] || '',
      ttl: pedido.headers.ttl || '',
      corpo: bytes.toString('base64'),
    });
    res.writeHead(201); return res.end();
  }
  if (caminho === '/__entregues') return responder(res, 200, entregues);
  if (caminho === '/__matar') {
    mortas.add(url.searchParams.get('id') || '');
    return responder(res, 200, { mortas: [...mortas] });
  }

  /* --- a Google de ENTRAR ------------------------------------------------ */

  /* O ecrã de consentimento. O código de autorização nasce aqui e só vale se
     a pessoa carregar em «Continuar»: é assim do lado de lá também. */
  if (caminho === '/o/oauth2/v2/auth') {
    const codigo = randomBytes(18).toString('base64url');
    codigos.set(codigo, {
      cliente: url.searchParams.get('client_id'),
      redireccao: url.searchParams.get('redirect_uri'),
      nonce: url.searchParams.get('nonce'),
      desafio: url.searchParams.get('code_challenge'),
      metodo: url.searchParams.get('code_challenge_method'),
      email: null,
      nascido: Date.now(),
    });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(paginaDeConsentimento({
      redireccao: escapar(codigo),
      estado: escapar(url.searchParams.get('state') || ''),
      sugestao: 'alguem@gmail.com',
    }));
  }

  /* A decisão. Devolve o browser ao endereço de onde veio — com um código, ou
     com a recusa, que é um caminho que tem de ser provado tanto como o outro. */
  if (caminho === '/o/oauth2/v2/aprovar') {
    const form = new URLSearchParams(corpo);
    const codigo = form.get('redireccao') || '';
    const pedidoOriginal = codigos.get(codigo);
    if (!pedidoOriginal) return responder(res, 400, { error: 'código desconhecido' });
    const destino = new URL(pedidoOriginal.redireccao);
    destino.searchParams.set('state', form.get('estado') || '');
    if (form.get('decisao') === 'sim') {
      pedidoOriginal.email = (form.get('email') || 'alguem@gmail.com').trim().toLowerCase();
      destino.searchParams.set('code', codigo);
    } else {
      codigos.delete(codigo);
      destino.searchParams.set('error', 'access_denied');
    }
    res.writeHead(302, { location: destino.toString() });
    return res.end();
  }

  /* O testemunho de acesso, e a troca do código por um `id_token`. São os dois
     no mesmo endereço, como na Google: o que os distingue é o `grant_type`.

     O Worker manda um JWT assinado para a carteira; aqui não se verifica —
     quem verifica assinaturas é o teste do `wallet.js`. */
  if (caminho === '/token') {
    const form = new URLSearchParams(corpo);
    if (form.get('grant_type') === 'authorization_code') {
      const codigo = form.get('code') || '';
      const guardado = codigos.get(codigo);
      /* UM CÓDIGO SERVE UMA VEZ. É a regra que impede uma volta repetida de
         valer duas contas, e é por isso que se apaga antes de responder. */
      codigos.delete(codigo);
      if (!guardado || !guardado.email) {
        return responder(res, 400, { error: 'invalid_grant' });
      }
      if (form.get('redirect_uri') !== guardado.redireccao) {
        return responder(res, 400, { error: 'redirect_uri_mismatch' });
      }
      /* O PKCE (RFC 7636). Sem isto, o servidor de mentira era mais brando do
         que a Google e o Worker podia estar a mandar lixo sem ninguém dar por
         isso. */
      if (guardado.desafio) {
        const verificador = form.get('code_verifier') || '';
        const bate = guardado.metodo === 'S256'
          ? s256(verificador) === guardado.desafio
          : verificador === guardado.desafio;
        if (!bate) return responder(res, 400, { error: 'invalid_grant', detalhe: 'PKCE' });
      }
      return responder(res, 200, {
        access_token: 'token-de-mentira',
        expires_in: 3600,
        token_type: 'Bearer',
        id_token: idTokenDeMentira({
          cliente: guardado.cliente,
          sujeito: sujeitoDe(guardado.email),
          email: guardado.email,
          nonce: guardado.nonce,
          /* Uma morada por verificar é um caso real: a Google devolve-a com
             `email_verified: false` e ela não pode servir de pista nenhuma. */
          verificado: !guardado.email.startsWith('porverificar'),
        }),
      });
    }
    return responder(res, 200, { access_token: 'token-de-mentira', expires_in: 3600 });
  }

  /* Criar a classe. O 409 de «já existe» é o caso que interessa provar: duas
     pessoas a pedir o passe do mesmo café ao mesmo tempo criam-na as duas, e
     a segunda TEM de tratar isso como sucesso. */
  if (pedido.method === 'POST' && caminho.endsWith('/loyaltyClass')) {
    const jaLa = visto.filter((v) => v.metodo === 'POST' && v.caminho.endsWith('/loyaltyClass')
      && v.corpo && json && v.corpo.id === json.id).length;
    if (jaLa > 1) return responder(res, 409, { error: { message: 'já existe' } });
    return responder(res, 200, json);
  }

  if (pedido.method === 'POST' && caminho.endsWith('/loyaltyObject')) {
    return responder(res, 200, json);
  }

  if (pedido.method === 'PATCH' && caminho.includes('/loyaltyObject/')) {
    return responder(res, 200, json);
  }

  return responder(res, 404, { error: { message: `sem imitação para ${caminho}` } });
});

servidor.listen(PORTA, () => {
  if (process.env.CALADO !== 'sim') console.log(`Google de mentira em http://localhost:${PORTA}`);
});

/* Quem levanta isto mata-o com um sinal. */
for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => { servidor.close(); process.exit(0); });
}
