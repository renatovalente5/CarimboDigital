#!/usr/bin/env node
/* =========================================================================
   Uma Apple de mentira

   Levanta um servidor que responde como o «Sign in with Apple» da web: o ecrã
   de autorização e a troca do código por um `id_token`. Existe pela mesma razão
   que a Google de mentira — para o caminho da entrada poder ser provado por
   inteiro, sem conta de programador, sem Internet, e com os casos maus a
   poderem ser pedidos de propósito.

   A Apple é MENOS do que a Google, e é aí que está o que interessa provar:
   · não leva âmbito nenhum, por isso o `id_token` NÃO TRAZ MORADA;
   · a volta é por `response_mode=query`, ou seja um GET;
   · e o «client secret» que recebe é um JWT ES256 assinado com a `.p8` — aqui
     não se verifica a assinatura (é o que o `push.js` e o `index.js` dizem
     sobre o mesmo assunto), mas GUARDA-SE, para o teste poder abrir o
     cabeçalho e o corpo e afirmar que o `kid`, o `iss` e o `sub` estão certos.
     É aí que estão os três enganos que custam uma tarde a quem faz isto pela
     primeira vez.

   Uso:  node scripts/apple-de-mentira.mjs [porta]

   Endereços próprios, fora da imitação:
     GET  /__visto    tudo o que recebeu, por ordem
     POST /__limpar   esquece tudo
   ========================================================================= */

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const PORTA = Number(process.argv[2]) || 8797;

let visto = [];
const codigos = new Map();

