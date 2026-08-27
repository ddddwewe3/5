# Online zetten (zonder eigen domein)

Je krijgt een gratis adres van de host zelf, bijv. `https://vesion-store.onrender.com`.
Een eigen domein is **niet** nodig.

De code is al klaargezet voor deployment:
- `data/`-map wordt automatisch aangemaakt (crashte anders bij de eerste bestelling)
- `BASE_URL` wordt automatisch afgeleid van het adres dat de host geeft
- `package.json` heeft een `engines`-veld en een `start`-script
- **Werkt zonder Stripe-key**: zonder `STRIPE_SECRET_KEY` draait de site in
  "storefront-only" modus — de winkel is zichtbaar, alleen de koop-knop is uit.
  Voeg de key later toe (env var bij je host) en de checkout gaat aan, geen
  code-wijziging nodig.

---

## Wat je zelf nodig hebt (eenmalig, gratis)

### 1. Stripe test-keys
1. Maak een gratis account op https://dashboard.stripe.com/register
   (geen bedrijfsverificatie nodig voor test-mode).
2. Zorg dat linksboven **"Test mode"** aan staat.
3. Ga naar https://dashboard.stripe.com/test/apikeys
4. Kopieer de **Secret key** (`sk_test_...`). De publishable key heb je hier niet nodig —
   de checkout draait volledig server-side.

### 2. Een hosting-account
Zie "Route kiezen" hieronder.

---

## Route kiezen

| | Render | Railway |
|---|---|---|
| Kosten | **Gratis** | ~$5/mnd (trial met gratis tegoed) |
| GitHub nodig? | Ja (of GitLab) | Nee — deployt vanuit deze map |
| Gratis adres | `*.onrender.com` | `*.up.railway.app` |
| Slaapt bij inactiviteit | Ja (~1 min opstarttijd) | Nee |

---

## Route A — Render (gratis, via GitHub/GitLab)

1. Ik zet de code in een git-repo en push die naar GitHub of GitLab (jij maakt het
   account, of ik doe alles met een token dat je aanmaakt).
2. Ga naar https://render.com → **New** → **Web Service** → kies je repo.
3. Render leest `render.yaml` en vult build/start automatisch in.
4. Bij **Environment** zet je:
   - `STRIPE_SECRET_KEY` = je `sk_test_...`
5. **Create Web Service**. Na ~2 min staat de site live op `https://<naam>.onrender.com`.
6. Ga verder bij **"Webhook koppelen"** hieronder.

## Route B — Railway (geen GitHub, kleine maandkost)

1. Account: https://railway.com → sign up.
2. Installeer de CLI en deploy vanuit deze map:
   ```
   npm i -g @railway/cli
   railway login
   railway init
   railway up
   ```
3. In het Railway-dashboard: **Settings → Networking → Generate Domain** →
   je krijgt `https://<naam>.up.railway.app`.
4. **Variables**: zet `STRIPE_SECRET_KEY` = je `sk_test_...`
5. Ga verder bij **"Webhook koppelen"** hieronder.

---

## Webhook koppelen (voor beide routes)

De webhook zorgt dat een geslaagde betaling → bestelling opgeslagen → mail verstuurd.
Online gebruik je géén `stripe listen`, maar een echte webhook in het dashboard:

1. https://dashboard.stripe.com/test/webhooks → **Add endpoint**
2. Endpoint URL: `https://JOUW-ADRES/api/webhook`
3. Event: selecteer **`checkout.session.completed`**
4. **Add endpoint** → klik de nieuwe endpoint open → **Signing secret** → **Reveal**
   → kopieer de `whsec_...`
5. Zet bij je host een extra variabele:
   - `STRIPE_WEBHOOK_SECRET` = `whsec_...`
6. De host herstart automatisch (of trigger zelf een redeploy).

---

## Testen

1. Open `https://JOUW-ADRES` en klik **شراء** (kopen).
2. Je komt op de Stripe-checkoutpagina. Gebruik testkaart:
   - Nummer: `4242 4242 4242 4242`
   - Vervaldatum: elke datum in de toekomst · CVC: 3 cijfers
3. Na betaling kom je terug op `/success.html`.
4. Check `https://JOUW-ADRES/api/orders` — de bestelling staat erin
   (kan ~1 min duren als de gratis Render-service net "sliep").

## Let op

- **Bevestigingsmail**: gaat via Ethereal (test-postbus). Er wordt geen echte mail
  verstuurd; de preview-link staat in de server-logs van je host.
- **Bestellingen niet permanent**: `data/orders.json` staat op de schijf van de host
  en verdwijnt bij een nieuwe deploy of herstart. Prima voor een leerproject; voor
  "echt" heb je een database nodig.
- **Test-mode**: er wordt nooit echt geld afgeschreven. De code weigert `sk_live_`-keys.
