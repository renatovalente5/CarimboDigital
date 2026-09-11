#!/usr/bin/env node
/* =========================================================================
   Carimbo Digital — o email

   As duas metades vivem no mesmo sítio: `geral@carimbodigital.pt` é uma
   caixa da Hostinger, que recebe o correio e por onde saem os códigos de
   entrada. Nada sai da União Europeia e não há subcontratante nenhum a mais.

   Chegou-se aqui depois de a Resend estar planeada e quase montada. O que a
   desfez foi descobrir que a Hostinger tem API de correio incluída no plano,
   com mil a três mil envios por DIA — contra três mil por mês do plano
   gratuito da Resend — e sem transferir nada para fora da Europa.

   O que este script faz:

   · confere o DNS do domínio, que é onde os erros são silenciosos: um SPF a
     mais invalida o que lá estava, um DKIM em falta manda tudo para o spam,
     e nada disto dá erro em lado nenhum — dá emails que não chegam, dias
     depois;
   · com um token, descobre o identificador da caixa (que vai para o
     `MAIL_CAIXA` do wrangler.toml) e mostra a quota que resta;
   · com `--enviar`, manda um email de prova a sério.

   Uso:
     node scripts/email.mjs
     MAIL_TOKEN=... node scripts/email.mjs
     MAIL_TOKEN=... node scripts/email.mjs --enviar --destino outro@email.pt

   O TOKEN NÃO SE GUARDA AQUI nem no repositório. Em produção vive num
   segredo do Worker:  npx wrangler secret put MAIL_TOKEN

   E convém saber o que ele abre: a API da Hostinger não tem âmbito
   só-de-envio. O mesmo token lê, procura e apaga o correio desta caixa.
   ========================================================================= */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as dns } from 'node:dns';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
const config = JSON.parse(readFileSync(join(RAIZ, '_fonte', 'config.json'), 'utf8'));
const DOMINIO = config.dominio;
const API = 'https://api.mail.hostinger.com/api/v1';

const args = process.argv.slice(2);
const DESTINO = args.includes('--destino') ? args[args.indexOf('--destino') + 1] : config.contacto;
const ENVIAR = args.includes('--enviar');
const TOKEN = process.env.MAIL_TOKEN || '';

/* Resolvedor público: o do sistema pode ter em cache o que havia antes de se
   mexer no painel, e isso já valeu meia hora a olhar para um registo que
   estava lá à frente. */
dns.setServers(['1.1.1.1', '8.8.8.8']);

let erros = 0, avisos = 0;
const bem = (t) => console.log(`  ✓ ${t}`);
const mal = (t, d = '') => { erros++; console.log(`  ✗ ${t}${d ? ` — ${d}` : ''}`); };
const talvez = (t, d = '') => { avisos++; console.log(`  ! ${t}${d ? ` — ${d}` : ''}`); };

const txt = async (n) => { try { return (await dns.resolveTxt(n)).map((p) => p.join('')); } catch { return []; } };
const mx = async (n) => { try { return await dns.resolveMx(n); } catch { return []; } };
const cname = async (n) => { try { return await dns.resolveCname(n); } catch { return []; } };

const pedir = async (caminho) => {
  const r = await fetch(API + caminho, { headers: { authorization: `Bearer ${TOKEN}` } });
  const corpo = await r.json().catch(() => null);
  return { estado: r.status, corpo };
};

console.log(`\nO email de ${DOMINIO}\n${'─'.repeat(52)}`);

