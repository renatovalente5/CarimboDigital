/* =========================================================================
   Carimbo Digital — núcleo de JavaScript
   Ferramentas partilhadas pelas duas aplicações. Sem dependências.
   ========================================================================= */

export const $  = (sel, raiz = document) => raiz.querySelector(sel);
export const $$ = (sel, raiz = document) => Array.from(raiz.querySelectorAll(sel));

/** Cria um elemento. Os atributos que começam por `ao` são eventos. */
export function el(etiqueta, atributos = {}, ...filhos) {
  const n = document.createElement(etiqueta);
  for (const [chave, valor] of Object.entries(atributos)) {
    if (valor === null || valor === undefined || valor === false) continue;
    if (chave === 'html') n.innerHTML = valor;
    else if (chave === 'texto') n.textContent = valor;
    else if (chave === 'estilo') {
      /* Não se usa Object.assign: atribuir `style['--x']` não faz nada — as
         propriedades personalizadas só entram por setProperty, e o silêncio
         com que falham custa meia hora a perceber. */
      for (const [prop, v] of Object.entries(valor)) {
        if (prop.startsWith('--')) n.style.setProperty(prop, v);
        else n.style[prop] = v;
      }
    }
    else if (chave.startsWith('ao')) n.addEventListener(chave.slice(2).toLowerCase(), valor);
    else n.setAttribute(chave, valor === true ? '' : valor);
  }
  for (const f of filhos.flat()) {
    if (f === null || f === undefined || f === false) continue;
    n.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return n;
}

/* =========================================================================
   Cor
   Toda a app é um invólucro para as cores dos comerciantes. Nenhum deles vai
   pensar em contraste — por isso o texto por cima da cor nunca é escolhido à
   mão: calcula-se. É isto que impede um cartão amarelo com letras brancas.
   ========================================================================= */

export function paraRGB(cor) {
  let h = String(cor || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return { r: 23, g: 22, b: 28 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function paraHex({ r, g, b }) {
  const p = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${p(r)}${p(g)}${p(b)}`;
}

/** Luminância relativa, como a define a WCAG 2. */
export function luminancia(cor) {
  const { r, g, b } = paraRGB(cor);
  const canal = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}

/** Razão de contraste entre duas cores (1 a 21). */
export function contraste(a, b) {
  const la = luminancia(a), lb = luminancia(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const BRANCO = '#FFFFFF';
const PRETO = '#141318';

/** A tinta que se lê melhor por cima de `fundo`. */
export function tintaPara(fundo) {
  return contraste(fundo, BRANCO) >= contraste(fundo, PRETO) ? BRANCO : PRETO;
}

/**
 * Empurra uma cor até dar contraste suficiente com a tinta que lhe assenta.
 * Um comerciante que escolha um amarelo-claro fica com um amarelo-torrado —
 * é a cor dele na mesma, mas legível. Devolve também a tinta a usar.
 */
export function marcaSegura(cor, minimo = 4.5) {
  let atual = paraHex(paraRGB(cor));
  let tinta = tintaPara(atual);
  if (contraste(atual, tinta) >= minimo) return { cor: atual, tinta };

  const escurecer = tinta === BRANCO;
  for (let passo = 0; passo < 40; passo++) {
    const { r, g, b } = paraRGB(atual);
    const f = escurecer ? 0.94 : 1.06;
    atual = paraHex(escurecer
      ? { r: r * f, g: g * f, b: b * f }
      : { r: r * f + 4, g: g * f + 4, b: b * f + 4 });
    if (contraste(atual, tinta) >= minimo) break;
  }
  return { cor: atual, tinta };
}

/** Aplica a cor de um comerciante a um elemento de cartão. */
export function pintarCartao(no, cor) {
  const { cor: segura, tinta } = marcaSegura(cor);
  no.style.setProperty('--m', segura);
  no.style.setProperty('--m-txt', tinta);
  no.dataset.claro = tinta === PRETO ? 'sim' : 'nao';
}

/* =========================================================================
   Ícones
   Traço de 1,75 para os da interface, cheios para os carimbos — um glifo
   cheio lê-se muito melhor dentro de um círculo de 30 px.
   ========================================================================= */

const TRACO = {
  carteira: '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H18a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8.5Z"/><path d="M3 9V7a2 2 0 0 1 2-2h11"/><circle cx="17" cy="13" r="1.4" fill="currentColor" stroke="none"/>',
  bussola: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z"/>',
  relogio: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 1.9"/>',
  pessoa: '<circle cx="12" cy="8.5" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20h1"/>',
  camara: '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.7a2 2 0 0 0 1.7-1l.5-.8A1.5 1.5 0 0 1 10.6 3h2.8a1.5 1.5 0 0 1 1.2.7l.5.8a2 2 0 0 0 1.7 1h1.7A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-9Z"/><circle cx="12" cy="13" r="3.5"/>',
  cartoes: '<rect x="2.5" y="7" width="19" height="13" rx="3"/><path d="M2.5 11h19M6 4.5h12"/>',
  pessoas: '<circle cx="9" cy="8.5" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.4A6.5 6.5 0 0 1 21.5 20"/>',
  engrenagem: '<circle cx="12" cy="12" r="3"/><path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
  seta: '<path d="m9 5 7 7-7 7"/>',
  volta: '<path d="m15 5-7 7 7 7"/>',
  fechar: '<path d="M6 6l12 12M18 6 6 18"/>',
  visto: '<path d="m4.5 12.5 5 5 10-11"/>',
  mais: '<path d="M12 5v14M5 12h14"/>',
  menos: '<path d="M5 12h14"/>',
  presente: '<path d="M4 11h16v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8Z"/><rect x="2.5" y="7" width="19" height="4" rx="1.2"/><path d="M12 7v14"/><path d="M12 7S10.5 3 8.5 3a2 2 0 0 0 0 4H12Zm0 0s1.5-4 3.5-4a2 2 0 0 1 0 4H12Z"/>',
  sino: '<path d="M18 8.5a6 6 0 0 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5Z"/><path d="M10.3 19a2 2 0 0 0 3.4 0"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r=".9" fill="currentColor" stroke="none"/>',
  alerta: '<path d="M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4.5"/><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/>',
  caixote: '<path d="M4 7h16M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M6 7l.8 12.1A2 2 0 0 0 8.8 21h6.4a2 2 0 0 0 2-1.9L18 7"/><path d="M10 11.5v5M14 11.5v5"/>',
  lapis: '<path d="M4 20.5h4l11-11a2.8 2.8 0 0 0-4-4l-11 11v4Z"/><path d="m14.5 6.5 3 3"/>',
  partilhar: '<path d="M12 15V3.5M8.5 7 12 3.5 15.5 7"/><path d="M5 13v5.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V13"/>',
  sair: '<path d="M15 4.5h2.5A2.5 2.5 0 0 1 20 7v10a2.5 2.5 0 0 1-2.5 2.5H15"/><path d="M11 16.5 15.5 12 11 7.5M15.5 12H4"/>',
  mapa: '<path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/>',
  telefone: '<path d="M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5Z"/>',
  ligacao: '<path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.4 1.4"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.4-1.4"/>',
  calendario: '<rect x="3.5" y="5.5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3.5v4M16 3.5v4"/>',
  raio: '<path d="M13.5 2.5 4 14h6.5l-.5 7.5L19.5 10H13l.5-7.5Z"/>',
  grafico: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  brilho: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/>',
  lua: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
  descarregar: '<path d="M12 3.5v12M8 11.5l4 4 4-4"/><path d="M4.5 17.5v1A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.5-2.5v-1"/>',
  olho: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  cadeado: '<rect x="4.5" y="10" width="15" height="11" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>',
  procurar: '<circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/>',
  lampada: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3Z"/>',
};

const CHEIO = {
  cafe: '<path d="M4 6h12v6.5A5.5 5.5 0 0 1 10.5 18h-1A5.5 5.5 0 0 1 4 12.5V6Z"/><path d="M16 7.5h1.8a2.7 2.7 0 0 1 0 5.4H16V7.5Zm0 1.6v2.2h1.8a1.1 1.1 0 0 0 0-2.2H16Z"/><rect x="3" y="19.6" width="14" height="1.8" rx=".9"/><path d="M7 2.2c.9.8.9 1.6 0 2.4M10 2.2c.9.8.9 1.6 0 2.4M13 2.2c.9.8.9 1.6 0 2.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  chavena: '<path d="M5 8h11v5.5A5.5 5.5 0 0 1 10.5 19h0A5.5 5.5 0 0 1 5 13.5V8Z"/><path d="M16 9.4h1.5a2.4 2.4 0 0 1 0 4.8H16v-1.6h1.5a.8.8 0 0 0 0-1.6H16V9.4Z"/><rect x="4" y="20" width="13" height="1.7" rx=".85"/>',
  tesoura: '<circle cx="6.2" cy="18" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="17.8" cy="18" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7.6 15.6 17.4 3.4M16.4 15.6 6.6 3.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  navalha: '<path d="M3.2 5.6 5 3.8a1 1 0 0 1 1.5 0l13.8 13.8a2.6 2.6 0 0 1-3.7 3.7L3.2 7.5a1.3 1.3 0 0 1 0-1.9Z"/><path d="M6.5 9.2 9 6.7" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="1.4"/>',
  bolo: '<path d="M4 13.5c0-1.4 1.1-2.5 2.5-2.5h11c1.4 0 2.5 1.1 2.5 2.5V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5.5Z"/><path d="M8 11V7.5M12 11V7M16 11V7.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="5.6" r="1.3"/><circle cx="12" cy="5.1" r="1.3"/><circle cx="16" cy="5.6" r="1.3"/>',
  pizza: '<path d="M12 2.5 21.5 20a1.6 1.6 0 0 1-1.8 2.3 30 30 0 0 0-15.4 0A1.6 1.6 0 0 1 2.5 20L12 2.5Z"/><circle cx="12" cy="12" r="1.4" fill="#fff" fill-opacity=".6"/><circle cx="9.2" cy="16.6" r="1.2" fill="#fff" fill-opacity=".6"/><circle cx="14.6" cy="16.9" r="1.2" fill="#fff" fill-opacity=".6"/>',
  cerveja: '<path d="M5 5.5h9.5v14A1.5 1.5 0 0 1 13 21H6.5A1.5 1.5 0 0 1 5 19.5v-14Z"/><path d="M15.5 8h2A2.5 2.5 0 0 1 20 10.5v3a2.5 2.5 0 0 1-2.5 2.5h-2V8Zm1.6 1.7v4.6h.4a.9.9 0 0 0 .9-.9v-2.8a.9.9 0 0 0-.9-.9h-.4Z"/><path d="M5 4.2a2.2 2.2 0 0 1 2.5-1.7 2.3 2.3 0 0 1 4.4 0A2.2 2.2 0 0 1 14.5 4.2v1.6H5V4.2Z"/>',
  gelado: '<path d="M7 9.5a5 5 0 1 1 10 0v.7H7v-.7Z"/><path d="M7.4 11.8h9.2L12.9 21a1 1 0 0 1-1.8 0L7.4 11.8Z"/>',
  garrafa: '<path d="M10 2.5h4v3.2l1.8 2.7a4 4 0 0 1 .7 2.2v8.9A1.5 1.5 0 0 1 15 21H9a1.5 1.5 0 0 1-1.5-1.5v-8.9a4 4 0 0 1 .7-2.2L10 5.7V2.5Z"/><rect x="8.8" y="12" width="6.4" height="3.4" fill="#fff" fill-opacity=".45"/>',
  prato: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.4" fill="#fff" fill-opacity=".4"/>',
  flor: '<circle cx="12" cy="12" r="2.6"/><path d="M12 2.5c2.2 0 3.4 2.1 2.6 4.2-.5 1.3-1.6 2-2.6 2s-2.1-.7-2.6-2C8.6 4.6 9.8 2.5 12 2.5ZM12 21.5c-2.2 0-3.4-2.1-2.6-4.2.5-1.3 1.6-2 2.6-2s2.1.7 2.6 2c.8 2.1-.4 4.2-2.6 4.2ZM2.5 12c0-2.2 2.1-3.4 4.2-2.6 1.3.5 2 1.6 2 2.6s-.7 2.1-2 2.6C4.6 15.4 2.5 14.2 2.5 12ZM21.5 12c0 2.2-2.1 3.4-4.2 2.6-1.3-.5-2-1.6-2-2.6s.7-2.1 2-2.6c2.1-.8 4.2.4 4.2 2.6Z"/>',
  coracao: '<path d="M12 20.7 4.4 13a5 5 0 0 1 7.1-7l.5.5.5-.5a5 5 0 1 1 7.1 7L12 20.7Z"/>',
  estrela: '<path d="m12 2.8 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.6l-5.8 3.1 1.1-6.5L2.6 9.6l6.5-.9L12 2.8Z"/>',
  pata: '<ellipse cx="6.6" cy="10" rx="2.1" ry="2.7"/><ellipse cx="10.6" cy="7.2" rx="2.1" ry="2.8"/><ellipse cx="15.1" cy="7.4" rx="2.1" ry="2.8"/><ellipse cx="18.6" cy="10.6" rx="2" ry="2.5"/><path d="M12.4 12.2c2.6 0 5.4 2.2 5.4 4.8 0 2.1-1.8 3.5-4 3.5-.9 0-1.4-.3-2.4-.3s-1.5.3-2.4.3c-2.2 0-3.9-1.4-3.9-3.5 0-2.6 2.7-4.8 5.4-4.8Z"/>',
  carro: '<path d="M3.5 12.4 5.3 7a2.5 2.5 0 0 1 2.4-1.7h8.6A2.5 2.5 0 0 1 18.7 7l1.8 5.4v5.1a1.5 1.5 0 0 1-1.5 1.5h-1a1.5 1.5 0 0 1-1.5-1.5v-.8H7.5v.8A1.5 1.5 0 0 1 6 19H5a1.5 1.5 0 0 1-1.5-1.5v-5.1Z"/><path d="M6.4 11.4 7.6 7.7h8.8l1.2 3.7H6.4Z" fill="#fff" fill-opacity=".45"/><circle cx="7.4" cy="14.4" r="1.2" fill="#fff" fill-opacity=".6"/><circle cx="16.6" cy="14.4" r="1.2" fill="#fff" fill-opacity=".6"/>',
  halteres: '<rect x="2" y="9.6" width="3" height="4.8" rx="1.2"/><rect x="19" y="9.6" width="3" height="4.8" rx="1.2"/><rect x="5.4" y="7.8" width="3.4" height="8.4" rx="1.4"/><rect x="15.2" y="7.8" width="3.4" height="8.4" rx="1.4"/><rect x="8.4" y="10.8" width="7.2" height="2.4"/>',
  livro: '<path d="M4 4.5A2 2 0 0 1 6 2.5h13a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a2 2 0 0 0-2 2v-16Z"/><path d="M6 18.5h14v3H6a2 2 0 0 1 0-3Z" fill-opacity=".55"/>',
  verniz: '<rect x="8.4" y="8" width="7.2" height="13" rx="2"/><rect x="9.8" y="4.4" width="4.4" height="3.6" rx="1"/><path d="M14.6 2.2 21 6.4a1.2 1.2 0 0 1-1.3 2L14 5.1l.6-2.9Z"/>',
  mao: '<path d="M8.4 11V4.6a1.6 1.6 0 1 1 3.2 0V10h.6V3.2a1.6 1.6 0 1 1 3.2 0V10h.6V5.4a1.6 1.6 0 1 1 3.2 0v9.1c0 3.6-2.6 6.5-6.2 6.5-2 0-3.5-.8-4.6-2.2L4.6 14a1.7 1.7 0 0 1 2.5-2.2L8.4 13v-2Z"/>',
  sol: '<circle cx="12" cy="12" r="4.6"/><path d="M12 1.8v2.6M12 19.6v2.6M1.8 12h2.6M19.6 12h2.6M4.8 4.8l1.9 1.9M17.3 17.3l1.9 1.9M19.2 4.8l-1.9 1.9M6.7 17.3l-1.9 1.9" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  folha: '<path d="M20.5 3.5c0 9.5-4.4 14.5-11 14.5-1.4 0-2.6-.3-3.6-.8C4.7 20 4.2 21 4 21.5a1 1 0 0 1-1.9-.7C3.4 17 6.6 10.4 13.5 8c-4.6.6-7.6 3.3-9 6.4C3 9.5 7.3 3.5 20.5 3.5Z"/>',
  chave: '<circle cx="7.5" cy="8.5" r="4.5"/><circle cx="7.5" cy="8.5" r="1.6" fill="#fff"/><path d="m10.6 11.6 8 8M16.4 15.4l2 2-1.6 1.6-2-2M18.6 19.6l-1.4 1.4"  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  sacola: '<path d="M4.5 8h15l-1 11.3a2 2 0 0 1-2 1.7H7.5a2 2 0 0 1-2-1.7L4.5 8Z"/><path d="M8.5 9.5V7a3.5 3.5 0 1 1 7 0v2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  carimbo: '<path d="M9 3.4A2.4 2.4 0 0 1 11.4 1h1.2A2.4 2.4 0 0 1 15 3.4c0 .5-.1 1-.3 1.4l-1.4 3.1h3.4A3.3 3.3 0 0 1 20 11.2v2.3a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 13.5v-2.3a3.3 3.3 0 0 1 3.3-3.3h3.4L9.3 4.8A3.4 3.4 0 0 1 9 3.4Z"/><rect x="3" y="17" width="18" height="4" rx="1.6"/>',
};

/** Devolve o SVG de um ícone. `tipo` é 'traco' (interface) ou 'cheio' (carimbos). */
export function icone(nome, { tipo = 'traco', tamanho = 24, classe = '' } = {}) {
  const cheio = tipo === 'cheio';
  const corpo = cheio ? CHEIO[nome] : TRACO[nome];
  if (!corpo) return '';
  const comuns = `xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" `
    + `width="${tamanho}" height="${tamanho}" aria-hidden="true" focusable="false"`
    + (classe ? ` class="${classe}"` : '');
  return cheio
    ? `<svg ${comuns} fill="currentColor">${corpo}</svg>`
    : `<svg ${comuns} fill="none" stroke="currentColor" stroke-width="1.75" `
      + `stroke-linecap="round" stroke-linejoin="round">${corpo}</svg>`;
}

export const NOMES_SELOS = Object.keys(CHEIO);
export const NOMES_ICONES = Object.keys(TRACO);

/* =========================================================================
   Arrumação local
   Tudo dentro de try/catch: numa janela privada, ou com os dados do site
   bloqueados, o simples acesso ao localStorage rebenta. A app tem de abrir
   na mesma.
   ========================================================================= */

/* O espaço onde as chaves vivem. A camada de dados troca-o quando se entra
   em modo de demonstração, para os dados de brincar não pisarem a conta a
   sério: são duas gavetas diferentes, e sair da demonstração devolve a conta
   exactamente como estava. */
let ESPACO = 'carimbo:';

export function definirEspaco(nome) { ESPACO = nome; }

export function guardar(chave, valor) {
  try { localStorage.setItem(ESPACO + chave, JSON.stringify(valor)); return true; }
  catch { return false; }
}

export function ler(chave, omissao = null) {
  try {
    const v = localStorage.getItem(ESPACO + chave);
    return v === null ? omissao : JSON.parse(v);
  } catch { return omissao; }
}

export function apagar(chave) {
  try { localStorage.removeItem(ESPACO + chave); } catch { /* paciência */ }
}

/* =========================================================================
   Avisos
   ========================================================================= */

let avisoAtual = null;

export function avisar(mensagem, tipo = 'neutro') {
  if (avisoAtual) avisoAtual.remove();
  const nome = tipo === 'bom' ? 'visto' : tipo === 'mau' ? 'alerta' : 'info';
  const no = el('div', {
    class: `aviso aviso-${tipo}`, role: 'status', 'aria-live': 'polite',
    html: icone(nome, { tamanho: 18 }) + `<span></span>`,
  });
  no.querySelector('span').textContent = mensagem;
  document.body.append(no);
  avisoAtual = no;
  setTimeout(() => {
    no.dataset.saida = 'sim';
    setTimeout(() => { no.remove(); if (avisoAtual === no) avisoAtual = null; }, 220);
  }, tipo === 'mau' ? 4200 : 2600);
  return no;
}

/* =========================================================================
   Datas
   ========================================================================= */

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun',
               'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export function dataCurta(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MESES[d.getMonth()]} ${d.getFullYear()}`;
}

export function horas(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** «há 5 min», «ontem», «há 3 dias». */
export function haQuanto(iso) {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return '';
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return 'agora mesmo';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) { const h = Math.floor(s / 3600); return `há ${h} hora${h > 1 ? 's' : ''}`; }
  const dias = Math.floor(s / 86400);
  if (dias === 1) return 'ontem';
  if (dias < 30) return `há ${dias} dias`;
  const meses = Math.floor(dias / 30);
  if (meses < 12) return `há ${meses} ${meses > 1 ? 'meses' : 'mês'}`;
  const anos = Math.floor(dias / 365);
  return `há ${anos} ano${anos > 1 ? 's' : ''}`;
}

/* =========================================================================
   Miudezas
   ========================================================================= */

/** Vibração curta. O iOS ignora — não faz mal, é um extra. */
export function vibrar(padrao = 12) {
  try { navigator.vibrate?.(padrao); } catch { /* nada */ }
}

/** Confetes, uma vez. Quem pediu menos movimento não os vê. */
export function confetes(cores = ['#5A31E8', '#F5B700', '#12A87B', '#FF5C7A', '#33B0FF']) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const caixa = el('div', { class: 'confetes', 'aria-hidden': 'true' });
  for (let i = 0; i < 46; i++) {
    caixa.append(el('div', {
      class: 'confete',
      estilo: {
        left: `${Math.random() * 100}%`,
        background: cores[i % cores.length],
        '--dur': `${1.9 + Math.random() * 1.4}s`,
        '--atraso': `${Math.random() * 0.45}s`,
        opacity: String(0.75 + Math.random() * 0.25),
      },
    }));
  }
  document.body.append(caixa);
  setTimeout(() => caixa.remove(), 3800);
}

/** Impede o ecrã de adormecer enquanto se mostra o código. */
export async function manterEcraAceso() {
  try {
    if (!('wakeLock' in navigator)) return null;
    return await navigator.wakeLock.request('screen');
  } catch { return null; }
}

/** Sorteia um identificador legível, sem letras que se confundam. */
const ALFABETO = '234679ACDEFGHJKLMNPQRTUVWXYZ';
export function identificador(n = 6) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALFABETO[b % ALFABETO.length]).join('');
}

