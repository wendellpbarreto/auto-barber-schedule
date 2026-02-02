# Auto Barber Schedule

Agendamento automático na barbearia Mr. Hudson (CashBarber). O fluxo faz **autenticação** na API e tenta agendar **todos os slots** da recorrência que caem nos **próximos 15 dias** (limite da API), com intervalo entre tentativas para evitar rejeição.

## Recorrência

Horários disponíveis: **terça 12h**, **quinta 12h**, **sábado 9h**. A recorrência começa na **quinta 05/02** e segue o ciclo:

**Quinta 12h → Terça 12h → Sábado 9h → Quinta 12h → …**

Intervalos entre agendamentos: 5 dias (qui→ter), 4 dias (ter→sáb), 5 dias (sáb→qui). Em média ~4–5 dias entre idas (menos que 7), sem intervalos curtos demais.

## Fluxo

1. **Auth**: `POST https://api.cashbarber.com.br/api/mrhudson/web/auth` (email + senha).
2. **Agendamento**: para cada slot da recorrência nos próximos 15 dias (ex.: qui, ter, sáb), `POST .../agendamentos` com Bearer token. Entre cada tentativa há um delay (padrão 3s) para não sobrecarregar a API. Slots já ocupados (422) são tratados como sucesso.

O job roda **todo dia de madrugada** (GitHub Actions) para tentar garantir os horários.

## Variáveis de ambiente

Copie `.env.example` para `.env` e preencha (nunca commite `.env`):

| Variável                   | Obrigatório | Descrição                                                                                   |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `CASHBARBER_EMAIL`         | Sim         | E-mail do login CashBarber                                                                  |
| `CASHBARBER_PASSWORD`      | Sim         | Senha                                                                                       |
| `CASHBARBER_AGE_ID_FILIAL` | Não         | ID da filial (padrão: 3483)                                                                 |
| `CASHBARBER_AGE_ID_USER`   | Não         | Não usado no agendamento; barbeiro é por dia: Ter/Qui = Lucas (21185), Sáb = Hudson (21218) |
| `CASHBARBER_SERVICOS`      | Não         | IDs dos serviços separados por vírgula (padrão: 50954,50952)                                |
| `CASHBARBER_BOOK_DELAY_MS` | Não         | Delay em ms entre tentativas (padrão: 3000)                                                 |

## Uso local

- **API**: `POST /api/cashbarber/book` (com env configurado). Ex.: `curl -X POST http://localhost:3033/api/cashbarber/book`
- **Script**: `node scripts/book.js` (defina as variáveis no ambiente ou use um `.env` carregado por outro meio).

## GitHub Actions

O workflow `.github/workflows/cashbarber-book.yml` roda:

- **Schedule**: todo dia às 06:00 UTC (03:00 BRT).
- **Manual**: Actions → CashBarber book → Run workflow.

Configure os **secrets** do repositório em Settings → Secrets and variables → Actions:

- `CASHBARBER_EMAIL` (obrigatório)
- `CASHBARBER_PASSWORD` (obrigatório)
- `CASHBARBER_AGE_ID_FILIAL`, `CASHBARBER_AGE_ID_USER`, `CASHBARBER_SERVICOS` (opcionais; sem eles usam os padrões acima).

## Deploy (Vercel)

Se fizer deploy da API, defina as mesmas variáveis em Vercel (Settings → Environment Variables) e pode acionar o agendamento com `POST https://seu-app.vercel.app/api/cashbarber/book` (por exemplo a partir de um cron externo).

---

## Getting Started (Next.js)

```bash
npm run dev
```

Dev server em [http://localhost:3033](http://localhost:3033).

## Deploy on Vercel

[Vercel Platform](https://vercel.com/new) – documentação em [Next.js deployment](https://nextjs.org/docs/deployment).
