# Biotec BDT Online v1.2.0

Formulário online do Boletim Diário de Trabalho - Baldeio.

## v1.2.0
- cálculos automáticos reforçados no navegador e recalculados no servidor;
- horas de horímetro = final - inicial;
- tempo de ciclo e tempo de parada automáticos;
- resumo da operação automático;
- BT pesquisado também no histórico de BDTs;
- fazendas e operadores sugeridos a partir do histórico;
- matrícula recuperada ao selecionar operador conhecido;
- correção de cache para o Render/Chrome não manter JavaScript antigo.

## Render
Root Directory: `backend`
Build Command: `npm install`
Start Command: `npm start`

Variáveis necessárias: `DATABASE_URL`, `SESSION_SECRET`, `NODE_ENV=production`.
