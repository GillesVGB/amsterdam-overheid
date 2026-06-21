# Bot certificaten verifieerbaar maken

De overheidsite heeft een beveiligde endpoint voor Discord bots:

```text
POST https://overheid.amsterdamrp.store/api/overheid/certificates/bot-issue
```

Gebruik dezelfde waarde voor `BOT_CERTIFICATE_API_KEY` in Render bij de overheidsite en in de environment van je Discord bot. Zet deze key niet in GitHub.

## Environment voor bot

```text
OVERHEID_PORTAL_URL=https://overheid.amsterdamrp.store
BOT_CERTIFICATE_API_KEY=een_lange_random_secret
```

## Toevoegen bovenaan bot.js

```js
const OVERHEID_PORTAL_URL = process.env.OVERHEID_PORTAL_URL || "https://overheid.amsterdamrp.store";
const BOT_CERTIFICATE_API_KEY = process.env.BOT_CERTIFICATE_API_KEY || "";
```

## Helper toevoegen in bot.js

```js
async function maakWebsiteCertificaat(user, trainingNaam, score, slagingsgrens = 90) {
  if (!BOT_CERTIFICATE_API_KEY) {
    console.warn("BOT_CERTIFICATE_API_KEY ontbreekt; certificaat wordt niet op website opgeslagen.");
    return null;
  }

  const response = await fetch(`${OVERHEID_PORTAL_URL}/api/overheid/certificates/bot-issue`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${BOT_CERTIFICATE_API_KEY}`,
    },
    body: JSON.stringify({
      service: "Politie",
      holderName: user.globalName || user.username,
      discordId: user.id,
      trainingName: trainingNaam,
      score,
      maxScore: 100,
      passPercent: slagingsgrens,
      issuedBy: "Amsterdam Overheid Bot",
    }),
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.message || "Website certificaat kon niet worden opgeslagen.");
  }

  return data;
}
```

## In `stuurCertificaatNaarDM` aanpassen

Vervang:

```js
const certNummer = `AMS-${Date.now().toString().slice(-8)}-${user.id.slice(-4)}`;
```

door:

```js
let websiteCertificaat = null;
try {
  websiteCertificaat = await maakWebsiteCertificaat(user, trainingNaam, score, TRAININGEN[trainingNaam]?.slagingsgrens || 90);
} catch (error) {
  console.error("Kon certificaat niet op website opslaan:", error.message);
}

const certNummer = websiteCertificaat?.certificate?.code || `AMS-${Date.now().toString().slice(-8)}-${user.id.slice(-4)}`;
const verifyUrl = websiteCertificaat?.verifyUrl || `${OVERHEID_PORTAL_URL}/overheid/verify.html?code=${encodeURIComponent(certNummer)}`;
```

Voeg in de embedvelden ook dit veld toe:

```js
{ name: "Verificatie", value: `[Controleer certificaat](${verifyUrl})`, inline: false },
```

Vanaf dan zijn bot-certificaten verifieerbaar via:

```text
https://overheid.amsterdamrp.store/overheid/verify.html
```
