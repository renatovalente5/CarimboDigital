/* =========================================================================
   Bateria · 23 — Arrumar a carteira: ordem, arquivo e o caminho do teclado
   =========================================================================

   O QUE ESTE MÓDULO NÃO PODE PROVAR, e é preciso dizê-lo aqui para ninguém
   escrever a afirmação errada: que a ordem está no SERVIDOR. A bateria corre
   inteira em `?demo=1`, que é o `criarDemo()` do _fonte/js/api.js —
   localStorage, sem Worker nenhum por trás. Um teste que recarregasse a
   página e concluísse «sobreviveu, logo está no servidor» provava o
   contrário do que afirmava: em demonstração, o localStorage É o servidor.

   Essa promessa prova-se no worker/testes.mjs, com duas sessões da mesma
   conta contra D1 a sério, no grupo «Arrumar a carteira».

   O QUE SE PROVA AQUI é o ecrã: que o modo aparece quando deve, que as setas
   mexem mesmo, que o foco segue o cartão que se mexeu, que quem ouve o ecrã
   é avisado da posição nova, que o cartão com prémio não se mexe e diz
   porquê, e que os alvos têm o tamanho que o núcleo promete. */
import { entrarNaApp } from './01-arranque.mjs';

export const nome = '23 · Arrumar a carteira';
export const ecra = { largura: 375, altura: 812 };

const ORGANIZAR = '#botao-organizar';
const LINHA = '.organizar-lista li';

/* A CRASE DUPLICA AS BARRAS. Tudo o que vai dentro de `palco.js(\`…\`)` é um
   template literal: o JavaScript resolve as sequências de escape ANTES de o
   texto chegar à página, e um `\s` sozinho perde a barra e fica `s`. Escrito
   assim, o `replace(/\s+/g, ' ')` chegava como `replace(/s+/g, ' ')` e
   apagava todos os «s» do texto medido — «carimbos» virava «carimbo », e a
   afirmação falhava a apontar para a frase errada. Dentro destas crases,
   qualquer classe de regex leva DUAS barras. */

/** Os nomes dos cartões, na ordem em que estão no ecrã. */
const nomes = (palco, seletor) => palco.js(
  `return [...document.querySelectorAll(${JSON.stringify(seletor)})].map((n) => n.textContent)`);

