# Roleta Analytics Web v1.1.0

Front-end HTML/CSS/JS para Netlify, API/monitor Node.js para Render e histórico PostgreSQL para Neon.

## O que mudou nesta versão (v1.1.0)

- **Histórico circular por mesa:** quando chegam novos giros e há 2.000 registros, insere o novo e exclui o mais antigo dentro da mesma transação PostgreSQL. Não apaga nem regrava todos os 2.000 resultados.
- **Cache compartilhado no servidor:** carrega até 2.000 resultados uma vez por mesa; o processamento das estratégias e a grade consultam o histórico em memória. Alterações manuais do administrador invalidam o cache e forçam recarga sincronizada.
- **Grade incremental:** `/api/live` informa apenas os novos giros desde o último ID visto, sem reler a tabela de giros do Neon em cada atualização. Alterações manuais e reinícios do servidor fazem o navegador sincronizar a grade inteira automaticamente. Os detalhes de sinais, fila e preferências são atualizados a cada 30 segundos.
- **Menos consultas de coleta:** mesas disponíveis são descobertas uma vez por processo, lista de mesas acompanhadas é atualizada a cada 15 segundos, e a foto da janela da API é gravada somente quando a janela muda. O monitor continua consultando a origem a cada ~2,5 s (configurável).
- **Telegram com espera quando vazio:** a fila não consulta o Neon a cada 1,4 segundo quando não há mensagens; um novo sinal reativa a consulta, e mensagens pendentes de uma interrupção são recuperadas no reinício.
- **Atualização sem perder contas:** não apague o banco Neon, não altere a chave de criptografia e não substitua as variáveis `ADMIN_*` para tentar recriar contas existentes. O esquema atual é compatível com a v1.0.0.

**Limitações:** manter 2.000 resultados limita o armazenamento dos giros, mas as tabelas de usuários, sinais, mensagens e auditoria também consomem espaço. A API original pode não diferenciar duas janelas idênticas após giros repetidos nem recuperar uma interrupção maior que a janela de cinco posições. O histórico exibido reflete os giros efetivamente identificados; não constitui garantia de completude ou latência da fonte. Esta versão ainda exige um processo Render que não hiberne e o Neon para persistência. Não inclui integração de apostas.

## Funcionalidades

- Grade atualizada a cada 2,5 segundos (requisições incrementais), mais recentes no topo, 50/100/200/500/1.000/2.000 ou quantidade de 1 a 2.000.
- Coleta em servidor independente das abas abertas. Mantém **até 2.000 resultados por mesa** no PostgreSQL, retirando o mais antigo na mesma transação da inserção de cada giro novo; usa uma fotografia das últimas cinco posições da API para detectar giros.
- 11 cards móveis/recolhíveis: padrões de 1–4 números, 2–4 cores, 2–4 colunas e consenso numérico. Cards são individuais à aba do navegador.
- Contas com autenticação no backend, separação admin/usuário; admin cria/edita/remove contas e insere/corrige/apaga giros, com registro de auditoria. Edição manual não envia sinal retroativo.
- Cada conta escolhe mesa, estratégias a notificar, token, chat ID, tópico opcional, percentual de amostra e número de gales. Apenas sinais **criados depois de habilitar** a flag são enviados. Uma fila sequencial evita mensagens simultâneas.
- SG, G1, G2... até o limite livremente escolhido. Cada giro posterior avança um único nível; GREEN encerra, RED somente após o giro permitido final.
- Os tokens de bot são criptografados no banco com AES-256-GCM; senhas de login usam scrypt/salt; tokens de sessão são armazenados apenas com hash.

**Avisos importantes:** Este projeto analisa resultados e não prevê resultados de jogos aleatórios. Não automatiza apostas. Não inclui nem reutiliza o token exposto no script original: **revogue aquele token pelo BotFather e crie outro antes de configurar o site**. Não publique credenciais em HTML, JavaScript, `.env` ou no GitHub. A API da origem pode bloquear o servidor, ficar indisponível ou alterar formato/termos; nesse caso o coletor sinaliza falha. Não há garantia de captura de todos os giros quando a consulta é interrompida por mais de cinco giros ou quando a janela de cinco resultados permanece visualmente idêntica após repetições; sem identificador de rodada na fonte não é possível distinguir todas essas situações com certeza. Um período indisponível é contabilizado como lacuna; o sistema não inventa os giros faltantes.

