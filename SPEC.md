# avila.visualizer — Omarchy shell plugin

Espectro de áudio no bar, com formatos e paletas escolhíveis, e as mesmas
cores espelhadas nas lâmpadas WLED.

## Problema

Não resolve problema nenhum. É enfeite, e a spec assume isso. O objetivo é
outro: ser o print que espalha o plugin. Toda decisão abaixo escolhe entre
"mais bonito" e "não queima a bateria", e o segundo ganha sempre que der.

O diferencial é a ponte WLED. Visualizador de bar existe em toda parte;
visualizador que faz a luz da sala pulsar junto não existe.

## Escopo

**v1:** espectro no bar, 5 formatos, 6 paletas, ponte WLED opcional, guardas
de energia.

**Nunca:** equalizador, controle de volume, seleção de dispositivo de saída.
Isso é do `omarchy.audio`, que já existe.

## Dependência: cava

`Quickshell.Services.Pipewire` dá dispositivos, volume e streams — **não dá
espectro**. FFT tem que vir de fora.

`cava` está no repo `extra` do Arch (0.10.7-1) e **não está instalado nesta
máquina**. Instalação é do usuário: `omarchy pkg add cava`.

O plugin nunca instala nada sozinho. Sem `cava` no PATH, o widget mostra
"cava não instalado" com o comando ao lado, e não tenta de novo até o próximo
refresh manual. Falhar em silêncio aqui seria pior que não existir.

### Como o dado chega

Config próprio gerado pelo plugin em `$XDG_RUNTIME_DIR` — **nunca** em
`~/.config/cava`, que é arquivo do usuário:

```ini
[general]
framerate = <fps>
bars = <barCount>
autosens = 1

[output]
method = raw
data_format = ascii
ascii_max_range = 100
channels = mono
```

`method = raw` + `data_format = ascii` dá uma linha por quadro: N valores 0–100
separados por `;`. Parse trivial, sem binário, sem endianness. Um `Process` de
vida longa com `SplitParser` em `\n`.

`autosens = 1` deixa o cava normalizar sozinho — menos código que ganho
automático na mão, e resultado melhor.

## Formatos

`shape`, default `bars`. Todos consomem o mesmo quadro de N valores; só muda o
desenho.

| Formato | Desenho | Nota |
|---|---|---|
| `bars` | barras crescendo da base | clássico, o mais legível em bar fino |
| `mirror` | barras crescendo do centro pra cima e pra baixo | mais denso, bom em bar alto |
| `blocks` | cada barra dividida em segmentos acesos/apagados | cara de LED de aparelho de som |
| `dots` | um ponto por barra, subindo com o valor | o mais discreto, quase não distrai |
| `wave` | linha contínua ligando os topos | ocupa menos "tinta", combina com tema minimalista |

`bars`, `mirror`, `blocks` e `dots` são `Repeater` de `Rectangle` — N
retângulos com altura animada custa muito menos que `Canvas` para N ≤ 24.
`wave` é o único que precisa de `Canvas`, e por isso é o único com custo de
repintura maior; a spec aceita isso porque é opt-in.

## Paletas

`palette`, default `accent`. A cor sai sempre por binding no tema — nunca
copiada uma vez na inicialização, senão troca de tema não repinta.

| Paleta | O que faz |
|---|---|
| `accent` | `Color.accent` sólida no espectro inteiro |
| `foreground` | `Color.foreground` sólida, o mais sóbrio |
| `intensity` | `Color.foreground` → `Color.accent` conforme a altura da barra |
| `spectrum` | matiz varia por posição, grave→agudo, saturação do tema |
| `gradient` | `gradientFrom` → `gradientTo`, dois hex do usuário |
| `urgent` | `Color.accent` normal, `Color.urgent` acima de `peakThreshold` |

`intensity` e `urgent` reagem ao som; `spectrum` e `gradient` são fixas na
posição. As duas famílias existem porque uma dá movimento de cor e a outra
mantém o bar visualmente estável — gosto pessoal, e é por isso que é setting.

## Renderização

- altura: valor do quadro, com suavização exponencial só na queda (subida é
  imediata — é o que faz parecer reativo)
- espaçamento `Style.space`, cantos `Style.cornerRadius`
- largura total **fixa**

**Nunca** deixar a altura das barras mudar a `implicitWidth` do widget. Bar que
dança horizontalmente é o defeito clássico do gênero.

## Ponte WLED

Opt-in, `wledEnabled` default desligado. Reusa o `avila.wled` que já roda nesta
máquina — não abre um segundo cliente HTTP nem duplica descoberta de device.

- **taxa própria, muito menor**: `wledRateHz` default 10, teto 20. WLED por
  HTTP não aguenta 30/s; o primeiro sintoma não é o plugin engasgar, é a
  lâmpada travar e parar de responder até reiniciar.
- **o que é enviado**: brilho vem da energia média do quadro, cor vem da paleta
  ativa avaliada nessa mesma energia. A lâmpada mostra a mesma cor que o bar,
  que é o ponto.
- **`wledDevices`** vazio significa todos os devices que o `avila.wled` conhece;
  preenchido, restringe a esses.
- **`wledRestore`** (default ligado): ao desligar a ponte, ou quando o áudio
  para, devolve o device ao estado anterior. Deixar a lâmpada congelada numa
  cor aleatória depois de fechar o Spotify é comportamento inaceitável.
- **guardas de energia valem igual**: sem áudio, sem tráfego na rede.
- falha de HTTP não derruba o visualizador. Erro na ponte desliga a ponte,
  o bar continua desenhando.