/* --- o DNS --------------------------------------------------------------- */
console.log('\nDNS');
{
  const registos = await mx(DOMINIO);
  if (!registos.length) mal('sem MX — o domínio não recebe email nenhum');
  else bem(`MX: ${registos.map((r) => `${r.exchange} (${r.priority})`).join(', ')}`);

  const spf = (await txt(DOMINIO)).filter((t) => t.toLowerCase().startsWith('v=spf1'));
  if (!spf.length) {
    mal('sem SPF — o que sair desta caixa vai direito ao spam');
  } else if (spf.length > 1) {
    /* Dois SPF não são «mais protecção»: são nenhuma. A norma diz que um
       domínio com mais do que um registo SPF é um erro permanente, e os
       filtros tratam-no como se não existisse. */
    mal(`${spf.length} registos SPF — a norma só permite um, e com dois nenhum vale`, spf.join(' | '));
  } else {
    bem(`SPF: ${spf[0]}`);
    if (!/hostinger/i.test(spf[0])) {
      talvez('o SPF não menciona a Hostinger, que é quem envia', spf[0]);
    }
  }

  /* O DKIM da Hostinger são três CNAME. Basta faltar um para a assinatura
     rodar para uma chave que não existe e o email começar a chegar sem
     assinatura — intermitentemente, que é o pior dos casos para diagnosticar. */
  const chaves = ['a', 'b', 'c'];
  const faltam = [];
  for (const k of chaves) {
    const r = await cname(`hostingermail-${k}._domainkey.${DOMINIO}`);
    if (!r.length) faltam.push(k);
  }
  if (faltam.length) mal(`faltam ${faltam.length} dos 3 CNAME de DKIM da Hostinger`, `hostingermail-${faltam.join(', -')}`);
  else bem('DKIM: os três CNAME da Hostinger estão lá');

  const dmarc = (await txt(`_dmarc.${DOMINIO}`)).filter((t) => t.toLowerCase().startsWith('v=dmarc1'));
  if (!dmarc.length) talvez('sem DMARC');
  else {
    bem(`DMARC: ${dmarc[0]}`);
    if (/p=none/i.test(dmarc[0])) {
      talvez('a política do DMARC é «none» — observa e não recusa nada',
        'depois de os envios estabilizarem, subir para quarantine');
    }
  }

  /* Sobras da Resend. Ficaram a apontar para um serviço que já não se usa, e
     um SPF de um remetente que não envia é uma autorização em branco. */
  const restos = [];
  for (const n of [`resend._domainkey.${DOMINIO}`, `send.${DOMINIO}`]) {
    if ((await txt(n)).length || (await mx(n)).length) restos.push(n);
  }
  if (restos.length) {
    talvez('sobraram registos da Resend no DNS', `apagar: ${restos.join(', ')}`);
  }
}

/* --- a caixa ------------------------------------------------------------- */
console.log('\nA caixa');
if (!TOKEN) {
  talvez('sem MAIL_TOKEN no ambiente — não dá para ver as caixas nem a quota',
    'hPanel › Emails › API, e depois MAIL_TOKEN=... node scripts/email.mjs');
} else {
  const eu = await pedir('/me');
  if (eu.estado === 401) {
    mal('o token não foi aceite (401)', 'está gasto, ou é de outra conta');
  } else if (eu.estado !== 200) {
    mal(`a API respondeu ${eu.estado}`, JSON.stringify(eu.corpo).slice(0, 160));
  } else {
    const caixas = (eu.corpo && (eu.corpo.data?.mailboxes || eu.corpo.data)) || [];
    const lista = Array.isArray(caixas) ? caixas : [caixas];
    if (!lista.length) mal('o token não vê caixa nenhuma');
    else {
      bem(`${lista.length} caixa${lista.length > 1 ? 's' : ''}:`);
      for (const c of lista) {
        console.log(`      ${c.address}  →  MAIL_CAIXA = "${c.resourceId}"`);
      }
      const nossa = lista.find((c) => String(c.address || '').endsWith(`@${DOMINIO}`));
      if (!nossa) {
        talvez(`nenhuma caixa é de @${DOMINIO}`);
      } else {
        const q = await pedir(`/mailboxes/${nossa.resourceId}/quota`);
        if (q.estado === 200) console.log(`      quota: ${JSON.stringify(q.corpo?.data ?? q.corpo)}`);
      }
    }
  }
}

/* --- o envio a sério ----------------------------------------------------- */
if (ENVIAR) {
  console.log('\nEnvio de prova');
  const caixa = process.env.MAIL_CAIXA;
  if (!TOKEN || !caixa) {
    mal('preciso de MAIL_TOKEN e MAIL_CAIXA',
      'o MAIL_CAIXA é o identificador que aparece acima');
  } else {
    const { emailCodigoCliente } = await import('../worker/src/emails.js');
    const m = emailCodigoCliente({ codigo: '424242', minutos: 15 });
    const r = await fetch(`${API}/mailboxes/${caixa}/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        to: [DESTINO], displayName: 'Carimbo Digital',
        subject: m.assunto, text: m.texto, html: m.html,
      }),
    });
    /* 204 e não 200: a API responde sem corpo nenhum quando o email sai. */
    if (r.status === 204 || r.ok) bem(`enviado para ${DESTINO}`);
    else mal(`a Hostinger recusou (${r.status})`, (await r.text().catch(() => '')).slice(0, 200));
  }
}

/* --- o resumo ------------------------------------------------------------ */
console.log(`\n${'─'.repeat(52)}`);
if (erros) {
  console.log(`${erros} coisa${erros > 1 ? 's' : ''} em falta, ${avisos} a pensar.\n`);
} else {
  console.log(`Tudo no sítio${avisos ? `, com ${avisos} nota${avisos > 1 ? 's' : ''}` : ''}.\n`);
}
process.exit(erros ? 1 : 0);
