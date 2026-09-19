/* =========================================================================
   A APNs — o toque que diz ao iPhone «vai ver o teu passe»

   Um passe da Apple Wallet não se actualiza por a gente lhe mandar dados
   novos: manda-se uma notificação VAZIA, e é o iPhone que decide vir buscar.
   O conteúdo do push é, literalmente, a chaveta vazia.

   DUAS AUTENTICAÇÕES, E A DOCUMENTADA É A MAIS FRÁGIL AQUI. A Apple documenta
   o caminho do certificado (mTLS com o certificado de Pass Type ID), mas esse
   obriga a carregar o certificado para a conta da Cloudflare — fora do
   repositório, fora dos segredos do Worker, e com renovação anual a marcar na
   agenda. A autenticação por TOKEN — um JWT ES256 assinado com uma chave .p8
   — não está documentada para passes, e funciona: o `apns-topic` é o Pass
   Type ID. Está provado em produção por implementações públicas na mesma
   pilha (Workers + D1) e por respostas de engenheiros da Apple no fórum.

   O QUE NÃO SE PROVA AQUI. O `wrangler dev` em macOS NÃO consegue falar com a
   APNs: o workerd local não faz HTTP/2 (defeito workerd#4841, ainda aberto).
   Isto só se prova contra o Worker PUBLICADO, e num iPhone a sério — o
   simulador do iOS não regista para notificações, e a própria Apple o diz.
   ========================================================================= */

const APNS = 'https://api.push.apple.com/3/device/';

/* Cinquenta minutos. O bilhete vale uma hora do lado da Apple, e ela RECUSA
   quem o renove mais do que uma vez em cada vinte minutos — com
   `TooManyProviderTokenUpdates`, que é um 429 que não se percebe à primeira.
   Cinquenta deixa dez de folga para o relógio e fica muito acima dos vinte. */
const BILHETE_VALE = 50 * 60;

function base64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const cru = (texto) => new TextEncoder().encode(texto);

/** A app está ligada? Enquanto não houver chave, tudo isto fica calado. */
export const apnsLigada = (env) => Boolean(
  env.APNS_KID && env.APNS_CHAVE && env.APPLE_EQUIPA && env.APPLE_PASS_TIPO);

/**
 * Importa a chave .p8 do APNs.
 *
 * O ficheiro que a Apple dá é um PEM PKCS#8 com cabeçalho e rodapé. Uma
 * variável de ambiente não leva mudanças de linha, por isso aceita-se o PEM
 * escrito de qualquer maneira e deitam-se fora TODOS os brancos — é a mesma
 * tolerância que o `wallet.js` já tem para a chave RSA da Google, e pela mesma
 * razão: quem cola isto num painel não vai reparar num espaço.
 */
