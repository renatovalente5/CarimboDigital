"""Descodificador de QR independente — a prova do gerador.

Lê a matriz como um leitor a sério: tira a informação de formato para saber
a máscara, desmascara, percorre o ziguezague, desintercala os blocos,
confirma que todas as síndromes de Reed-Solomon dão zero e volta a montar o
texto. Escrito de propósito noutra linguagem e a partir da norma, não do
JavaScript: se os dois tivessem a mesma ideia errada, isto não provava nada.

Sem dependências — corre com o python3 que vier na máquina.

Verifica, a partir da matriz, que cada bloco é uma palavra de código
Reed-Solomon válida (síndromes todas a zero) e que os dados lá dentro são o
texto que pedimos. Implementação independente da do JavaScript."""
import sys, json

EXP=[0]*512; LOG=[0]*256
x=1
for i in range(255):
    EXP[i]=x; LOG[x]=i
    x<<=1
    if x & 0x100: x ^= 0x11d
for i in range(255,512): EXP[i]=EXP[i-255]
def mul(a,b):
    if a==0 or b==0: return 0
    return EXP[LOG[a]+LOG[b]]

CORR={'L':[-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
      'M':[-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
      'Q':[-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
      'H':[-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30]}
BLOC={'L':[-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
      'M':[-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
      'Q':[-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
      'H':[-1,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81]}
MASC=[lambda l,c:(l+c)%2==0, lambda l,c:l%2==0, lambda l,c:c%3==0, lambda l,c:(l+c)%3==0,
      lambda l,c:(l//2+c//3)%2==0, lambda l,c:((l*c)%2)+((l*c)%3)==0,
      lambda l,c:(((l*c)%2)+((l*c)%3))%2==0, lambda l,c:(((l+c)%2)+((l*c)%3))%2==0]

def crus(v):
    r=(16*v+128)*v+64
    if v>=2:
        n=v//7+2; r-=(25*n-10)*n-55
        if v>=7: r-=36
    return r
def alin(v):
    if v==1: return []
    n=v//7+2; t=v*4+17
    passo=26 if v==32 else -(-(v*4+4)//(n*2-2))*2
    r=[6]; p=t-7
    while len(r)<n: r.insert(1,p); p-=passo
    return r
def mapa(v):
    t=v*4+17; f=[[0]*t for _ in range(t)]
    def marca(l0,c0,h,w):
        for l in range(l0,l0+h):
            for c in range(c0,c0+w):
                if 0<=l<t and 0<=c<t: f[l][c]=1
    marca(0,0,9,9); marca(0,t-8,9,8); marca(t-8,0,8,9)
    marca(6,0,1,t); marca(0,6,t,1)
    pos=alin(v)
    for l in pos:
        for c in pos:
            if (l==6 and c==6) or (l==6 and c==t-7) or (l==t-7 and c==6): continue
            marca(l-2,c-2,5,5)
    if v>=7: marca(0,t-11,6,3); marca(t-11,0,3,6)
    return f

def descodificar(linhas, nivel):
    t=len(linhas); v=(t-17)//4
    M=[[int(ch) for ch in l] for l in linhas]
    # ler a informação de formato (primeira cópia) para saber a máscara
    bits=0
    ordem=[(i,8) for i in range(6)]+[(7,8),(8,8),(8,7)]+[(8,14-i) for i in range(9,15)]
    for k,(l,c) in enumerate(ordem): bits |= M[l][c]<<k
    bits ^= 0x5412
    masc=(bits>>10)&7
    f=mapa(v); mk=MASC[masc]
    for l in range(t):
        for c in range(t):
            if not f[l][c] and mk(l,c): M[l][c]^=1
    b=[]
    base=t-1
    while base>=1:
        col=base-1 if base<=6 else base
        for passo in range(t):
            cima=((col+1)&2)==0
            linha=t-1-passo if cima else passo
            for c in (col,col-1):
                if f[linha][c]: continue
                b.append(M[linha][c])
        base-=2
    total=crus(v)//8
    by=[]
    for i in range(0,total*8,8):
        val=0
        for j in range(8): val=(val<<1)|b[i+j]
        by.append(val)
    # desintercalar
    nb=BLOC[nivel][v]; pb=CORR[nivel][v]; cap=total-pb*nb
    curtos=nb-(cap%nb); basel=cap//nb
    tam=[basel+(0 if i<curtos else 1) for i in range(nb)]
    dados=[[] for _ in range(nb)]; k=0
    for i in range(basel+1):
        for bl in range(nb):
            if i<tam[bl]: dados[bl].append(by[k]); k+=1
    ecc=[[] for _ in range(nb)]
    for i in range(pb):
        for bl in range(nb): ecc[bl].append(by[k]); k+=1
    # síndromes
    for bl in range(nb):
        pal=dados[bl]+ecc[bl]
        for s in range(pb):
            acc=0
            for j,cw in enumerate(pal):
                acc ^= mul(cw, EXP[(s*(len(pal)-1-j))%255])
            if acc!=0: return None, 'sindrome %d do bloco %d nao e zero' % (s,bl)
    fluxo=[]
    for bl in range(nb): fluxo.extend(dados[bl])
    bb=[]
    for cw in fluxo:
        for j in range(7,-1,-1): bb.append((cw>>j)&1)
    def take(n):
        nonlocal bb
        val=0
        for _ in range(n): val=(val<<1)|bb.pop(0)
        return val
    modo=take(4)
    if modo!=4: return None, 'modo %d nao e byte' % modo
    n=take(8 if v<10 else 16)
    dados_bytes=bytes(take(8) for _ in range(n))
    return dados_bytes.decode('utf-8'), None

casos=json.loads(sys.stdin.read())
falhas=0
for c in casos:
    txt, erro = descodificar(c['linhas'], c['nivel'])
    if erro or txt!=c['texto']:
        print('X v%-2d %s (%d car.): %s' % (c['versao'], c['nivel'], len(c['texto']), erro or ('leu %r'%txt[:30])))
        falhas+=1
print(json.dumps({'falhas':falhas,'total':len(casos)}))
