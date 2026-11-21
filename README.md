# 🤖 Assistente IA

Assistente pessoal com inteligência artificial (Claude):

- **📞 Atende chamadas quando não podes.** Quem te liga e não é atendido é
  reencaminhado para a IA, que conversa por voz em português de Portugal,
  percebe quem é e o que quer, e anota o recado. No fim recebes um **SMS com o
  resumo** (quem, assunto, urgência, o que fazer).
- **💬 Ajuda a responder mensagens** do Instagram, Facebook, WhatsApp, etc.
  Usas **Partilhar → Assistente** no telemóvel (ou colas a mensagem) e recebes
  3 respostas no teu estilo, prontas a copiar. Também avisa se a mensagem
  parecer burla.
- **⚙️ Painel web** (instalável no telemóvel como app): histórico das chamadas
  com a conversa completa, ligar/desligar a IA, o que a IA pode dizer, lista de
  contactos conhecidos.

## Porque é que as mensagens não são respondidas sozinhas?

A Meta só permite respostas automáticas em **contas Profissionais** (Instagram
Business/Criador e Páginas do Facebook), através da API oficial. Automatizar
uma conta **pessoal** (robôs que fazem login por ti) viola os termos e leva a
bloqueios da conta. Por isso, nas contas pessoais, a IA **sugere** e és tu que
envias, com um toque.

> Se mudares para conta Profissional (é grátis: Definições → Tipo de conta),
> dá para acrescentar respostas 100% automáticas pela API oficial da Meta.

## Segurança

- A IA ao telefone **nunca** dá dados pessoais, códigos ou palavras-passe,
  nunca assume compromissos nem aceita pagamentos em teu nome — só anota
  recados. Ignora quem tente mudar as regras dela.
- Só partilha o que escreveres no campo "O que a IA pode dizer".
- Os pedidos de chamadas são validados com a assinatura do Twilio (ninguém
  consegue fingir chamadas para gastar os teus créditos).
- Conversas limitadas a 12 trocas; o painel tem limite de tentativas de login.

## Como pôr a funcionar

### 1. Contas necessárias

| Serviço | Para quê | Custo aproximado |
|---|---|---|
| [Anthropic](https://console.anthropic.com) | A IA (Claude) | alguns cêntimos por chamada |
| [Twilio](https://www.twilio.com) | Número de telefone + voz + SMS | número ~1–15 €/mês + cêntimos/minuto |
| [Render](https://render.com) (ou outro) | Servidor sempre ligado | ~7 $/mês |

> Números portugueses (+351) no Twilio exigem um "Regulatory Bundle"
> (documento de identificação e morada). Em alternativa podes usar um número de
> outro país, mas o reencaminhamento pode custar mais na tua operadora.

### 2. Instalar o servidor

```bash
npm install
cp .env.example .env   # preenche os valores
node --env-file=.env src/server.js
```

No Render: **New → Blueprint** e escolhe este repositório (usa o `render.yaml`).
Preenche as variáveis pedidas; `PUBLIC_URL` é o endereço que o Render te dá.

### 3. Ligar o número do Twilio

No Twilio → Phone Numbers → o teu número → **Voice Configuration**:

- *A call comes in* → Webhook → `https://O-TEU-SERVIDOR/voz/entrada` (POST)
- *Call status changes* → `https://O-TEU-SERVIDOR/voz/estado` (POST)

### 4. Reencaminhar as chamadas do teu telemóvel

No teu telemóvel, marca estes códigos (funcionam na MEO, NOS e Vodafone; troca
`NUMERO` pelo número Twilio, com `+351…` ou o indicativo do país):

| Quando | Código para ativar | Para desativar |
|---|---|---|
| Não atendes | `**61*NUMERO#` | `##61#` |
| Estás ocupado | `**67*NUMERO#` | `##67#` |
| Sem rede / desligado | `**62*NUMERO#` | `##62#` |
| Todas as anteriores | `**004*NUMERO#` | `##004#` |

Podes também fazê-lo em Definições → Chamadas → Reencaminhamento.

### 5. Painel e app no telemóvel

Abre `https://O-TEU-SERVIDOR`, entra com a `PAINEL_SENHA`, e em
**Definições** escreve o teu nome, o que a IA pode dizer e o teu telemóvel para
os SMS. No Android, no Chrome: menu → **Instalar app**. A partir daí a app
aparece no menu **Partilhar** do Instagram, Facebook e outras.

## Testes

```bash
npm test
```

Testam uma chamada completa (saudação → conversa → resumo → SMS), silêncio,
validação do Twilio, login do painel e o formato do pedido ao Claude — tudo
com IA e Twilio simulados, sem gastar créditos.

## Estrutura

```
src/server.js     servidor + API do painel
src/voz.js        webhooks do Twilio (atender chamadas)
src/ia.js         conversa, resumos e sugestões com o Claude
src/armazem.js    configuração e histórico (ficheiros JSON em data/)
src/notificar.js  SMS de resumo
public/           painel web (PWA com "Partilhar")
```
