/* =========================================================================
   Bateria · 21 — O mapa do «Descobrir»

   O mapa é desenhado dentro da app, a partir das fronteiras dos concelhos
   guardadas no próprio site. Não há mosaicos de servidor nenhum — e é isso que
   deixa a página de privacidade continuar a dizer, à letra, que «não carrega
   tipos de letra, mapas ou scripts de terceiros».

   O que este módulo persegue:

   · QUE O MAPA SEJA MESMO UM MAPA. Um alfinete por estabelecimento, e o número
     a bater certo com a lista. Um mapa com um alfinete a menos não se vê: vê-se
     um mapa, e pensa-se que aquele café não existe.

   · QUE O ALFINETE ABRA O NEGÓCIO CERTO. É indexado por identificador e nunca
     por posição na lista — um negócio com dois programas dá dois cartões, e
     indexar pela posição punha o alfinete a abrir o vizinho. Foi esse o defeito
     que noutro projecto desta casa passou semanas com a bateria toda a passar
     por cima dele, e por isso é aqui afirmado com um clique de RATO a sério.

   · QUE ELE NÃO SEGURE O ECRÃ. O desenho são cem kilobytes que vêm num pedido
     próprio; se o ecrã esperasse por eles, quem abre o «Descobrir» via um ecrã
     em branco por causa de uma coisa que está no fim.

   · QUE SE POSSA CONDUZIR SEM DEDOS. Arrastar, ampliar e as setas do teclado —
     e os alfinetes são `<button>`, logo são tabuláveis.

   · E QUE NÃO PROMETA PRECISÃO QUE NÃO TEM. O ponto que veio do centróide de um
     concelho desenha-se diferente do que veio do telemóvel, e diz-se a um
     leitor de ecrã que é aproximado.

   Corre em modo de demonstração, onde os seis negócios da semente têm
   coordenadas escritas à mão — um deles de propósito ao nível do concelho.
   ========================================================================= */

export const nome = '21 · O mapa do «Descobrir»';

const DESCOBRIR = '#barra .barra-item:nth-child(2)';
const MAPA = '#mapa-descobrir .mapa';
const DESENHO = '#mapa-descobrir .mapa-desenho';

const dormir = (palco, ms) =>
  palco.js(`await new Promise((r) => setTimeout(r, ${ms})); return true`);

/** O `viewBox` do mapa, já em números. É o estado da vista. */
const vista = (palco) => palco.js(`
  const v = document.querySelector('${DESENHO}')?.getAttribute('viewBox');
  if (!v) return null;
  const [x, y, largura, altura] = v.split(' ').map(Number);
  return { x, y, largura, altura };`);