## Guardas de energia

Isto é laptop (BAT0, Intel Iris Xe). Redesenhar o bar a 60fps sem parar é
inaceitável, e é o motivo de a maioria desses plugins ser desinstalada em uma
semana.

O `Process` do cava é **morto**, não pausado, quando:

1. **Nada tocando** — `Quickshell.Services.Pipewire` diz se há stream de saída
   ativo. Sem áudio, sem cava. É o guarda que mais economiza.
2. **Na bateria** e `pauseOnBattery` ligado (default: ligado).
3. **Widget não visível** — bar escondido, outro workspace, tela travada.

Voltar ao normal religa o processo. Estado morto desenha o formato ativo em
repouso (barras achatadas, linha reta), **nunca** esconde o widget — sumir e
voltar reflui o bar inteiro.

`framerate` default 30, não 60. A olho nu no tamanho de um bar a diferença não
aparece; no consumo, aparece.

## Configuração (`manifest.json`)

| Chave | Tipo | Default | Faixa |
|---|---|---|---|
| `shape` | string | `bars` | `bars`/`mirror`/`blocks`/`dots`/`wave` |
| `palette` | string | `accent` | ver tabela de paletas |
| `gradientFrom` | string | `""` | hex, só para `gradient` |
| `gradientTo` | string | `""` | hex, só para `gradient` |
| `peakThreshold` | integer | 85 | 50–100, só para `urgent` |
| `barCount` | integer | 14 | 6–24 |
| `segments` | integer | 8 | 3–16, só para `blocks` |
| `framerate` | integer | 30 | 10–60 |
| `widgetWidth` | integer | 90 | 40–300 |
| `barWidth` | integer | 3 | 1–8 |
| `smoothing` | integer | 60 | 0–95 (queda) |
| `pauseOnBattery` | boolean | true | |
| `pauseWhenSilent` | boolean | true | |
| `wledEnabled` | boolean | false | |
| `wledRateHz` | integer | 10 | 1–20 |
| `wledDevices` | string | `""` | vazio = todos |
| `wledRestore` | boolean | true | |

## Arquivos

```
avila.visualizer/
├── manifest.json       kinds: ["service","bar-widget"]
├── Service.qml         cava, guardas de energia, quadro corrente
├── Panel.qml           entryPoint barWidget
├── Spectrum.qml        desenho; despacha por shape
├── Visualizer.js       lógica pura: config do cava, parse, suavização, paletas
├── WledBridge.js       energia → brilho/cor, throttle, restore
├── test_visualizer.js  node test_visualizer.js
├── README.md
├── CLAUDE.md
├── LICENSE             MIT
├── preview.png         (gif vale mais que png aqui)
└── .gitignore
```

## Checks

`node test_visualizer.js`, sem áudio, sem cava, sem rede:

**cava e quadro**
- config gerado: `bars`/`framerate` batem com as settings, faixas respeitadas
- parse de `"0;12;45;98;3"` → array de números
- quadro curto/longo em relação a `barCount` → preenche ou corta, nunca estoura
- lixo no stream (linha parcial, byte solto) → quadro descartado, anterior fica
- suavização: subida imediata, queda proporcional a `smoothing`
- `smoothing = 0` e `= 95` nos extremos, sem NaN

**Paletas**
- cada paleta devolve cor válida para valor 0, 50 e 100
- `intensity` interpola entre as duas cores do tema, extremos inclusos
- `spectrum` distribui matiz sem repetir a primeira e a última barra
- `gradient` com hex inválido ou vazio → cai pra `accent`, não quebra
- `urgent` cruza no `peakThreshold` e volta

**Formatos**
- cada shape produz a mesma quantidade de elementos que `barCount`
- `blocks` acende `round(valor/100 * segments)` segmentos, 0 e 100 inclusos
- `mirror` é simétrico em torno do centro

**Ponte WLED**
- energia média do quadro → brilho, monotônico e dentro de 0–255
- throttle respeita `wledRateHz`: quadros a mais são descartados, não enfileirados
- silêncio → um envio de restore, e só um
- erro de HTTP → ponte desliga, quadro continua sendo produzido

**Pausa**
- tabela-verdade de (tocando, na bateria, visível) → ligado/desligado

## O que vai morder

- **Largura variável** reflui o bar inteiro a cada quadro. Largura fixa, sempre.
- **Cava zumbi**: se o shell recarregar o plugin sem matar o `Process`, sobra
  cava rodando pra sempre. Matar explicitamente no destrutor e no reload.
- **Config em `~/.config/cava`**: nunca escrever lá.
- **WLED a 30/s trava a lâmpada.** O throttle não é otimização, é proteção do
  hardware — e o sintoma (lâmpada que para de responder) parece defeito do
  WLED, não do plugin, o que torna o bug caro de diagnosticar.
- **Lâmpada congelada** depois que o áudio para é o pior defeito possível da
  ponte. `wledRestore` tem que funcionar inclusive quando o shell morre no meio.
- **`autosens` demora** a calibrar — pico feio nos primeiros quadros. Descartar
  os primeiros ~10.
- **Troca de tema** precisa repintar: cor por binding, nunca cópia.
- **Silêncio não é zero absoluto**: ruído de fundo mantém barras tremendo em 1–2.
  Piso mínimo (`< 3` vira 0) evita widget que nunca descansa — e, com a ponte
  ligada, evita lâmpada tremendo a noite inteira.
- **`wave` usa `Canvas`** e custa mais que os outros formatos. Aceito por ser
  opt-in, mas não pode virar default.