## 1 — Criar banco Neon

Crie um projeto PostgreSQL no Neon e copie a connection string `postgresql://...?...sslmode=require`. As tabelas serão criadas pelo aplicativo no primeiro início. Não compartilhe a connection string.

## 2 — Subir o servidor no Render

1. Envie a pasta inteira deste projeto a um repositório **privado** no GitHub (pode torná-lo público depois de revisar os segredos). **Não** inclua o `.py` original, que contém um token real.
2. Render → New → Web Service → selecione o repositório.
3. Configure `Root Directory` = `backend`, `Build Command` = `npm install` e `Start Command` = `npm start`.
4. Configure no painel do Render as variáveis de ambiente do `backend/.env.example`: `DATABASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` com pelo menos 12 caracteres, `ENCRYPTION_KEY` com 64 hexadecimais e `FRONTEND_ORIGIN` com sua URL do Netlify (`https://...netlify.app`). Não copie o `.env` real para o GitHub.
5. Para gerar a chave, rode no PowerShell `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` e cole o resultado no Render.
6. Ao iniciar, abra `https://SEU-BACKEND.onrender.com/api/health`: deve exibir `ok: true` (e o status da API de origem). O primeiro admin é criado pelas variáveis de ambiente **apenas em um banco vazio**. Para atualizar a versão anterior, reutilize o MESMO DATABASE_URL e a MESMA ENCRYPTION_KEY: trocar a chave impede recuperar os tokens de Telegram já criptografados.
7. Para coleta realmente contínua, use uma instância Render que **não hiberne** e mantenha **uma única instância** deste worker. Planos/instâncias que adormecem interrompem a coleta e os envios. Caso a infraestrutura faça deploys/reinícios, poderá existir uma lacuna nos dados.

## 3 — Publicar o site no Netlify

1. Netlify → Add new project → Import from Git → selecione o mesmo repositório.
2. Use `Base directory` vazio (raiz), `Build command` = `echo Static frontend ready`, `Publish directory` = `frontend`. O arquivo `netlify.toml` da raiz já contém essa configuração.
3. Copie a URL final do Netlify e cadastre-a em `FRONTEND_ORIGIN` no Render; faça novo deploy do backend após a mudança.
4. Abra o site do Netlify. Na tela de login, informe a URL HTTPS pública do **Render**, o usuário `ADMIN_USERNAME` e a senha `ADMIN_PASSWORD`. A URL fica gravada no navegador, não no GitHub.
5. Selecione a mesa. Aguarde a primeira atualização e escolha as estratégias desejadas. Configure novo token do bot, chat ID, e clique em **Verificar bot e sala**. Salve as configurações e marque **Enviar ao Telegram**. O sistema arma o envio no giro mais recente existente: não envia sinais retrospectivos.

No Netlify, o front-end é estático. Tentar publicar **somente** HTML no Netlify não manteria o coletor funcionando depois de fechar o navegador nem protegeria o token do Telegram e as contas.

## Atualizar o GitHub existente pelo Windows PowerShell (sem forçar histórico)

Extraia o ZIP na pasta Downloads; copie os arquivos para um clone atualizado do repositório `takkaiama/rouletts`. Este procedimento evita `git push --force` e preserva o histórico.

```powershell
Expand-Archive -LiteralPath "$env:USERPROFILE\Downloads\roleta-analytics-web-v1.1.0.zip" -DestinationPath "$env:USERPROFILE\Downloads" -Force
cd "$env:USERPROFILE\Downloads"
git clone https://github.com/takkaiama/rouletts.git rouletts-publicacao
Copy-Item "$env:USERPROFILE\Downloads\roleta-analytics-web-v1.1.0\*" "$env:USERPROFILE\Downloads\rouletts-publicacao" -Recurse -Force
cd "$env:USERPROFILE\Downloads\rouletts-publicacao"
git add -A
git commit -m "Roleta Analytics Web v1.1.0 - historico circular e grade incremental"
git push origin main
```