/** Escapa texto que vá parar a innerHTML. */
export function seguro(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* =========================================================================
   Cofre
   Uma gaveta de IndexedDB para guardar o que não pode ser lido de volta.

   O segredo do dispositivo entra aqui como CryptoKey não-extraível: o
   browser assina com ele e nunca o devolve em claro. Isso resolve duas
   coisas de uma vez — um XSS não consegue roubá-lo, e o próprio dono do
   telemóvel não consegue copiá-lo para o telemóvel de um amigo pela consola.
   Guardá-lo em base64 no localStorage não dava nenhuma das duas.
   ========================================================================= */

const COFRE = 'carimbo';
let GAVETA_ESPACO = 'segredo';
const GAVETA = 'chaves';

function abrirCofre() {
  return new Promise((resolve, reject) => {
    const p = indexedDB.open(COFRE, 1);
    p.onupgradeneeded = () => {
      if (!p.result.objectStoreNames.contains(GAVETA)) p.result.createObjectStore(GAVETA);
    };
    p.onsuccess = () => resolve(p.result);
    p.onerror = () => reject(p.error);
  });
}

async function noCofre(modo, tarefa) {
  const bd = await abrirCofre();
  try {
    return await new Promise((resolve, reject) => {
      const t = bd.transaction(GAVETA, modo);
      const pedido = tarefa(t.objectStore(GAVETA));
      pedido.onsuccess = () => resolve(pedido.result);
      pedido.onerror = () => reject(pedido.error);
    });
  } finally { bd.close(); }
}

export async function guardarChave(nome, chave) {
  try { await noCofre('readwrite', (g) => g.put(chave, nome)); return true; }
  catch { return false; }
}

export async function lerChave(nome) {
  try { return await noCofre('readonly', (g) => g.get(nome)); }
  catch { return undefined; }
}

export async function apagarChave(nome) {
  try { await noCofre('readwrite', (g) => g.delete(nome)); } catch { /* paciência */ }
}