export async function correr(palco, certo) {
  await palco.ir('/app/?demo=1');
  await entrarNaApp(palco, { porta: 'google' });
  await palco.esperar('#barra .barra-item');

  /* --- o botão existe e diz o que faz ---------------------------------- */
  certo(await palco.visivel(ORGANIZAR), 'carteira: o botão «Organizar» está à vista');
  certo(await palco.texto(ORGANIZAR) === 'Organizar',
    'e chama-se «Organizar»', String(await palco.texto(ORGANIZAR)));
  certo(await palco.js(`return document.querySelector('${ORGANIZAR}').getAttribute('aria-pressed')`) === 'false',
    'e diz que ainda não está carregado');

  /* --- a faixa do prémio passou a botão, e nomeia o café ---------------- */
  const faixa = await palco.js(`
    const f = document.querySelector('.faixa-premio');
    if (!f) return null;
    return { etiqueta: f.tagName, rotulo: f.getAttribute('aria-label') || '',
             texto: f.textContent.replace(/\\s+/g, ' ').trim() }`);
  certo(Boolean(faixa) && faixa.etiqueta === 'BUTTON',
    'a faixa do prémio é um botão, e não um bloco morto',
    faixa ? faixa.etiqueta : 'não há faixa');
  certo(Boolean(faixa) && /Gelataria Luar/.test(faixa.texto),
    'e nomeia o café onde está o prémio — senão manda procurar sem dizer onde',
    faixa ? faixa.texto : '');
  certo(Boolean(faixa) && /Ir para esse cart/.test(faixa.rotulo),
    'e diz a quem ouve que leva lá', faixa ? faixa.rotulo : '');

  /* --- entrar no modo --------------------------------------------------- */
  await palco.clicar(ORGANIZAR);
  await palco.esperar(LINHA);
  certo(await palco.texto(ORGANIZAR) === 'Pronto',
    'dentro do modo, o botão passa a «Pronto»', String(await palco.texto(ORGANIZAR)));
  certo(!(await palco.ver('.pilha-baralho')),
    'e o baralho desfaz-se: os cartões sobrepostos não dariam alvo limpo às setas');

  /* --- os nomes cabem --------------------------------------------------- */
  const cortados = await palco.js(`
    return [...document.querySelectorAll('.organizar-nome b')]
      .filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent)`);
  certo(cortados.length === 0,
    'nenhum nome de café sai cortado — numa lista de cinco «Ge…» não distingue nada',
    cortados.join(', '));

  /* --- as setas mexem mesmo, e o foco segue o cartão -------------------- */
  const antes = await nomes(palco, '.organizar-nome b');
  await palco.clicar(`${LINHA}:nth-child(2) [data-accao="descer"]`);
  await palco.esperar(LINHA);
  const depois = await nomes(palco, '.organizar-nome b');
  certo(antes[1] === depois[2] && antes[2] === depois[1],
    'a seta de descer troca mesmo o cartão com o de baixo',
    `${antes.join('>')}  →  ${depois.join('>')}`);

  const foco = await palco.js(
    `return document.activeElement ? document.activeElement.getAttribute('aria-label') : null`);
  certo(String(foco || '').startsWith('Descer'),
    'e o foco fica no botão que se usou, no cartão que se mexeu — não salta para o vazio',
    String(foco));

  const anuncio = await palco.texto('#anuncio-ordem');
  certo(/\d+ de \d+/.test(String(anuncio || '')),
    'e quem ouve o ecrã é avisado da posição nova', String(anuncio));

  /* --- os extremos não desaparecem da tabulação ------------------------- */
  const extremos = await palco.js(`
    const l = document.querySelectorAll('.organizar-lista li');
    const cima = l[1] && l[1].querySelector('[data-accao="subir"]');
    const baixo = l[l.length - 1] && l[l.length - 1].querySelector('[data-accao="descer"]');
    return { cimaDesactivado: cima ? cima.disabled : null,
             cimaAria: cima ? cima.getAttribute('aria-disabled') : null,
             baixoAria: baixo ? baixo.getAttribute('aria-disabled') : null }`);
  certo(extremos.cimaDesactivado === false,
    'a seta que não dá NÃO usa `disabled` — isso tirava-a da ordem de tabulação',
    JSON.stringify(extremos));
  certo(extremos.cimaAria === 'true' && extremos.baixoAria === 'true',
    'mas diz a quem ouve que não dá', JSON.stringify(extremos));

  /* --- o cartão com prémio não se mexe, e explica ----------------------- */
  const premiado = await palco.js(`
    const l = document.querySelector('.organizar-lista li');
    return { nome: l.querySelector('.organizar-nome b').textContent,
             setas: l.querySelectorAll('[data-accao="subir"], [data-accao="descer"]').length,
             nota: (l.querySelector('.organizar-nota') || {}).textContent || '' }`);
  certo(premiado.setas === 0,
    'o cartão com prémio não tem setas — mexê-lo era vê-lo saltar de volta ao sair',
    JSON.stringify(premiado));
  certo(/prémio/i.test(premiado.nota),
    'e diz porquê, em vez de ficar sem botões e sem explicação', premiado.nota);

  /* --- arrumar, e a frase que o distingue de apagar --------------------- */
  const quantasAntes = (await nomes(palco, '.organizar-nome b')).length;
  await palco.clicar(`${LINHA}:nth-child(4) [data-accao="arquivo"]`);
  await palco.esperar('.organizar-titulo');
  certo(await palco.ver('.organizar-titulo'),
    'arrumar um cartão abre a secção dos arrumados');
  const explicacao = await palco.js(`
    const t = document.querySelector('.organizar-titulo');
    const p = t && t.nextElementSibling;
    return p ? p.textContent.replace(/\\s+/g, ' ').trim() : ''`);
  certo(/carimbos/i.test(explicacao) && /vista/i.test(explicacao),
    'e diz que os carimbos ficam — senão «Arrumar» lê-se como «apagar», que é outro botão e não tem volta',
    explicacao);
  certo((await nomes(palco, '.organizar-nome b')).length === quantasAntes,
    'o cartão não desaparece: muda de secção', String(quantasAntes));

  /* --- e volta ---------------------------------------------------------- */
  await palco.clicar('[data-accao="arquivo"][aria-label^="Trazer"]');
  await palco.esperar(LINHA);
  certo(!(await palco.ver('.organizar-titulo')),
    'trazer de volta fecha a secção dos arrumados');

  /* --- sair guarda o que se fez ----------------------------------------- */
  const ordemNoModo = await nomes(palco, '.organizar-nome b');
  await palco.clicar(ORGANIZAR);
  await palco.esperar('.pilha-baralho');
  const noBaralho = await nomes(palco, '.cartao-nome');
  certo(JSON.stringify(noBaralho) === JSON.stringify(ordemNoModo),
    'sair do modo deixa o baralho exactamente na ordem que se escolheu',
    `${ordemNoModo.join('>')}  →  ${noBaralho.join('>')}`);

  /* --- os alvos têm o tamanho prometido -------------------------------- */
  await palco.clicar(ORGANIZAR);
  await palco.esperar(LINHA);
  const pequenos = await palco.js(`
    return [...document.querySelectorAll('.organizar-seta, .organizar-arrumar')]
      .map((n) => { const r = n.getBoundingClientRect();
                    return { q: n.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height) }; })
      .filter((x) => x.w < 44 || x.h < 44)`);
  certo(pequenos.length === 0,
    'todos os botões de arrumar têm pelo menos 44px nos dois lados',
    JSON.stringify(pequenos));
}
