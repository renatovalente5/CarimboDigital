/* =========================================================================
   Prova do gerador de códigos QR.

   Três provas, da mais forte para a mais fraca:

   1. Descodificação independente (scripts/descodificar-qr.py). Lê cada
      matriz como um leitor a sério e exige que as síndromes de Reed-Solomon
      dêem todas zero e que o texto volte igual. É a prova que conta, e não
      precisa de instalar nada.
   2. Comparação da estrutura com o `segno`, máscara a máscara — se estiver
      instalado. Apanha localizadores, cadências, alinhamento, formato e
      versão fora do sítio.
   3. Leitura por imagem com o OpenCV — se estiver instalado. É só um sinal:
      o detetor do OpenCV é fraco e falha em códigos válidos, por isso não
      trava o CI.

   O passo 1 corre sempre. Os outros dois só se as bibliotecas existirem.
   ========================================================================= */
import { gerarQR } from '../_fonte/js/qr.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AQUI = dirname(fileURLToPath(import.meta.url));

const TEXTOS = [
  'A',
  'AB',
  'HELLO WORLD',
  'https://sinete.pt/c/EA4BFM',
  'CB1.EA4BFM.000123.9f2a41c7',
  'CB1.7QK4ZM.004096.3b8e0d1a5f6c2b7e',
  'Bom dia! Isto é um teste com acentuação: ção, ã, ê, ü, ñ.',
  'x'.repeat(120),
  'y'.repeat(500),
  JSON.stringify({ v: 1, c: 'EA4BFM', n: 918273, s: 'aabbccddeeff0011' }),
];
const NIVEIS = ['L', 'M', 'Q', 'H'];

function temPython(modulo) {
  try {
    execFileSync('python3', ['-c', `import ${modulo}`], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/* --- 1. descodificação independente (obrigatória) ------------------------ */

const todos = [];
for (const t of TEXTOS) for (const n of NIVEIS) for (let m = 0; m < 8; m++) {
  const q = gerarQR(t, n, m);
  todos.push({ texto: t, nivel: n, versao: q.versao,
               linhas: q.modulos.map((l) => Array.from(l).join('')) });
}

const saida = execFileSync('python3', [join(AQUI, 'descodificar-qr.py')], {
  input: JSON.stringify(todos), maxBuffer: 256 * 1024 * 1024,
}).toString();
const linhasSaida = saida.trim().split('\n');
const resumo = JSON.parse(linhasSaida[linhasSaida.length - 1]);
for (const l of linhasSaida.slice(0, -1)) console.error(l);

if (resumo.falhas) {
  console.error(`\n✗ ${resumo.falhas} de ${resumo.total} matrizes não descodificam.`);
  process.exit(1);
}
console.log(`✓ ${resumo.total} matrizes descodificadas por um leitor independente `
  + `(síndromes a zero e texto igual).`);

/* --- 2. estrutura igual à do segno (se existir) -------------------------- */

if (temPython('segno')) {
  const pedidos = [];
  for (const t of TEXTOS) for (const n of NIVEIS) for (let m = 0; m < 8; m++) pedidos.push([t, n, m]);
  const py = `
import sys, json, segno
casos = json.loads(sys.stdin.read())
print(json.dumps([{'versao': q.version,
                   'linhas': [''.join('1' if m else '0' for m in l) for l in q.matrix]}
                  for q in (segno.make(t, error=n, mask=m, mode='byte', encoding='utf-8',
                                       boost_error=False, micro=False) for t, n, m in casos)]))
`;
  const ref = JSON.parse(execFileSync('python3', ['-c', py], {
    input: JSON.stringify(pedidos), maxBuffer: 256 * 1024 * 1024,
  }).toString());

  /* Só se compara a estrutura. Os módulos de dados diferem de propósito: o
     segno enche o terminador até ao byte seguinte mesmo quando já está
     alinhado, e nós paramos nos quatro zeros que a norma manda. Nenhum
     leitor nota — mas os bytes de enchimento saem desfasados. */
  let mal = 0;
  pedidos.forEach(([t, n, m], i) => {
    const nosso = gerarQR(t, n, m);
    if (nosso.versao !== ref[i].versao) {
      console.error(`✗ versão: nós v${nosso.versao}, segno v${ref[i].versao}`); mal++; return;
    }
    const tam = nosso.tamanho, v = nosso.versao;
    const estrutura = (l, c) =>
      (l < 9 && c < 9) || (l < 9 && c >= tam - 8) || (l >= tam - 8 && c < 9)
      || l === 6 || c === 6
      || (v >= 7 && ((l < 6 && c >= tam - 11) || (c < 6 && l >= tam - 11)));
    for (let l = 0; l < tam; l++) {
      for (let c = 0; c < tam; c++) {
        if (!estrutura(l, c)) continue;
        if (nosso.modulos[l][c] !== (ref[i].linhas[l][c] === '1' ? 1 : 0)) {
          console.error(`✗ estrutura v${v} ${n} máscara ${m}: módulo (${l},${c})`);
          mal++; l = tam; break;
        }
      }
    }
  });
  if (mal) { console.error(`\n✗ ${mal} matrizes com a estrutura errada.`); process.exit(1); }
  console.log(`✓ ${pedidos.length} matrizes com a estrutura igual à do segno.`);
} else {
  console.log('· segno não instalado — comparação de estrutura saltada.');
}

/* --- 3. leitura por imagem (informativo) --------------------------------- */

if (temPython('cv2')) {
  const paraLer = TEXTOS.flatMap((t) => NIVEIS.map((n) => {
    const q = gerarQR(t, n);
    return { texto: t, nivel: n, versao: q.versao,
             linhas: q.modulos.map((l) => Array.from(l).join('')) };
  }));
  const py = `
import sys, json, numpy as np, cv2
casos = json.loads(sys.stdin.read()); det = cv2.QRCodeDetector(); out = []
for c in casos:
    n = len(c['linhas']); mg = 4; es = 10; lado = (n + 2*mg) * es
    img = np.ones((lado, lado), dtype=np.uint8) * 255
    for i, l in enumerate(c['linhas']):
        for j, v in enumerate(l):
            if v == '1': img[(i+mg)*es:(i+mg+1)*es, (j+mg)*es:(j+mg+1)*es] = 0
    out.append(det.detectAndDecode(img)[0])
print(json.dumps(out))
`;
  const lido = JSON.parse(execFileSync('python3', ['-c', py], {
    input: JSON.stringify(paraLer), maxBuffer: 256 * 1024 * 1024,
  }).toString());
  const bons = paraLer.filter((c, i) => lido[i] === c.texto).length;
  console.log(`· OpenCV leu ${bons}/${paraLer.length} imagens `
    + `(o detetor dele falha em códigos válidos — é só um sinal, não trava nada).`);
} else {
  console.log('· OpenCV não instalado — leitura por imagem saltada.');
}

console.log('\nO gerador de códigos QR está provado.');
