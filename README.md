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

Voor productie met het custom domain:

```text
https://overheid.amsterdamrp.store/api/overheid/auth/callback
```

## Modules

- Dienstkeuze voor Discord-login.
- Rolcontrole per dienst.
- Adminpagina voor dossiers, taken, sollicitaties, certificaten, kennistoetsen, handboeken, dienststatus en trainingen.
- Certificaten worden server-side opgeslagen en kunnen via `/overheid/verify.html` gecontroleerd worden.
- Extra handboeken en toetsen kunnen via de adminpagina toegevoegd worden.

## Supabase opslag

1. Open Supabase SQL Editor.
2. Voer `supabase-schema.sql` uit.
3. Zet op Render bij Environment:

```text
SUPABASE_URL=https://jouw-project.supabase.co
SUPABASE_SECRET_KEY=je_server_side_secret_key
SUPABASE_RECORDS_TABLE=portal_records
```

Zet de Supabase secret key nooit in `public/`, nooit in GitHub en nooit in browser-JavaScript.

Zonder Supabase gebruikt de server tijdelijk JSON-bestanden voor lokaal testen.