async function chaveDoBilhete(p8) {
  const corpo = String(p8)
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');
  const bytes = Uint8Array.from(atob(corpo), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8', bytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/**
 * O bilhete, assinado ou reaproveitado.
 *
 * Um Worker não tem memória entre pedidos, e por isso o caminho natural —
 * assinar um bilhete novo a cada push — é precisamente o que a Apple castiga.
 * O bilhete vive numa linha do D1 e reutiliza-se.
 */
export async function bilheteAPNs(env) {
  const agora = Math.floor(Date.now() / 1000);
  try {
    const guardado = await env.DB.prepare(
      'SELECT jwt, assinado_em FROM apns_bilhete WHERE id = 1').first();
    if (guardado && agora - guardado.assinado_em < BILHETE_VALE) return guardado.jwt;
  } catch { /* tabela ainda não migrada: assina-se um novo e segue-se */ }

  const chave = await chaveDoBilhete(env.APNS_CHAVE);
  /* O `kid` vai no CABEÇALHO e o `iss` no corpo. Trocá-los dá um 403
     `InvalidProviderToken` que não diz qual dos dois está no sítio errado. */
  const cabecalho = base64url(cru(JSON.stringify({ alg: 'ES256', kid: env.APNS_KID })));
  const corpo = base64url(cru(JSON.stringify({ iss: env.APPLE_EQUIPA, iat: agora })));
  const assinatura = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, chave, cru(`${cabecalho}.${corpo}`));
  /* A WebCrypto devolve `r || s` em cru, que é o que um JWS ES256 quer. O
     `node:crypto` devolveria DER — é a armadilha clássica deste caminho, e
     está aqui escrita porque já mordeu no `push.js`. */
  const jwt = `${cabecalho}.${corpo}.${base64url(assinatura)}`;

  try {
    await env.DB.prepare(
      `INSERT INTO apns_bilhete (id, jwt, assinado_em) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET jwt = excluded.jwt, assinado_em = excluded.assinado_em`
    ).bind(jwt, agora).run();
  } catch { /* não deu para guardar: o push sai na mesma, com este bilhete */ }
  return jwt;
}

/**
 * Toca num aparelho.
 *
 * Devolve `{ estado, motivo }` — e o que chama trata o 410, que é a Apple a
 * dizer que aquele aparelho já não existe.
 *
 * @param {string} testemunho  o pushToken, em hexadecimal, tal como o iPhone o deu
 */
export async function tocarNaWallet(env, testemunho, jwt) {
  const r = await fetch(APNS + testemunho, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      /* O tópico de um push de passe é o Pass Type ID, e não um bundle id.
         É por isso que a chave .p8 tem de ser da EQUIPA inteira: a opção
         «topic-specific» do portal da Apple só aceita bundle ids, e uma chave
         presa a um deles dá 403 a isto sem dizer porquê. */
      'apns-topic': env.APPLE_PASS_TIPO,
      /* `alert` e não `background`: é o que a Apple responde a quem pergunta
         por passes. Se algum dia vier `InvalidPushType`, tira-se. */
      'apns-push-type': 'alert',
      /* UMA SEMANA, E NUNCA ZERO. `apns-expiration: 0` diz à APNs para tentar
         UMA vez e não guardar — quem estivesse sem rede no momento do carimbo
         ficava com o cartão parado para sempre, e nós víamos um 200 e dávamos
         a coisa por feita. É o defeito que parece funcionar. */
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 7 * 24 * 3600),
      /* Prioridade 5: é o que se usa para um push que não acorda o ecrã. */
      'apns-priority': '5',
      'content-type': 'application/json',
    },
    /* A chaveta vazia, em dois bytes. Não é um corpo vazio nem um
       `content-available`: é mesmo isto que a Apple espera num push de passe. */
    body: '{}',
    /* A APNs responde com redireccionamentos em alguns erros, e segui-los
       perde os cabeçalhos de autenticação e transforma um erro legível num
       erro que não se percebe. */
    redirect: 'manual',
  });
  if (r.status === 200) return { estado: 200, motivo: null };
  let motivo = null;
  try { motivo = (await r.json()).reason || null; } catch { /* sem corpo */ }
  return { estado: r.status, motivo };
}

/**
 * Avisa todos os aparelhos que pediram para saber deste cartão.
 *
 * AOS BOCADOS, e é o limite que manda: uma invocação de Worker tem tecto de
 * CINQUENTA subpedidos, e cada push é um. Uma família com iPhones, iPads e
 * relógios chega lá depressa. Quem chama isto é o cron, e não o carimbo.
 */
export async function avisarAparelhos(env, serial, { tecto = 20 } = {}) {
  if (!apnsLigada(env)) return { tocados: 0, mortos: 0 };
  const registos = (await env.DB.prepare(
    `SELECT r.aparelho, a.testemunho
       FROM wallet_registos r JOIN wallet_aparelhos a ON a.aparelho = r.aparelho
      WHERE r.serial = ? LIMIT ?`
  ).bind(serial, tecto).all()).results || [];
  if (!registos.length) return { tocados: 0, mortos: 0 };

  const jwt = await bilheteAPNs(env);
  let tocados = 0;
  const mortos = [];
  for (const reg of registos) {
    try {
      const r = await tocarNaWallet(env, reg.testemunho, jwt);
      if (r.estado === 200) { tocados += 1; continue; }
      /* 410 é a Apple a dizer que aquele aparelho já não existe — e é a ÚNICA
         forma de saber de quem apagou o passe sem rede, porque esse nunca
         chega a mandar o DELETE. Sem esta limpeza a lista só cresce, e cada
         push desperdiçado gasta um dos cinquenta subpedidos. */
      if (r.estado === 410 || r.motivo === 'BadDeviceToken'
          || r.motivo === 'Unregistered') {
        mortos.push(reg.aparelho);
        continue;
      }
      console.error('apns: recusa', serial, r.estado, r.motivo);
    } catch (erro) {
      console.error('apns: não deu para tocar', serial, String(erro));
    }
  }
  for (const aparelho of mortos) {
    await env.DB.prepare('DELETE FROM wallet_aparelhos WHERE aparelho = ?')
      .bind(aparelho).run();
    await env.DB.prepare('DELETE FROM wallet_registos WHERE aparelho = ?')
      .bind(aparelho).run();
  }
  return { tocados, mortos: mortos.length };
}