export async function correr(palco, certo) {
  await palco.ir('/app/?demo=1');
  const { passarBoasVindas } = await import('./01-arranque.mjs');
  await passarBoasVindas(palco);
  await palco.esperar('#barra .barra-item');

  /* --- 1. O MAPA NÃO SEGURA O ECRÃ -------------------------------------- */
  /* A LISTA NÃO ESPERA PELO MAPA, e a forma de o provar é SEGURAR o mapa.

     A primeira versão desta afirmação media a ordem em que as duas coisas
     apareciam, e num servidor local o ficheiro do mapa chega tão depressa que
     chega primeiro — o que não prova nada num ou noutro sentido. Aqui trava-se
     o pedido dos concelhos durante três segundos e exige-se que a lista esteja
     inteira na mesma. É o caso de quem abre a app numa rede má, que é quando
     isto importa. */
  await palco.js(`
    window.__travaMapa = true;
    const original = window.fetch;
    window.fetch = async (...a) => {
      const url = String(a[0] && a[0].url ? a[0].url : a[0]);
      if (window.__travaMapa && url.includes('portugal.json')) {
        await new Promise((r) => setTimeout(r, 3000));
      }
      return original(...a);
    };
    return true`);
  await palco.clicar(DESCOBRIR);
  await palco.esperar('#principal .pilha .cartao', 3000);
  const comMapaPreso = await palco.js(`
    return { cartoes: document.querySelectorAll('#principal .pilha .cartao').length,
             mapa: Boolean(document.querySelector('${MAPA}')),
             erro: document.body.innerText.includes('Não deu para carregar') }`);
  certo(comMapaPreso.cartoes > 0 && !comMapaPreso.mapa,
    'com o mapa preso na rede, a lista aparece na mesma e inteira — cem '
    + 'kilobytes de fronteiras não podem segurar um ecrã',
    JSON.stringify(comMapaPreso));
  certo(!comMapaPreso.erro,
    'e não aparece nenhum aviso de erro por causa do mapa que ainda vem a caminho');

  await palco.js('window.__travaMapa = false; return true');
  await palco.esperar(MAPA, 9000);
  await dormir(palco, 700);
  certo(await palco.visivel(MAPA), 'e o mapa aparece a seguir, sozinho');

  /* --- 2. É MESMO UM MAPA ------------------------------------------------ */
  /* O NÚMERO EXACTO, lido do próprio ficheiro do mapa. «Mais do que duzentos»
     passava com um concelho em falta — e um concelho em falta não se vê: vê-se
     um buraco na forma do país e pensa-se que é assim mesmo. */
  const esperados = await palco.js(`
    const { carregarPortugal } = await import('/js/mapa.js');
    const d = await carregarPortugal('');
    return Object.fromEntries(d.folhas.map((f) => [f.nome, f.concelhos.length]));`);
  const concelhos = await palco.contar(`${DESENHO} path`);
  certo(concelhos === esperados.Continente,
    `o mapa desenha os ${esperados.Continente} concelhos do continente, todos`,
    `${concelhos} desenhados, ${esperados.Continente} no ficheiro`);
  certo(esperados.Continente + esperados['Açores'] + esperados.Madeira === 308,
    'e as três folhas somam os 308 concelhos de Portugal',
    JSON.stringify(esperados));

  /* E O PONTO TEM DE CAIR EM CIMA DO PAÍS, não apenas dentro da caixa da
     folha: a janela do continente inclui uma faixa de Espanha e muito
     Atlântico. */
  const emTerra = await palco.js(`
    const { carregarPortugal, emPortugal } = await import('/js/mapa.js');
    const d = await carregarPortugal('');
    return {
      ovar: emPortugal(d, 40.85944, -8.62528),
      funchal: emPortugal(d, 32.6485, -16.9082),
      badajoz: emPortugal(d, 38.8794, -6.9707),
      mar: emPortugal(d, 40.0, -9.5),
    };`);
  certo(emTerra.ovar && emTerra.funchal && !emTerra.badajoz && !emTerra.mar,
    'e sabe distinguir o país do que está à volta dele — Ovar e o Funchal sim, '
    + 'Badajoz e o mar não', JSON.stringify(emTerra));

  /* CONTAM-SE OS QUE SE VÊEM, e comparam-se com os que TÊM COORDENADA.
     Contar nós do DOM dava o mesmo número com o mapa inteiro fora do
     enquadramento — e foi assim que um alfinete de Faro escondido passou
     despercebido. Exige-se também que o centro de cada um caia dentro da caixa
     do mapa: um alfinete a 3000 px do ecrã não está `hidden`, mas também não
     existe para ninguém. */
  const contagem = await palco.js(`
    const caixa = document.querySelector('${MAPA}').getBoundingClientRect();
    const todos = [...document.querySelectorAll('#mapa-descobrir .mapa-pino')];
    const visiveis = todos.filter((b) => {
      if (b.hidden) return false;
      const r = b.getBoundingClientRect();
      const [x, y] = [r.x + r.width / 2, r.y + r.height / 2];
      return x >= caixa.x && x <= caixa.right && y >= caixa.y && y <= caixa.bottom;
    });
    return { todos: todos.length, visiveis: visiveis.length };`);
  const comPonto = await palco.js(`
    const { api } = await import('/js/api.js');
    const ns = await api.descobrir();
    return ns.filter((n) => typeof n.latitude === 'number').length;`);
  certo(contagem.visiveis === comPonto,
    `um alfinete VISÍVEL por estabelecimento com ponto — ${contagem.visiveis} no `
    + `mapa e ${comPonto} com coordenada`,
    JSON.stringify({ ...contagem, comPonto }));
  const pinos = contagem.todos;

  /* --- 3. NADA VEM DE FORA ---------------------------------------------- */
  /* A afirmação que sustenta a promessa da página de privacidade. Olha-se para
     TODOS os pedidos que o browser fez, e não só para os do mapa. */
  const forasteiros = await palco.js(`
    return performance.getEntriesByType('resource')
      .map((e) => e.name)
      .filter((u) => /^https?:/.test(u) && new URL(u).host !== location.host)`);
  certo(forasteiros.length === 0,
    'e nada no ecrã do mapa foi buscado a um servidor de fora — é a promessa '
    + 'escrita na página de privacidade, afirmada aqui',
    JSON.stringify(forasteiros).slice(0, 200));

  /* --- 4. O ALFINETE APROXIMADO DIZ QUE É APROXIMADO -------------------- */
  const aproximados = await palco.contar('#mapa-descobrir .mapa-pino-aproximado');
  certo(aproximados === 1,
    'o ponto que veio do centróide do concelho desenha-se diferente dos outros',
    String(aproximados));
  const dito = await palco.js(`
    const b = document.querySelector('#mapa-descobrir .mapa-pino-aproximado');
    return b ? b.getAttribute('aria-label') : null`);
  certo(String(dito).includes('aproximada'),
    'e diz-o em voz alta a quem usa leitor de ecrã — a forma do alfinete não '
    + 'chega a quem não o vê', String(dito));

  /* --- 5. ARRASTAR, AMPLIAR, E O TECLADO -------------------------------- */
  const inicio = await vista(palco);
  certo(Boolean(inicio) && inicio.largura > 0, 'o mapa tem uma vista',
    JSON.stringify(inicio));

  await palco.arrastar(MAPA, -60, -40);
  const arrastado = await vista(palco);
  certo(arrastado.x !== inicio.x || arrastado.y !== inicio.y,
    'arrastar move o mapa',
    `${JSON.stringify(inicio)} -> ${JSON.stringify(arrastado)}`);
  certo(Math.abs(arrastado.largura - inicio.largura) < 0.01,
    'e arrastar NÃO amplia — são dois gestos, e misturá-los é o que faz um '
    + 'mapa parecer que tem vida própria');

  await palco.roda(MAPA, -240, { ctrl: true });
  const ampliado = await vista(palco);
  certo(ampliado.largura < arrastado.largura,
    'a roda aproxima', `${arrastado.largura.toFixed(1)} -> ${ampliado.largura.toFixed(1)}`);

  /* O TECTO DE AMPLIAÇÃO. Os contornos foram simplificados para se verem à
     escala do país; deixar aproximar até ao infinito era prometer uma precisão
     que o desenho não tem. */
  for (let i = 0; i < 24; i++) await palco.roda(MAPA, -400, { ctrl: true });
  const noTecto = await vista(palco);
  /* O TECTO COMPARA-SE COM O QUE ESTÁ ESCRITO, e não com «maior do que um».
     O mapa promete seis quilómetros de ponta a ponta na folha aberta; a escala
     está no próprio ficheiro do mapa, e a conta é a mesma que o módulo faz. */
  const seisKm = await palco.js(`
    const { carregarPortugal } = await import('/js/mapa.js');
    const d = await carregarPortugal('');
    const f = d.folhas.find((x) => x.nome === 'Continente');
    return (f.proj.k / 111.32) * 6;`);
  certo(Math.abs(noTecto.largura - seisKm) < 0.2,
    'e o tecto é o que está escrito: seis quilómetros de ponta a ponta, nem '
    + 'mais nem menos',
    `vista ${noTecto.largura.toFixed(2)} vs seis km = ${seisKm.toFixed(2)}`);

  /* As setas do teclado, que é o que um mapa precisa para existir para quem
     não usa o dedo. O foco vai para o mapa, que é um `role="group"` tabulável. */
  await palco.js(`document.querySelector('${MAPA}').focus(); return true`);
  const focado = await palco.js(`
    return document.activeElement?.classList.contains('mapa')`);
  certo(focado === true, 'o mapa recebe foco — é tabulável', String(focado));

  const antesDaSeta = await vista(palco);
  await palco.tecla('ArrowRight');
  await dormir(palco, 200);
  const depoisDaSeta = await vista(palco);
  certo(depoisDaSeta.x > antesDaSeta.x,
    'e as setas arrastam-no', `${antesDaSeta.x.toFixed(1)} -> ${depoisDaSeta.x.toFixed(1)}`);

  await palco.tecla('0');
  await dormir(palco, 300);
  const reposta = await vista(palco);
  /* IGUAL AO PRINCÍPIO, e não «maior do que estava». Aceitar qualquer
     alargamento deixava passar um `0` que enquadrasse a folha inteira, ou
     metade dela, em vez de voltar aos estabelecimentos. */
  const igual = ['x', 'y', 'largura', 'altura']
    .every((k) => Math.abs(reposta[k] - inicio[k]) < 0.01);
  certo(igual, 'e o zero repõe EXACTAMENTE o enquadramento de abertura',
    `${JSON.stringify(inicio)} -> ${JSON.stringify(reposta)}`);

  /* --- 6. O ALFINETE ABRE O NEGÓCIO CERTO ------------------------------- */
  /* Marca-se o alfinete de um negócio CONHECIDO e confere-se que o cartão que
     fica apontado é o dele. É a afirmação que apanha o defeito do índice. */
  /* TODOS OS ALFINETES, um a um. Provar com UM é provar que um funciona — e o
     defeito que isto persegue (indexar pela posição em vez do identificador)
     acerta por acaso em metade deles. Aqui percorre-se a lista inteira e
     exige-se que cada alfinete aponte o cartão do seu próprio nome.

     Sem rato, de propósito: dois alfinetes da mesma vila sobrepõem-se, e um
     clique de rato no de baixo é impossível — mas ele existe, é tabulável, e
     tem de abrir o negócio certo. Quem o activa aqui é o teclado, que é o
     caminho de quem não usa o dedo. */
  const nomes = await palco.js(`
    return [...document.querySelectorAll('#mapa-descobrir .mapa-pino')]
      .map((b) => b.getAttribute('title'))`);
  certo(nomes.length >= 3, `há alfinetes que cheguem para provar isto (${nomes.length})`);

  const enganos = [];
  for (const nome of nomes) {
    await palco.js(`
      const b = [...document.querySelectorAll('#mapa-descobrir .mapa-pino')]
        .find((n) => n.getAttribute('title') === ${JSON.stringify(nome)});
      document.querySelectorAll('.cartao-apontado')
        .forEach((c) => c.classList.remove('cartao-apontado'));
      b.focus(); b.click();
      return true`);
    await dormir(palco, 400);
    const apontado = await palco.js(`
      const c = document.querySelector('.cartao-apontado');
      return c ? c.querySelector('.cartao-nome')?.textContent : null`);
    if (apontado !== nome) enganos.push(`${nome} -> ${apontado}`);
  }
  certo(enganos.length === 0,
    `cada um dos ${nomes.length} alfinetes aponta o cartão DAQUELE negócio — `
    + 'por identificador, nunca por posição na lista',
    enganos.join(' | ') || 'nenhum enganou');

  /* --- 7. E CADA CARTÃO TEM UM «COMO CHEGAR» ---------------------------- */
  /* O nosso mapa não tem ruas, e é de propósito. A pergunta «como é que lá
     chego» responde-se com a app de mapas do próprio telemóvel — uma ligação
     que só é seguida se alguém lhe tocar. */
  const chegar = await palco.js(`
    const a = document.querySelector('#principal .pilha .cartao-chegar');
    return a ? { texto: a.textContent.trim(), href: a.getAttribute('href') } : null`);
  certo(Boolean(chegar) && /^(geo:|https:\/\/)/.test(chegar.href),
    'cada estabelecimento com ponto tem um «Como chegar»', JSON.stringify(chegar));

  /* OS TRÊS CAMINHOS, e não só o do agente que está a correr. Um `geo:` num
     computador é uma ligação que não abre absolutamente nada — pior do que não
     haver ligação —, e sem isto essa metade nunca seria percorrida. */
  const porAgente = await palco.js(`
    const { comoChegar } = await import('/js/mapa.js');
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
    const fingir = (ua) => Object.defineProperty(navigator, 'userAgent',
      { value: ua, configurable: true });
    const saida = {};
    for (const [nome, ua] of [
      ['iphone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'],
      ['android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8)'],
      ['computador', 'Mozilla/5.0 (X11; Linux x86_64)'],
    ]) {
      fingir(ua);
      saida[nome] = comoChegar({ lat: 40.5, lon: -8.5, nome: 'Café' });
    }
    delete navigator.userAgent;
    if (original) Object.defineProperty(Navigator.prototype, 'userAgent', original);
    return saida;`);
  certo(porAgente.iphone.startsWith('https://maps.apple.com/'),
    'num iPhone abre a app de mapas da Apple', porAgente.iphone);
  certo(porAgente.android.startsWith('geo:'),
    'num Android abre o esquema geo: da norma, que deixa a pessoa escolher a app',
    porAgente.android);
  certo(porAgente.computador.startsWith('https://www.openstreetmap.org/'),
    'e num computador abre um mapa que EXISTE — um geo: ali é uma ligação que '
    + 'não faz nada', porAgente.computador);

  /* --- 8. NUM ECRÃ PEQUENO ---------------------------------------------- */
  await palco.tamanho(320, 640);
  await dormir(palco, 600);
  const caixa = await palco.medir(MAPA);
  certo(Boolean(caixa) && caixa.largura <= 320 && caixa.altura > 120,
    'a 320 px o mapa continua a caber e a ter altura de mapa',
    JSON.stringify(caixa && { l: Math.round(caixa.largura), a: Math.round(caixa.altura) }));
  const estreito = await palco.js(`
    const caixa = document.querySelector('${MAPA}').getBoundingClientRect();
    return [...document.querySelectorAll('#mapa-descobrir .mapa-pino')]
      .filter((b) => {
        if (b.hidden) return false;
        const r = b.getBoundingClientRect();
        const [x, y] = [r.x + r.width / 2, r.y + r.height / 2];
        return x >= caixa.x && x <= caixa.right && y >= caixa.y && y <= caixa.bottom;
      }).length;`);
  certo(estreito === comPonto,
    'e a 320 px continuam todos DENTRO do mapa — nenhum é empurrado para fora '
    + 'do enquadramento por o ecrã ser estreito',
    `${estreito} de ${comPonto}`);
  await palco.tamanho(390, 844);

  /* --- 8b. DE NORTE A SUL, E NENHUM FICA DE FORA ------------------------ */
  /* A demonstração tem os seis negócios no mesmo canto do país, e por isso
     nunca exercita o caso que mais custa: alfinetes espalhados de Viana a
     Faro. O enquadramento tinha ali um defeito de aritmética — o tecto era
     medido sobre a folha crua e não sobre a folha já enquadrada na proporção
     do ecrã — e o resultado era o mapa a abrir com um estabelecimento fora do
     enquadramento, sem gesto nenhum que o trouxesse de volta.

     Monta-se um mapa à parte, com pontos escolhidos para isso, e exige-se que
     os alfinetes caiam TODOS dentro da caixa. */
  const espalhados = await palco.js(`
    const { carregarPortugal, criarMapa } = await import('/js/mapa.js');
    const dados = await carregarPortugal('');
    const sitios = [
      { id: 'a', nome: 'Viana', lat: 41.6918, lon: -8.8344 },
      { id: 'b', nome: 'Bragança', lat: 41.8072, lon: -6.7511 },
      { id: 'c', nome: 'Lisboa', lat: 38.7078, lon: -9.1366 },
      { id: 'd', nome: 'Faro', lat: 37.0146, lon: -7.9352 },
    ];
    const fora = document.createElement('div');
    fora.style.cssText = 'position:fixed;left:0;top:0;width:360px;height:480px';
    document.body.append(fora);
    const mapa = criarMapa({ dados, pontos: sitios, rotulo: 'prova' });
    fora.append(mapa.elemento);
    await new Promise((r) => setTimeout(r, 900));
    const caixa = fora.querySelector('.mapa').getBoundingClientRect();
    const saida = [...fora.querySelectorAll('.mapa-pino')].map((b) => {
      const r = b.getBoundingClientRect();
      const [x, y] = [r.x + r.width / 2, r.y + r.height / 2];
      return { nome: b.getAttribute('title'), escondido: b.hidden,
               dentro: x >= caixa.x && x <= caixa.right && y >= caixa.y && y <= caixa.bottom };
    });
    mapa.parar();
    fora.remove();
    return saida;`);
  const perdidos = espalhados.filter((p) => p.escondido || !p.dentro);
  certo(espalhados.length === 4 && perdidos.length === 0,
    'com estabelecimentos de Viana a Faro, o mapa abre com os quatro DENTRO do '
    + 'enquadramento — nenhum fica escondido à espera de um gesto que não existe',
    JSON.stringify(espalhados));

  /* --- 8c. PERTO DE MIM -------------------------------------------------- */
  /* A pergunta que um mapa de concelhos não responde: numa cidade, todos os
     alfinetes caem no mesmo polígono. Responde-se ordenando a lista — e o que
     aqui se persegue é que a posição NÃO SAIA DO TELEMÓVEL. */
  await palco.posicao(40.6405, -8.6538);            /* a ria de Aveiro */
  certo(await palco.ver('#perto-de-mim'),
    'com mais do que um estabelecimento no mapa, há um «perto de mim»');

  const antesDeOrdenar = await palco.js(`
    return [...document.querySelectorAll('#principal .pilha .cartao-nome')]
      .map((n) => n.textContent)`);
  await palco.espiarPedidos();
  await palco.clicar('#perto-de-mim');
  await palco.esperar('#principal .cartao-distancia', 8000);
  await dormir(palco, 500);

  const depoisDeOrdenar = await palco.js(`
    return [...document.querySelectorAll('#principal .pilha .cartao-nome')]
      .map((n) => n.textContent)`);
  certo(depoisDeOrdenar[0] === 'Barbearia Navalha',
    'estando na ria de Aveiro, o primeiro da lista é a barbearia de Aveiro',
    depoisDeOrdenar.join(' | '));
  certo(antesDeOrdenar.join('|') !== depoisDeOrdenar.join('|'),
    'e a ordem mudou mesmo — não é a mesma lista com números ao lado',
    `${antesDeOrdenar[0]} -> ${depoisDeOrdenar[0]}`);
  certo(depoisDeOrdenar.length === antesDeOrdenar.length,
    'e não se perdeu nem se duplicou nenhum estabelecimento pelo caminho',
    `${antesDeOrdenar.length} -> ${depoisDeOrdenar.length}`);

  const distancias = await palco.js(`
    return [...document.querySelectorAll('#principal .cartao-distancia')]
      .map((n) => n.textContent.trim())`);
  certo(distancias.length >= 2 && /^· a \d/.test(distancias[0]),
    'cada cartão diz a que distância fica — uma lista reordenada sem dizer '
    + 'porquê parece uma lista baralhada', JSON.stringify(distancias));

  /* A AFIRMAÇÃO QUE INTERESSA: a posição não saiu daqui. */
  const pedidos = await palco.pedidos();
  const comCoordenadas = pedidos.filter((u) =>
    /40\.6|8\.65|lat|lon|coord/i.test(u));
  certo(comCoordenadas.length === 0,
    'e a posição NÃO SAIU DO TELEMÓVEL: nenhum pedido a leva, nem no endereço '
    + 'nem no corpo', JSON.stringify(pedidos).slice(0, 200));
  const noArmazenamento = await palco.js(`
    return Object.entries(localStorage).filter(([, v]) => /40\.6\d|-8\.65\d/.test(v)).map(([k]) => k)`);
  certo(noArmazenamento.length === 0,
    'nem fica guardada no armazenamento do telemóvel',
    JSON.stringify(noArmazenamento));

  certo(await palco.js(`
    return !document.querySelector('#mapa-descobrir .mapa-eu')?.hidden`) === true,
    'e o mapa passa a mostrar onde a pessoa está');

  /* --- 9. DOIS CAFÉS DA MESMA VILA SEPARAM-SE ---------------------------- */
  /* O mapa não tem ruas, e por isso o que ele tem de garantir é que dois
     sítios diferentes acabam por ser dois alfinetes diferentes. Ovar tem dois
     na demonstração, a uns trezentos metros um do outro: no enquadramento de
     abertura ficam colados, e no tecto de ampliação têm de estar separados. */
  await palco.tecla('0');
  await dormir(palco, 400);
  const medirOvar = () => palco.js(`
    const p = [...document.querySelectorAll('#mapa-descobrir .mapa-pino')]
      .filter((b) => /Torrado|Camélia/.test(b.getAttribute('title') || ''))
      .map((b) => { const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    if (p.length !== 2) return null;
    return Math.round(Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]));`);
  const juntos = await medirOvar();
  certo(juntos !== null, 'os dois estabelecimentos de Ovar estão os dois no mapa',
    String(juntos));

  await palco.js(`document.querySelector('${MAPA}').focus(); return true`);
  for (let i = 0; i < 14; i++) await palco.tecla('+');
  await dormir(palco, 400);
  const separados = await medirOvar();
  certo(separados !== null && separados > 16,
    'e no tecto de ampliação ficam separados — é o que responde a «são dois '
    + 'sítios ou é o mesmo?»',
    `${juntos} px no princípio, ${separados} px no tecto`);

  /* E MESMO SOBREPOSTOS, O DEDO ESCOLHE. Volta-se ao enquadramento de
     abertura, onde os dois de Ovar ficam em cima um do outro, e toca-se ao
     lado de cada um: o que abre tem de ser o mais perto do dedo, e não o que
     calhou ficar por cima. Sem isto, o de baixo é inalcançável a dedo. */
  await palco.tecla('0');
  await dormir(palco, 500);
  const escolhas = await palco.js(`
    const alvos = [...document.querySelectorAll('#mapa-descobrir .mapa-pino')]
      .filter((b) => /Torrado|Camélia/.test(b.getAttribute('title') || ''));
    const saida = [];
    for (const alvo of alvos) {
      const r = alvo.getBoundingClientRect();
      document.querySelectorAll('.cartao-apontado')
        .forEach((c) => c.classList.remove('cartao-apontado'));
      /* Um clique com coordenadas mesmo em cima do centro daquele alfinete. */
      alvo.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1,
        clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
      await new Promise((r2) => setTimeout(r2, 350));
      const c = document.querySelector('.cartao-apontado');
      saida.push({ pedi: alvo.getAttribute('title'),
                   abriu: c ? c.querySelector('.cartao-nome')?.textContent : null });
    }
    return saida;`);
  certo(escolhas.length === 2 && escolhas.every((e) => e.pedi === e.abriu),
    'e com os dois sobrepostos, tocar em cima de um abre ESSE — o de baixo '
    + 'deixa de ser inalcançável a dedo', JSON.stringify(escolhas));

  /* --- 10. E O MAPA DO BALCÃO, QUE É ONDE O PONTO SE MARCA -------------- */
  /* É o ecrã onde os dois piores defeitos deste trabalho viviam: o painel
     abria no centro do país e o botão de gravar movia o estabelecimento
     sessenta quilómetros. Nenhum deles aparecia em teste nenhum, porque o
     balcão nunca era conduzido aqui. */
  await palco.ir('/balcao/?demo=1');
  await palco.esperar('#entrada-acoes .btn-cheio', 10000);
  await palco.clicar('#entrada-acoes .btn-cheio');
  await palco.esperar('#barra .barra-item', 10000);
  await palco.clicar('#barra .barra-item:nth-child(4)');
  await palco.esperar('#linha-onde-fica .linha b', 8000);

  const comPontoDito = await palco.texto('#linha-onde-fica');
  certo(comPontoDito.includes('Está no mapa'),
    'o café da demonstração já tem ponto, e o balcão di-lo com as coordenadas',
    comPontoDito.slice(0, 80));
  const antes = await palco.js(`
    const e = JSON.parse(localStorage.getItem('carimbo-demo:demo') || '{}');
    const n = (e.negocios || []).find((x) => x.id === 'n-torrado');
    return { lat: n.latitude, lon: n.longitude };`);

  /* --- 10a. ABRIR NO PONTO QUE JÁ LÁ ESTÁ ------------------------------ */
  /* Era aqui que estava o pior defeito de todo este trabalho: o painel
     descartava o ponto do negócio e reenquadrava no país inteiro. Carregar em
     «Guardar este ponto» sem tocar em nada movia o estabelecimento sessenta
     quilómetros, e não havia nada no ecrã que o dissesse. */
  await palco.clicar('#linha-onde-fica .linha');
  await palco.esperar('.ponto-alvo', 8000);
  await dormir(palco, 1400);
  const aoAbrir = await palco.texto('#painel .miudo');
  certo(aoAbrir.startsWith(`${antes.lat.toFixed(5)}, ${antes.lon.toFixed(5)}`),
    'o painel abre EXACTAMENTE no ponto que o negócio já tem — não no centro '
    + 'do país', `${aoAbrir} vs ${antes.lat}, ${antes.lon}`);
  certo(await palco.ver('#painel .mapa-folha-botao'),
    'e oferece as três folhas — sem isto, um café do Funchal não tem como '
    + 'chegar à Madeira: o tecto de ampliação não deixa arrastar até lá');

  await palco.clicar('#guardar-ponto');
  await palco.sumir('#painel', 6000);
  await dormir(palco, 400);
  const depoisDeGravarSemMexer = await palco.js(`
    const e = JSON.parse(localStorage.getItem('carimbo-demo:demo') || '{}');
    const n = (e.negocios || []).find((x) => x.id === 'n-torrado');
    return { lat: n.latitude, lon: n.longitude };`);
  certo(depoisDeGravarSemMexer.lat === antes.lat
    && depoisDeGravarSemMexer.lon === antes.lon,
    'e gravar sem mexer em nada deixa o estabelecimento onde estava',
    `${JSON.stringify(antes)} -> ${JSON.stringify(depoisDeGravarSemMexer)}`);

  /* --- 10b. TIRAR DO MAPA, QUE ESTÁ PROMETIDO NA PRIVACIDADE ----------- */
  await palco.esperar('#linha-onde-fica .linha b', 8000);
  await palco.clicar('#linha-onde-fica .linha');
  await palco.esperar('.ponto-alvo', 8000);
  await dormir(palco, 800);
  await palco.clicar('#painel .btn-perigo');
  await palco.sumir('#painel', 6000);
  await dormir(palco, 400);
  const semPonto = await palco.js(`
    const e = JSON.parse(localStorage.getItem('carimbo-demo:demo') || '{}');
    const n = (e.negocios || []).find((x) => x.id === 'n-torrado');
    return n.latitude ?? null;`);
  certo(semPonto === null,
    'tirar do mapa apaga mesmo a coordenada — está prometido na política de '
    + 'privacidade', String(semPonto));
  certo((await palco.texto('#linha-onde-fica')).includes('Ainda não está no mapa'),
    'e o balcão passa a dizer que não está no mapa');

  /* --- 10c. E SEM PONTO, NÃO SE GRAVA O QUE NINGUÉM ESCOLHEU ----------- */
  await palco.clicar('#linha-onde-fica .linha');
  await palco.esperar('.ponto-alvo', 8000);
  await dormir(palco, 1000);
  certo(await palco.js(`
    return document.querySelector('#guardar-ponto')?.getAttribute('aria-disabled')`) === 'true',
    'sem ponto, o botão de gravar começa adormecido — o mapa abre no país '
    + 'inteiro, e gravar isso punha o café no meio de Portugal');
  await palco.clicar('#guardar-ponto');
  await dormir(palco, 500);
  certo(await palco.ver('.ponto-alvo'),
    'carregar nele sem ter mexido não grava nada, e o painel fica aberto');
  certo(await palco.js(`
    const e = JSON.parse(localStorage.getItem('carimbo-demo:demo') || '{}');
    const n = (e.negocios || []).find((x) => x.id === 'n-torrado');
    return n.latitude ?? null;`) === null,
    'e o negócio continua sem coordenada nenhuma');

  await palco.arrastar('#painel .mapa', -40, -30);
  await dormir(palco, 400);
  certo(await palco.js(`
    return document.querySelector('#guardar-ponto')?.getAttribute('aria-disabled')`) === null,
    'mexer no mapa acorda o botão de gravar');

  const leitura = await palco.texto('#painel .miudo');
  await palco.clicar('#guardar-ponto');
  await palco.sumir('#painel', 6000);
  await dormir(palco, 500);
  const gravado = await palco.js(`
    const e = JSON.parse(localStorage.getItem('carimbo-demo:demo') || '{}');
    const n = (e.negocios || []).find((x) => x.id === 'n-torrado');
    return { lat: n.latitude, lon: n.longitude, fonte: n.geoFonte };`);
  certo(typeof gravado.lat === 'number', 'e o ponto volta a ficar gravado',
    JSON.stringify(gravado));
  certo(leitura.startsWith(`${gravado.lat.toFixed(5)}, ${gravado.lon.toFixed(5)}`),
    'e é EXACTAMENTE o que o painel mostrava por baixo do mapa',
    `${leitura} vs ${gravado.lat}, ${gravado.lon}`);
  certo(gravado.fonte === 'mao',
    'e a fonte diz que foi marcado à mão, porque foi — o «gps» fica para quem '
    + 'carrega no botão do telemóvel', String(gravado.fonte));
}
