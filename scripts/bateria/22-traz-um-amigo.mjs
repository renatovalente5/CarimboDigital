/* =========================================================================
   Bateria · 22 — Traz um amigo

   «Cada cliente traz outro, e ganham os dois.» É a forma mais barata que um
   café tem de crescer, e é também a mais fácil de vigarizar — por isso o que
   este módulo persegue não é «o botão partilha um link»:

   · A OFERTA É DO CAFÉ, e o botão só existe onde ela existe. Um «traz um
     amigo» num cartão que não dá nada é uma promessa que ninguém fez.

   · O CONVITE DIZ QUANDO É QUE PAGA. «Assim que ele for carimbado pela
     primeira vez» não é letra pequena: é a diferença entre um convite que
     parece não ter funcionado e um convite que está à espera de alguém ir ao
     café.

   · ADERIR NÃO PAGA NADA. Percorre-se o caminho todo de quem chega por um
     link — o cartão junta-se, e os carimbos NÃO aparecem — e só depois se vai
     ao balcão. É a regra que impede uma máquina de fazer carimbos a partir de
     um telemóvel e paciência, e é a que mais custa se estiver errada.

   · E O BALCÃO TEM DE PERCEBER. Um cartão que salta dois carimbos em vez de um
     sem nada que o explique parece um erro da app.

   Corre em modo de demonstração, onde o Café Torrado tem a oferta ligada (um
   carimbo para cada lado) e os outros não — que é como um programa nasce.
   ========================================================================= */

import { passarBoasVindas, abrirOCartaoTodo } from './01-arranque.mjs';

export const nome = '22 · Traz um amigo';

const CARTEIRA = '.barra-item[data-ecra="carteira"]';

const dormir = (palco, ms) =>
  palco.js(`await new Promise((r) => setTimeout(r, ${ms})); return true`);

const limparAvisos = (palco) => palco.js(
  "for (const n of document.querySelectorAll('.aviso')) n.remove(); return true");

/** Abre o cartão de um negócio, pelo nome. */
async function abrirCartao(palco, nome) {
  await palco.clicar(CARTEIRA);
  await palco.esperar('#principal .pilha .cartao', 8000);
  const achou = await palco.js(`
    const c = [...document.querySelectorAll('#principal .pilha > .cartao')]
      .find((n) => (n.querySelector('.cartao-nome')?.textContent || '')
        .includes(${JSON.stringify(nome)}));
    if (!c) return false;
    c.setAttribute('data-prova', 'cartao');
    return true`);
  if (!achou) return false;
  return abrirOCartaoTodo(palco, nome);
}

/** O estado da demonstração, lido de volta. */
const demo = (palco) => palco.js(`
  const c = localStorage.getItem('carimbo-demo:demo');
  return c ? JSON.parse(c) : null`);

