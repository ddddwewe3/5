require('dotenv').config();
const express = require('express');
const path = require('path');
const Stripe = require('stripe');
const { saveOrder, readOrders } = require('./lib/orders');
const { sendConfirmationEmail } = require('./lib/mailer');

// A live key is always a hard stop — this is a learning project, never for real payments.
if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
  console.error('STRIPE_SECRET_KEY must be a TEST key (starts with sk_test_). This is a learning project, not for live payments.');
  process.exit(1);
}

// Without a key the site still serves (storefront visible); only the checkout is disabled.
// Add STRIPE_SECRET_KEY later to switch the buy flow on — no code change needed.
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (!stripe) {
  console.warn('No STRIPE_SECRET_KEY set — running in storefront-only mode (checkout disabled).');
}
const app = express();
const PORT = process.env.PORT || 3000;
// BASE_URL is used to build Stripe's success/cancel links. Set it explicitly in
// production; otherwise fall back to the host's own public URL (Render/Railway
// provide these) or localhost for local dev.
const BASE_URL = (
  process.env.BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`) ||
  `http://localhost:${PORT}`
).replace(/\/$/, '');

const PRODUCT = {
  name: 'Mini Chat - Pro',
  description: 'دفعة واحدة، تحديثات مدى الحياة',
  unitAmount: 1999, // $19.99 in cents
  currency: 'usd',
};

// Stripe webhook needs the raw body, so it's registered before express.json()
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'stripe_not_configured' });
  }
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const order = {
      sessionId: session.id,
      email: session.customer_details?.email || null,
      amountTotal: session.amount_total,
      currency: session.currency,
      createdAt: new Date().toISOString(),
    };
    saveOrder(order);
    console.log(`[order] saved order ${order.sessionId} for ${order.email}`);
    if (order.email) {
      sendConfirmationEmail(order).catch(err => console.error('[mailer] failed:', err.message));
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/create-checkout-session', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'stripe_not_configured' });
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: PRODUCT.currency,
            product_data: {
              name: PRODUCT.name,
              description: PRODUCT.description,
            },
            unit_amount: PRODUCT.unitAmount,
          },
          quantity: 1,
        },
      ],
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/cancel.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Failed to create checkout session:', err.message);
    res.status(500).json({ error: 'checkout_failed' });
  }
});

// Simple local-only endpoint to see stored orders while learning/testing
app.get('/api/orders', (req, res) => {
  res.json(readOrders());
});

app.listen(PORT, () => {
  const mode = stripe ? 'Stripe test mode' : 'storefront-only, checkout disabled';
  console.log(`Vesion Store draait op ${BASE_URL} (${mode})`);
});
