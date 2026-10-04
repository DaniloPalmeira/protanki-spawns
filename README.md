# protanki-spawns

Captura headless, mapa a mapa, de dois dados que o `map.xml` do ProTanki não tem e que só
existem no servidor:

- **spawn de players** — onde os tanques nascem, por modo e por time;
- **spawn de suprimentos** — onde as caixas (medkit, nitro, armorup, damageup, crystal) caem,
  e as zonas fixas de gold box.

Um bot (`lib/BotClient.js`) fala o protocolo do jogo direto com o servidor, sem o client Flash:
cria uma batalha **privada** por mapa, entra, escuta o que precisa e sai. Ele nunca manda
pacote de movimento nem de tiro.

## Como rodar

```bash
npm install
cp accounts.example.json accounts.json      # contas; conta COM PASSE para batalha privada
```

Copie o `node.exe` para a raiz do repositório com o nome **`ProTanki.exe`** e rode os scripts
por ele. O NoPing faz o túnel pelo nome do executável: com `node` puro o servidor aceita o TCP
e fecha a conexão sem mandar as chaves (`timeout no handshake de chaves`).

```bash
./ProTanki.exe scripts/bonus-sweep.js --dry-run            # fila e quem alcança cada mapa
./ProTanki.exe scripts/bonus-sweep.js                      # captura de suprimentos
./ProTanki.exe scripts/spawn-sweep.js --modes DM           # spawn de players
node scripts/status.js                                     # estado do acervo
node scripts/viewer.js                                     # http://localhost:8777
```

Todas as contas do `accounts.json` rodam em paralelo puxando da mesma fila. Cada uma só pega
mapa dentro do seu rank (a batalha herda a faixa de rank do mapa). `--accounts c2,c3` limita por
label.

## Suprimentos (`scripts/bonus-sweep.js`)

Uma sessão por mapa, só DM. A batalha é privada, 1 vaga, pró, com todos os bônus ligados e
**Caixa de bônus em cronômetro preciso** (`esportDropTiming`). O bot entra sem spawnar e escuta.

**Escuta fixa de 120 s.** Medido em 91 mapas e confirmado numa recaptura: cada ponto sorteia o
instante da sua caixa **uniformemente entre 10 e 80 s** depois do início da batalha, em segundo
inteiro, e nada cai depois de 80 s (0 de 1415 quedas). A primeira caixa chega em média aos 15 s
(mais cedo em mapa com muitos pontos, pois é o mínimo de N sorteios) e a última encosta nos 80 s
em mapa grande. 120 s cobre a janela com folga; o kick de inatividade é aos 5 min.

Uma parada "por teto" (silêncio maior que o dobro do maior intervalo visto) foi testada e
**descartada**: com o sorteio uniforme e poucos pontos é comum um intervalo de 20 a 30 s depois
de quedas juntas, e ela cortou factory 6→10, pingpong 6→8 e rift 3→8. Continua disponível em
`--adaptive` só para experimento. `capture.timeline` tem o instante de cada queda em segundos e
`capture.capacity` o total de pontos.

**Cada queda é um ponto de spawn.** No cronômetro preciso cada ponto solta uma caixa, e a caixa
fica no chão até alguém pegar; como ninguém pega, a sessão única mostra cada ponto exatamente
uma vez e o total de quedas é o total de pontos do mapa. Por isso `points` guarda toda queda
sem agrupar nem deduplicar: duas caixas a 300 unidades uma da outra são dois pontos, não uma
"zona". A **coordenada** de cada queda, porém, é aleatória dentro da região do ponto: entre
duas sessões do mesmo mapa nenhuma coordenada coincidiu, e o ponto correspondente ficou a 117 a
564 unidades. Uma sessão dá uma amostra por região. Zonas de gold (`SpawnBonusRegion`) são a
sirene do gold e só aparecem em batalha com jogadores ativos; nenhuma foi vista.

Conta sem passe é descartada: sem passe a batalha sai pública e outro jogador poderia pegar
caixa no meio da coleta.

## Spawn de players (`scripts/spawn-sweep.js`)

Entra e sai da mesma batalha até o critério de parada fechar (janela dinâmica sem ponto novo,
mínimo de capturas por ponto, teto proporcional ao tamanho do mapa). Lê o ponto no
`PrepareToSpawn`, que chega ~5 s antes do `Spawn` com a mesma posição. Em modos por time grava
no time que o servidor atribuiu, não no pedido. Também captura bandeiras (CTF) e pontos de
controle (CP) na entrada.

## Saída

Um arquivo por mapa em `spawns/<map_id>.json` (versionado):

```jsonc
{
  "mapId": "map_sandbox",
  "modes": { "DM": { "NONE": [ { "x", "y", "z", "yaw", "count" } ] } },
  "bonus": {
    "capture": { "account", "battleId", "startedAt", "finishedAt", "stopReason", "capacity", "drops", "maxGapMs", "timeline" },
    "types": { "nitro": 4, "medkit": 3 },                 // pontos de spawn por tipo
    "points": { "nitro": [ { "x", "y", "z" } ] },         // um ponto por caixa que caiu
    "goldRegions": [ { "x", "y", "z", "yaw", "bonusType", "count" } ]
  },
  "ctf": { "variants": [ { "red", "blue", "count" } ] },
  "cp": { "keypointTriggerRadius", "keypointVisorHeight", "minesRestrictionRadius", "points": [] }
}
```

Progresso retomável em `state/` (fora do git). Coordenadas em unidades do jogo; `yaw` em
radianos normalizado para (-π, π].

## Decisões que valem registro

- `CreateBattleResponse` é broadcast do lobby (um para cada batalha que qualquer jogador
  cria). A nossa é identificada pelo **nome único** mandado no pedido, nunca pelo primeiro
  `SelectPacket` — logo após o login o lobby auto-seleciona uma batalha da lista.
- Depois de entrar, o `InitBattlefieldModel` confere `map_id`; mapa diferente aborta a sessão.
- Nada de rajada: cada `EnterBattle` só sai depois que o servidor confirmou a volta ao lobby.
  Rajada derruba o socket sem aviso.
- Limite de criação (medido em 04/10/2026, 48 criações): **no máximo 3 batalhas vivas por
  conta**. Uma batalha vazia some ~6 a 7 min depois que o último jogador sai; a 4ª criação
  enquanto as 3 existem não recebe `CreateBattleResponse` nenhum. Não é "3 a cada 5 min": 3
  criações em 4 min passaram. O portão espera a mais antiga expirar, e é isso que dita o ritmo
  da captura de suprimentos (~3 mapas a cada 9 min por conta). Entrar e sair não tem limite.
- Depois de várias desconexões abruptas em poucos minutos (matar o processo, logins em série),
  o servidor passa ~10 min aceitando o TCP e fechando sem mandar as chaves. O login tem retry
  espaçado por isso.
