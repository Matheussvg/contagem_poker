# Mesa dos Cinco

Placar semanal de pôquer para Fortunato, Galdino, Jonatas, Pedro e Lucas.
Todos entram com o mesmo login e podem lançar e apagar resultados.

- **Fichas** — as quatro fichas em 3D com os valores da casa (vermelha R$ 10,
  verde R$ 15, azul R$ 20, branca R$ 50) e um contador de pilha.
- **Placar** — cada jogador começa a semana com R$ 475; lance quanto ganhou ou
  perdeu no dia e o saldo se atualiza para todo mundo.
- **Histórico** — o resultado de cada semana já fechada.

A semana corre de **sexta a quinta**. Na virada de quinta para sexta, às 00:00,
a semana vira histórico e todos voltam para R$ 475 — nada precisa ser fechado
na mão, porque a semana é calculada a partir da data.

## Rodando na sua máquina

```bash
npm install
npm start
# http://localhost:3000  ·  login admin / senha admin
```

Sem `DATABASE_URL`, o placar fica em `data/placar.json`.

## Publicando no Render

1. Suba este repositório no GitHub.
2. No Render, **New → Web Service**, aponte para o repositório. O
   `render.yaml` já traz build (`npm install`), start (`npm start`) e o
   health check.
3. Em **Environment**, defina:

   | Variável | Para quê |
   |---|---|
   | `MESA_SENHA` | a senha da mesa (o padrão é `admin` — troque) |
   | `MESA_USUARIO` | o login (padrão `admin`) |
   | `SESSION_SECRET` | assina o cookie de sessão; deixe o Render gerar |
   | `DATABASE_URL` | opcional, mas importante — veja abaixo |

### O ponto que exige atenção: onde os dados ficam

O disco de um Web Service no plano free do Render é **efêmero**: a cada deploy
ou reinício o `data/placar.json` volta do zero. Para o placar durar:

- Crie um **PostgreSQL** no Render e ligue a `DATABASE_URL` ao serviço
  (o `render.yaml` tem o trecho comentado pronto). O servidor cria a tabela
  sozinho no primeiro boot. O Postgres free do Render expira depois de um
  tempo — se for usar por temporadas inteiras, vale o plano pago mais barato.
- Ou anexe um **Disk** ao serviço (exige plano pago) e aponte `DATA_DIR` para
  o caminho montado.

Enquanto estiver decidindo, dá para baixar um backup a qualquer momento em
`/api/backup` (precisa estar logado).

Outro detalhe do plano free: o serviço dorme sem tráfego, então a primeira
abertura do dia leva alguns segundos.

## API

Todas as rotas abaixo de `/api` exigem o cookie de sessão.

| Método | Rota | O que faz |
|---|---|---|
| `GET` | `/api/sessao` | diz se o cookie ainda vale |
| `POST` | `/api/login` | `{usuario, senha}` |
| `POST` | `/api/logout` | encerra a sessão |
| `GET` | `/api/semanas` | todas as semanas com o saldo final de cada jogador |
| `GET` | `/api/semanas/:sexta` | lançamentos da semana que começa naquela sexta |
| `POST` | `/api/semanas/:sexta/lancamentos` | `{jogador, valor, dia}` — valor negativo é perda |
| `DELETE` | `/api/semanas/:sexta/lancamentos/:id` | apaga um lançamento |
| `GET` | `/api/backup` | o placar inteiro em JSON |

## Estrutura

```
server.js              API + arquivos estáticos
public/index.html      o site inteiro (HTML, CSS e JS numa página só)
public/fichas/*.glb    os modelos 3D das fichas
render.yaml            configuração do Render
```

Os `.glb` são carregados pelo `<model-viewer>`, que vem de CDN. Se ele não
carregar, a página mostra fichas desenhadas em CSS com as mesmas cores e
valores — nada quebra.
