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

   Uso:  node scripts/google-de-mentira.mjs [porta]

   Endereços próprios, fora da imitação:
     GET  /__visto      tudo o que recebeu, por ordem
     POST /__limpar     esquece tudo
     POST /__avariar    a próxima chamada responde 500 (para provar que uma
                        falha da Google não faz falhar um carimbo)
   ========================================================================= */

import { createServer } from 'node:http';

const PORTA = Number(process.argv[2]) || 8799;

let visto = [];
let avariarProximo = 0;

function corpoDe(pedido) {
  return new Promise((resolve) => {
    let dados = '';
    pedido.on('data', (p) => { dados += p; });
    pedido.on('end', () => resolve(dados));
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
  const corpo = await corpoDe(pedido);

  /* --- os endereços de controlo ---------------------------------------- */
  if (caminho === '/__visto') return responder(res, 200, visto);
  if (caminho === '/__limpar') { visto = []; avariarProximo = 0; return responder(res, 200, { ok: true }); }
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

  /* O testemunho de acesso. O Worker manda um JWT assinado; aqui não se
     verifica — quem verifica assinaturas é o teste do `wallet.js`. */
  if (caminho === '/token') {
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