Se a pasta `rouletts-publicacao` já existir, em vez de executar `git clone`, faça `cd` nela e rode `git pull --ff-only origin main` antes do `Copy-Item`.

O Netlify atualizará o front-end após o push se estiver conectado a `takkaiama/rouletts`. O Render também precisará estar conectado ao mesmo repositório e com deploy automático habilitado (ou acione um deploy manual). No Render, configure Root Directory `backend`, Build Command `npm install`, Start Command `npm start`. Não publique `.env` ou o código Python original com token antigo no GitHub.

## Executar localmente

```powershell
cd backend
Copy-Item .env.example .env
# Edite .env com a connection string Neon, chave e credenciais reais.
npm install
npm test
npm start
```

No navegador, abra `frontend/index.html` via um servidor estático (por exemplo `npx serve frontend` na pasta raiz), informe `http://localhost:3000` como servidor. Se necessário, inclua a origem do servidor estático em `FRONTEND_ORIGIN`, separada por vírgula. Evite abrir `file://`, pois a política de origem não funcionará como em um site normal.

## Regras de sinais / detalhes técnicos

- A análise é baseada nos padrões do script recebido; a escolha do alvo nos cards usa a categoria mais frequente **nos últimos cinco casos observados**. O original não possuía gerenciador de sinais independente para cada estratégia: ele gerava um único sinal de consenso de cor e validava apenas SG e G1. Este projeto estende a validação por estratégia/usuário, com G2, G3 etc. e armazenamento dos estados no Neon. As pausas par/ímpar específicas do script de console ainda **não foram implementadas** nesta versão web.
- Para padrões numéricos `n1..n4`, o alvo enviado é a **cor** mais frequente após a sequência, e não uma aposta em número seco. Para padrões de coluna, o alvo é a coluna; para padrões de cor, a cor. Para alvo vermelho/preto, `0` conta como GREEN de proteção; para coluna, `0` só é GREEN se a coluna-alvo for zero.
- O backend cria o sinal ao concluir o giro N e começa a validar a partir do giro N+1. `0` gales = SG apenas. Com limite 3: SG, G1, G2 e G3, cada um exclusivamente no giro seguinte. Se o usuário desligar o envio ou mudar configuração, sinais abertos e mensagens pendentes são cancelados. Mensagens já enviadas não podem ser desfeitas.
- A API usa a lista de até cinco resultados apenas para **detecção de mudanças e recuperação limitada após atrasos**. Não importa os cinco resultados antigos no início de uma sessão nova. É possível perder giros idênticos quando a janela inteira não muda e não existe ID oficial de rodada na API.
- Todas as contas **visualizam** os mesmos resultados, mas cada uma possui configurações/credenciais Telegram e acompanhamento de sinais separados. Edições de resultados administrativos afetam as estatísticas de todos.
- Os cards possuem arraste/recolhimento e redimensionamento no navegador. Para evitar que cards livres cubram permanentemente a grade, o botão `Restaurar cards` retorna todos à disposição original.
- O status `sent` no histórico confirma que o endpoint do Telegram aceitou o envio; não confirma que todos os participantes viram a mensagem. Uma falha de rede após o Telegram aceitar uma mensagem pode levar a tentativa duplicada, como em qualquer fila sem confirmação idempotente do destinatário.

## Situações que exigem atenção

- Se a API retorna 403, 429 ou muda o contrato, o monitor sinaliza a indisponibilidade. Não tente contornar bloqueios ou controles de acesso do serviço; verifique se seu uso da API está autorizado.
- Se houver mais de uma instância simultânea do backend, ambas podem coletar a mesma rodada. Esta versão foi desenhada para **uma instância Render**; escala horizontal exigirá liderança/distribuição de tarefas.
- Um usuário e um administrador têm acesso à mesma visualização de cards/grade; o administrador possui ações adicionais de gestão e edição autenticadas no backend.
- Para apagar dados históricos ou reiniciar a análise, faça isso pelo banco **com backup e auditoria**; não apague tabelas em produção indiscriminadamente.
