# Biotec BDT Online

Sistema online para preenchimento e armazenamento do BDT - Boletim Diário de Trabalho / Baldeio.

## Recursos
- Login e senha com perfis `admin` e `user`.
- Primeiro acesso cria o administrador.
- Formulário BDT baseado no modelo operacional da Biotec.
- Pesquisa de BT e preenchimento automático da descrição do maquinário.
- Controle de viagens e paradas/intervenções.
- Histórico de BDTs.
- Administração de usuários e cadastro de BTs.
- PostgreSQL/Neon via `DATABASE_URL`.

## Render
Root Directory: `backend`
Build Command: `npm install`
Start Command: `npm start`

Variáveis:
- `DATABASE_URL` (obrigatória)
- `SESSION_SECRET` (recomendada)
- `NODE_ENV=production`

No primeiro acesso, o sistema solicita a criação do usuário administrador.
