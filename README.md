# Amsterdam Roleplay Overheid Portaal

Losstaande versie van het overheid portaal.

## Lokaal starten

1. Kopieer `.env.example` naar `.env.local`.
2. Vul de Discord OAuth en role ID's in.
3. Start met:

```bash
npm start
```

Open daarna `http://127.0.0.1:3000/overheid/`.

Discord redirect URI voor lokaal testen:

```text
http://127.0.0.1:3000/api/overheid/auth/callback
```
