# Amsterdam Roleplay Overheid Portaal

Lokale test:

1. Zet in Discord Developer Portal deze Redirect URI:
   `http://127.0.0.1:3000/api/overheid/auth/callback`
2. Start lokaal vanuit de projectmap:
   `node server.js`
3. Open:
   `http://127.0.0.1:3000/overheid/`

De server leest `.env.local` en checkt Discord-rollen per dienst. Zonder juiste rol wordt de dienstpagina niet geopend.