const base64url = (b) => Buffer.from(b).toString('base64url');
const s256 = (t) => createHash('sha256').update(t).digest('base64url');
const escapar = (v) => String(v ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* O `sub` da Apple é opaco e estável por (pessoa, equipa). Deriva-se aqui de
   um nome escrito no ecrã, para o teste poder fazer entrar «a mesma pessoa»
   duas vezes. */
const sujeitoDe = (quem) => `${s256(String(quem).toLowerCase()).slice(0, 20)}.0000.1111`;

function idTokenDeMentira({ cliente, sujeito, nonce }) {
  const agora = Math.floor(Date.now() / 1000);
  const cabecalho = base64url(JSON.stringify({ alg: 'RS256', kid: 'de-mentira' }));
  /* SEM `email` e sem `email_verified`: é o que a Apple manda quando não se
     pede âmbito nenhum, que é o nosso caso. Um teste contra uma imitação
     generosa de mais não prova nada. */
  const corpo = base64url(JSON.stringify({
    iss: 'https://appleid.apple.com',
    aud: cliente,
    sub: sujeito,
    nonce,
    iat: agora,
    exp: agora + 3600,
  }));
  return `${cabecalho}.${corpo}.${base64url('assinatura-de-mentira')}`;
}

function paginaDeAutorizacao({ codigo, estado, sugestao }) {
  return `<!doctype html><html lang="pt"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Utilizar o ID Apple (Apple de mentira)</title>
<style>
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 32px;
         background: #fff; color: #1d1d1f; }
  main { max-width: 420px; margin: 0 auto; }
  h1 { font-size: 22px; font-weight: 600; }
  label { display: block; margin: 16px 0 6px; font-size: 13px; color: #6e6e73; }
  input { width: 100%; box-sizing: border-box; padding: 12px; font-size: 16px;
          border: 1px solid #d2d2d7; border-radius: 10px; }
  .botoes { display: flex; gap: 12px; justify-content: flex-end; margin-top: 28px; }
  button { font: inherit; padding: 10px 22px; border-radius: 980px; border: 0; cursor: pointer; }
  .principal { background: #000; color: #fff; }
  .fantasma { background: transparent; color: #06c; }
  .aviso { margin-top: 28px; font-size: 12px; color: #86868b; }
</style></head><body><main>
<h1>Iniciar sessão com o ID Apple</h1>
<form method="POST" action="/auth/aprovar">
  <input type="hidden" name="codigo" value="${escapar(codigo)}">
  <input type="hidden" name="estado" value="${escapar(estado)}">
  <label for="quem">ID Apple</label>
  <input id="quem" name="quem" type="text" value="${escapar(sugestao)}" autocomplete="off">
  <div class="botoes">
    <button type="submit" name="decisao" value="nao" class="fantasma" id="cancelar">Cancelar</button>
    <button type="submit" name="decisao" value="sim" class="principal" id="continuar">Continuar</button>
  </div>
</form>
<p class="aviso">Isto não é a Apple. É o servidor de mentira que existe para
este caminho poder ser provado sem Internet e sem conta de programador.</p>
</main></body></html>`;
}

const corpoDe = (pedido) => new Promise((resolve) => {
  let dados = '';
  pedido.on('data', (p) => { dados += p; });
  pedido.on('end', () => resolve(dados));
});

const responder = (res, estado, dados) => {
  res.writeHead(estado, { 'content-type': 'application/json' });
  res.end(JSON.stringify(dados));
};

const servidor = createServer(async (pedido, res) => {
  const url = new URL(pedido.url, `http://localhost:${PORTA}`);
  const caminho = url.pathname;
  const corpo = await corpoDe(pedido);

  if (caminho === '/__visto') return responder(res, 200, visto);
  if (caminho === '/__limpar') {
    visto = []; codigos.clear();
    return responder(res, 200, { ok: true });
  }

  /* O ecrã de autorização. O código nasce aqui e só vale depois do sim. */
  if (caminho === '/auth/authorize') {
    visto.push({ metodo: pedido.method, caminho, consulta: Object.fromEntries(url.searchParams) });
    const codigo = randomBytes(18).toString('base64url');
    codigos.set(codigo, {
      cliente: url.searchParams.get('client_id'),
      redireccao: url.searchParams.get('redirect_uri'),
      nonce: url.searchParams.get('nonce'),
      quem: null,
    });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(paginaDeAutorizacao({
      codigo, estado: url.searchParams.get('state') || '', sugestao: 'alguem@icloud.com',
    }));
  }

  if (caminho === '/auth/aprovar') {
    const form = new URLSearchParams(corpo);
    const codigo = form.get('codigo') || '';
    const pedidoOriginal = codigos.get(codigo);
    if (!pedidoOriginal) return responder(res, 400, { error: 'código desconhecido' });
    const destino = new URL(pedidoOriginal.redireccao);
    destino.searchParams.set('state', form.get('estado') || '');
    if (form.get('decisao') === 'sim') {
      pedidoOriginal.quem = (form.get('quem') || 'alguem@icloud.com').trim().toLowerCase();
      destino.searchParams.set('code', codigo);
    } else {
      codigos.delete(codigo);
      /* A Apple devolve `user_cancelled_authorize`, e não `access_denied`. */
      destino.searchParams.set('error', 'user_cancelled_authorize');
    }
    res.writeHead(302, { location: destino.toString() });
    return res.end();
  }

  if (caminho === '/auth/token') {
    const form = new URLSearchParams(corpo);
    visto.push({ metodo: pedido.method, caminho, bruto: corpo });
    const codigo = form.get('code') || '';
    const guardado = codigos.get(codigo);
    /* Um código serve uma vez, como do lado de lá. */
    codigos.delete(codigo);
    if (!guardado || !guardado.quem) return responder(res, 400, { error: 'invalid_grant' });
    if (form.get('redirect_uri') !== guardado.redireccao) {
      return responder(res, 400, { error: 'invalid_grant' });
    }
    /* O segredo de cliente TEM de ser um JWT com três partes. Não se verifica
       a assinatura — ver o cabeçalho — mas um cliente que mande outra coisa
       qualquer leva o mesmo `invalid_client` que a Apple lhe daria. */
    const segredo = String(form.get('client_secret') || '');
    if (segredo.split('.').length !== 3) return responder(res, 400, { error: 'invalid_client' });
    return responder(res, 200, {
      access_token: 'token-de-mentira',
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: idTokenDeMentira({
        cliente: guardado.cliente,
        sujeito: sujeitoDe(guardado.quem),
        nonce: guardado.nonce,
      }),
    });
  }

  return responder(res, 404, { error: `sem imitação para ${caminho}` });
});

servidor.listen(PORTA, () => {
  if (process.env.CALADO !== 'sim') console.log(`Apple de mentira em http://localhost:${PORTA}`);
});

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => { servidor.close(); process.exit(0); });
}
