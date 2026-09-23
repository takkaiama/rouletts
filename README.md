# Rouletts — v1.4.0 · coleta contínua por servidor

Versão preparada a partir do ZIP enviado em 23/09/2026 e do arquivo Python `basedados (2).py` (apenas como referência de regras; **não** está incluído porque continha um token Telegram). A publicação em produção depende dos serviços Render/Neon/Netlify do proprietário.

## Funcionamento

- Uma requisição ao feed consulta **todas as roletas suportadas disponíveis na API de origem**. Mesas com duplo zero, como American Roulette, ficam excluídas porque o banco e as estratégias atuais representam apenas 0–36. A coleta é iniciada no backend/worker e independe da aba do navegador.
- O PostgreSQL Neon conserva os **últimos 2.000 giros por mesa**, com o identificador de cada mesa separado. A inserção de novos giros, a remoção dos mais antigos e o avanço da fotografia dos últimos cinco números da API ocorrem na mesma transação.
- A primeira observação de uma mesa nova armazena os cinco números que a API fornece. Como a API não fornece aqui os horários individuais anteriores, esses registros iniciais recebem o horário da observação e não disparam Telegram retroativo.
- A comparação usa a sequência de cinco números, não somente o número mais recente: números consecutivos iguais **podem** ser distinguidos quando a fotografia muda; números repetidos que deixam a janela inteira idêntica **não podem** ser detectados sem identificador de rodada da origem.
- Quando uma janela deixa de se sobrepor à anterior, o sistema grava apenas o número que consegue identificar, incrementa `gap_count` e cancela sinais abertos dessa mesa. Não inventa giros perdidos; estratégias não cruzam essa lacuna.
- Uma trava PostgreSQL permite que apenas um processo execute a coleta a cada vez. Os demais processos não duplicam a gravação. O cache da aplicação web acompanha as revisões de histórico gravadas pelo worker em processo distinto.
- Na interface, cards de números (1 a 4), cores (2 a 4), colunas (2 a 4) e consenso usam os últimos 2.000 registros para identificar padrões, com **amostra de até cinco ocorrências recentes por estratégia**. Os cards numéricos indicam a categoria de cor observada após o padrão, não um número exato.
- O perfil Telegram apagado deixa de ter mensagens novas elegíveis; mensagens já aceitas pelo Telegram não podem ser desfeitas. Desligar uma estratégia cancela sinais e envios pendentes desse perfil.

**Limite da fonte:** cinco posições não permitem recuperar uma interrupção com mais de cinco giros, nem garantir captura de repetições que mantenham a janela idêntica. A análise estatística de resultados passados não constitui previsão dos próximos resultados.

## Publicação — escolha uma das arquiteturas

**A. Manter o serviço atual, com menor alteração:** no Render, configure o Web Service que já atende a API como uma **instância que não hiberna** (plano pago). `Root Directory: backend`, `Build Command: npm ci`, `Start Command: npm start`. Configure `COLLECTOR_MODE=web`. O servidor HTTP e coletor são executados no mesmo processo; o site pode ficar fechado e o processo continuará coletando enquanto o serviço estiver ativo.

**B. Separar a coleta do servidor web:** crie um **Background Worker sempre ativo** no Render conectado ao mesmo repositório: `Root Directory: backend`, `Build Command: npm ci`, `Start Command: npm run worker`. Nesse worker, configure as mesmas `DATABASE_URL` e `ENCRYPTION_KEY` do backend, com `POLL_MS=2500`. No Web Service existente, configure `COLLECTOR_MODE=external` para não iniciar o coletor na web. O worker coleta e grava os dados quando o site está fechado; o site lê o banco ao ser aberto. O Web Service gratuito, se mantido, ainda hiberna e pode demorar para abrir, mas isso não interrompe o worker. Não crie um worker gratuito imaginário: verifique a modalidade e os custos antes da criação.

**Preserve as variáveis já existentes**, sobretudo `DATABASE_URL` e `ENCRYPTION_KEY`. Não troque o banco nem a chave que criptografa os perfis Telegram existentes. `ADMIN_USERNAME` e `ADMIN_PASSWORD` só inicializam o primeiro administrador num banco vazio. Cadastre `FRONTEND_ORIGIN` com a URL exata do Netlify. Não publique o `.env` no GitHub. No worker separado, `ADMIN_USERNAME` e `ADMIN_PASSWORD` não são usados para criar usuário, mas a chave de criptografia é obrigatória para o envio Telegram.

O primeiro deploy executa alterações aditivas no esquema SQL: coluna de revisão do histórico e tabela `collector_health`. Nenhuma tabela de giros, contas ou perfis existente é apagada por essa migração.

## Diagnóstico pós-deploy

Abra `https://SEU-BACKEND.onrender.com/api/health` (sem login) e confira os campos `database`, `collector.online`, `collector.lastPoll`, `collector.lastSuccess`, `collector.tableCount`, `collector.received` e `collector.error`. Aguarde a origem efetivamente responder; `database=connected` isoladamente **não** confirma que há coleta. Feche todas as abas, compare `collector.lastPoll` após alguns minutos e, ao reabrir o site, confira a contagem armazenada de uma mesa com resultados novos. `collector.online=false` com `lastPoll` antigo indica que o processo não está ativo ou não conseguiu atualizar a tabela de saúde. Uma API de origem indisponível pode produzir `collector.error` mesmo com o servidor funcionando.

No Render, verifique os logs `[coleta]`, `[mesa <id>]`, `[sinais]` e `[telegram]`. Se a API recusar conexões, altere seu formato ou proibir consultas, interrompa as tentativas e confirme a autorização de uso da origem; não tente contornar bloqueios.

O Netlify permanece com `Publish directory: frontend`, `Build command: echo Static frontend ready`. O frontend continua estático e não executa a coleta.

## Publicar no GitHub pelo PowerShell

Baixe `rouletts-v1.4.0-coleta-continua.zip` e execute as instruções completas de `PUBLICAR-POWERSHELL.txt`. O script clona `https://github.com/takkaiama/rouletts`, copia a nova versão sobre o clone atualizado e executa `git push origin main`, **sem `--force`**. O push só publica código: a coleta contínua depende de configurar o Render conforme a arquitetura escolhida.

## Verificação local

Na pasta `backend`, com Node.js 22 ou 24: `npm ci` e `npm test`. Os testes são offline; a execução em produção precisa ser verificada com a conexão real ao Neon, API de origem e Telegram. Não há migração destrutiva nem backup automatizado incluído; faça backup do Neon antes do primeiro deploy.
