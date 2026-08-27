# Vesion Store (clone) — leerproject

Werkende webshop-clone (front-end + Express-backend) met een echte checkout-flow via
[Stripe Checkout](https://stripe.com/docs/payments/checkout) in **test-mode**. Er wordt geen
echt geld afgeschreven en er is geen echt product achter — dit is puur om een volledige
order-flow (betaling → webhook → order opslaan → bevestigingsmail) end-to-end te zien werken.

## Setup

1. **Dependencies installeren**
   ```
   npm install
   ```

2. **Stripe test keys**
   Maak gratis een Stripe-account (of gebruik een bestaand account) en pak je **test**
   API-keys op https://dashboard.stripe.com/test/apikeys — verificatie van een echt
   bedrijf is niet nodig om test-mode te gebruiken.

   Kopieer `.env.example` naar `.env` en vul `STRIPE_SECRET_KEY` en
   `STRIPE_PUBLISHABLE_KEY` in (beide beginnen met `sk_test_...` / `pk_test_...`).

3. **Server starten**
   ```
   npm start
   ```
   De site draait op http://localhost:3000

4. **Webhook lokaal doorsturen**
   Stripe stuurt betalingsbevestigingen naar een webhook-endpoint. Lokaal test je dat met de
   [Stripe CLI](https://stripe.com/docs/stripe-cli):
   ```
   stripe login
   stripe listen --forward-to localhost:3000/api/webhook
   ```
   De CLI print een `whsec_...` signing secret — zet die in `.env` als `STRIPE_WEBHOOK_SECRET`
   en herstart de server.

5. **Testbetaling doen**
   Klik "شراء" (kopen) op de site → je komt op de Stripe-hosted checkoutpagina. Gebruik een
   [Stripe testkaart](https://stripe.com/docs/testing), bv.:
   - Kaartnummer: `4242 4242 4242 4242`
   - Vervaldatum: elke datum in de toekomst
   - CVC: elke 3 cijfers

   Na een geslaagde betaling:
   - komt de bestelling in `data/orders.json` te staan (via de webhook)
   - print de server in de console een preview-link van een bevestigingsmail
     (via [Ethereal](https://ethereal.email/) — een test-postbus, er wordt geen echte
     mail verstuurd)

## Structuur

```
server.js              Express-server, Stripe checkout + webhook
lib/orders.js          Orders opslaan/lezen (data/orders.json)
lib/mailer.js          Bevestigingsmail via Ethereal test-inbox
public/index.html      De winkel
public/success.html    Na geslaagde betaling
public/cancel.html     Bij geannuleerde betaling
public/css/style.css   Styling
public/js/main.js      FAQ-accordion, mobiel menu, checkout-call
```

## Van test naar echt

Dit project is bewust een leeromgeving: geen live Stripe-keys, geen echte productlevering.
Wil je dit ooit echt live zetten om een bestaand product te verkopen, dan komt daar meer bij
kijken dan keys omwisselen — o.a. een echte manier om het product te leveren na betaling,
bedrijfsgegevens bij Stripe, facturatie/btw, en een privacy-/retourbeleid.