export async function correr(palco, certo) {
  await palco.ir('/app/?demo=1');
  await passarBoasVindas(palco);
  await palco.esperar('#barra .barra-item');

  /* --- 1. O BOTÃO SÓ EXISTE ONDE A OFERTA EXISTE ------------------------ */
  certo(await abrirCartao(palco, 'Café Torrado'),
    'o cartão do Café Torrado abre-se');
  certo(await palco.ver('#traz-amigo'),
    'e tem «Traz um amigo», porque este café ligou a oferta');

  certo(await abrirCartao(palco, 'Gelataria Luar'),
    'o cartão da Gelataria abre-se');
  certo(!(await palco.ver('#traz-amigo')),
    'e NÃO tem «Traz um amigo» — um botão que promete carimbos num sítio que '
    + 'não os dá é uma promessa que ninguém fez');

  /* --- 2. O CONVITE DIZ O QUE É E QUANDO PAGA --------------------------- */
  await abrirCartao(palco, 'Café Torrado');
  await palco.clicar('#traz-amigo');
  await palco.esperar('#convite-endereco', 8000);
  const painel = await palco.texto('#painel');
  certo(painel.includes('carimbado pela primeira vez'),
    'o painel diz QUANDO é que isto paga — não é letra pequena, é a diferença '
    + 'entre um convite avariado e um convite à espera', painel.slice(0, 200));
  certo(painel.includes('ele ganha 1 carimbo e tu também'),
    'e diz quanto ganha cada lado — sem repetir a mesma coisa duas vezes',
    painel.slice(0, 220));

  const endereco = await palco.texto('#convite-endereco');
  certo(endereco.includes('/app/?n=cafe-torrado&a='),
    'o link leva o negócio e o convite', endereco);
  const codigo = decodeURIComponent(endereco.split('&a=')[1] || '');
  certo(codigo.includes('.'),
    'e o convite leva uma assinatura a seguir ao número público — sem ela, '
    + 'bastava saber um número que é dito em voz alta ao balcão todos os dias',
    codigo);

  /* O ENDEREÇO ESTÁ À VISTA, e não só dentro de um botão de partilha: nem
     toda a gente tem o menu do sistema. */
  certo(await palco.visivel('#convite-endereco'),
    'o endereço está no ecrã para se poder ler e copiar à mão');
  certo(await palco.ver('#partilhar-convite'),
    'e há um botão para o menu de partilha do telemóvel');

  await palco.tecla('Escape');
  await palco.sumir('#painel');

  /* --- 3. QUEM CHEGA PELO LINK JUNTA O CARTÃO E NÃO GANHA NADA ---------- */
  /* Este é o coração do módulo. Abre-se o link NOUTRO TELEMÓVEL — outro
     armazenamento, outra conta — e confere-se que o cartão se junta e que
     ninguém ganha carimbo nenhum antes de alguém ir ao balcão. */
  const meuPublico = await palco.js(`
    return JSON.parse(localStorage.getItem('carimbo-demo:cliente')).publico`);

  /* UM TELEMÓVEL NOVO, E NÃO UM MUNDO NOVO. O `localStorage.clear()` apaga
     também o `carimbo-demo:demo`, que é o SERVIDOR da demonstração — com ele,
     desaparecia quem convidou, e o convite não tinha a quem ser atribuído.
     Apaga-se tudo o que é do telemóvel e deixa-se a base de dados em paz. */
  await palco.js(`
    for (const k of Object.keys(localStorage)) {
      if (k !== 'carimbo-demo:demo') localStorage.removeItem(k);
    }
    await new Promise((r) => {
      const d = indexedDB.deleteDatabase('carimbo');
      d.onsuccess = d.onerror = d.onblocked = r;
    });
    return true`);

  /* E LARGA-SE O CARTÃO QUE A SEMENTE DÁ. A demonstração dá cartões a quem
     abre a app — é o que a torna uma demonstração —, e quem já tem o cartão não
     chega por um convite: aderir outra vez pelo link de um amigo seria a forma
     mais simples de o vigarizar, e o servidor recusa-o. Larga-se para
     percorrer o caminho de quem não tem. */
  await palco.ir('/app/?demo=1');
  await passarBoasVindas(palco);
  await palco.esperar('#barra .barra-item', 10000);
  await palco.js(`
    const { api } = await import('/js/api.js');
    const eu = JSON.parse(localStorage.getItem('carimbo-demo:cliente'));
    const meus = await api.cartoes(eu.id);
    const torrado = meus.find((c) => c.programa.id === 'p-torrado');
    if (torrado) await api.largarCartao(torrado.id);
    return true`);
  await palco.ir(`/app/?demo=1&n=cafe-torrado&a=${encodeURIComponent(codigo)}`);
  await passarBoasVindas(palco);
  await palco.esperar('#barra .barra-item', 10000);
  await dormir(palco, 1200);

  const avisoDeChegada = await palco.textoTodo();
  certo(avisoDeChegada.includes('Cartão de Café Torrado adicionado'),
    'quem abre o link junta o cartão');
  certo(/começas com um carimbo|começas com 1 carimbo/.test(avisoDeChegada),
    'e é-lhe dito que há um carimbo à espera dele — sem isto, ninguém percebe '
    + 'que falta ir ao café', avisoDeChegada.slice(0, 260));
  await limparAvisos(palco);

  const registo = await demo(palco);
  const convites = (registo && registo.amigos) || [];
  certo(convites.length === 1 && convites[0].premiadoEm === null,
    'o convite fica registado e POR PAGAR', JSON.stringify(convites));

  const euAgora = await palco.js(`
    return JSON.parse(localStorage.getItem('carimbo-demo:cliente')).publico`);
  certo(euAgora !== meuPublico,
    'e quem chegou é mesmo outra conta (o teste é válido)',
    `${meuPublico} -> ${euAgora}`);

  await abrirCartao(palco, 'Café Torrado');
  const carimbosAoChegar = await palco.js(`
    return document.querySelectorAll('#principal .carimbo[data-estado="cheio"]').length`);
  certo(carimbosAoChegar === 0,
    'E ADERIR NÃO DÁ CARIMBO NENHUM. É a regra que impede uma máquina de fazer '
    + 'carimbos a partir de um telemóvel e paciência',
    `${carimbosAoChegar} carimbos`);

  /* --- 4. QUEM CHEGOU NÃO PODE CONVIDAR-SE A SI PRÓPRIO ----------------- */
  const antesDeSeConvidar = ((await demo(palco)).amigos || []).length;
  const meuCodigo = await palco.js(`
    const { api } = await import('/js/api.js');
    const r = await api.meuConvite('p-torrado');
    return r.codigo`);
  await palco.ir(`/app/?demo=1&n=cafe-torrado&a=${encodeURIComponent(meuCodigo)}`);
  await palco.esperar('#barra .barra-item', 10000);
  await dormir(palco, 1000);
  certo(((await demo(palco)).amigos || []).length === antesDeSeConvidar,
    'ninguém se convida a si próprio — dois telemóveis e a mesma conta é o '
    + 'primeiro sítio onde alguém vai bater');
  await limparAvisos(palco);

  /* --- 5. E O BALCÃO PAGA, E EXPLICA-SE --------------------------------- */
  const publicoDoAmigo = await palco.js(`
    return JSON.parse(localStorage.getItem('carimbo-demo:cliente')).publico`);

  await palco.ir('/balcao/?demo=1');
  await palco.esperar('#entrada-acoes .btn-cheio', 10000);
  await palco.clicar('#entrada-acoes .btn-cheio');
  await palco.esperar('#barra .barra-item', 10000);
  await palco.clicar('#botao-manual');
  await palco.esperar('#campo-numero', 8000);
  await palco.escrever('#campo-numero', publicoDoAmigo);
  await palco.clicar('.painel-folha .btn-cheio');
  await palco.esperar('#resultado', 10000);
  await dormir(palco, 600);

  const resultado = await palco.texto('#resultado');
  certo(await palco.ver('.resultado-amigo'),
    'o balcão diz que este cliente veio por um convite');
  certo(resultado.includes('para quem chegou') && resultado.includes('para quem o trouxe'),
    'e diz quanto foi para cada lado — um cartão que salta dois carimbos sem '
    + 'explicação parece um erro da app', resultado.slice(0, 260));

  const depoisDoCarimbo = await demo(palco);
  const pago = (depoisDoCarimbo.amigos || [])[0];
  certo(pago && pago.premiadoEm,
    'e o convite fica marcado como pago', JSON.stringify(pago));

  const cartoes = depoisDoCarimbo.cartoes.filter((c) => c.programaId === 'p-torrado');
  const doAmigo = cartoes.find((c) => c.clienteId === pago.convidado);
  const doAnfitriao = cartoes.find((c) => c.clienteId === pago.convidador);
  certo(doAmigo && doAmigo.carimbos === 2,
    'quem chegou fica com o carimbo do balcão mais o do convite',
    JSON.stringify(doAmigo && doAmigo.carimbos));
  certo(doAnfitriao && doAnfitriao.carimbos >= 1,
    'e quem convidou ganha o dele sem ter de lá estar',
    JSON.stringify(doAnfitriao && doAnfitriao.carimbos));

  /* --- 6. E O CAFÉ PODE DESLIGAR ---------------------------------------- */
  /* O ecrã do resultado fica por cima da barra — fecha-se primeiro, que é o
     que uma pessoa faz. */
  await palco.tecla('Escape');
  await palco.sumir('#resultado', 6000);
  await palco.clicar('#barra .barra-item[data-ecra="programa"]');
  await palco.esperar('#f-amigo-convidador', 8000);
  certo(await palco.js(`
    return document.querySelector('#f-amigo-convidador').value`) === '1',
    'o balcão mostra o que está ligado', await palco.js(
      "return document.querySelector('#f-amigo-convidador').value"));
  const explicacao = await palco.texto('#seccao-traz-amigo');
  certo(explicacao.includes('primeiro carimbo'),
    'e explica ao dono quando é que isto lhe custa dinheiro',
    explicacao.slice(0, 200));

  await palco.preencher('#f-amigo-convidador', '0');
  await palco.preencher('#f-amigo-convidado', '0');
  await palco.clicar('#principal .btn-cheio');
  await dormir(palco, 1200);
  const desligado = await palco.js(`
    const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
    const p = e.negocios.flatMap((n) => n.programas).find((x) => x.id === 'p-torrado');
    return p.amigo;`);   /* o balcão da demonstração é o do Café Torrado */
  certo(desligado && desligado.convidador === 0 && desligado.convidado === 0,
    'e desligar desliga mesmo — quem paga é que decide',
    JSON.stringify(desligado));
}
