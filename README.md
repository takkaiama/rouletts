# Biotec BDT Online/Offline v1.5.0

- PWA online/offline no padrão operacional.
- Primeiro login no dispositivo exige internet; depois a sessão local permite abrir o formulário offline.
- BTs, fazendas e operadores ficam disponíveis offline após sincronização.
- BDTs sem internet são salvos em IndexedDB como PENDENTE.
- Sincronização automática ao voltar a conexão e também a cada 30 segundos.
- Identificador `client_uuid` evita duplicidade em reenvios.
- Registros pendentes aparecem no histórico com o estado da sincronização.
- Administração de usuários, BTs e fazendas continua online.

Para publicar no repositório conectado ao Render, execute `PUBLICAR.ps1`.
