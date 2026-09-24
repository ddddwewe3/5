const nodemailer = require('nodemailer');

let transporterPromise = null;

function getTransporter() {
  if (!transporterPromise) {
    transporterPromise = nodemailer.createTestAccount().then(account =>
      nodemailer.createTransport({
        host: account.smtp.host,
        port: account.smtp.port,
        secure: account.smtp.secure,
        auth: { user: account.user, pass: account.pass },
      })
    );
  }
  return transporterPromise;
}

async function sendConfirmationEmail(order) {
  const transporter = await getTransporter();
  const info = await transporter.sendMail({
    from: '"Vesion Store" <orders@vesion-store.test>',
    to: order.email,
    subject: 'تأكيد طلب Mini Chat - Pro',
    text: `شكراً لشرائك! رقم الطلب: ${order.sessionId}\nالمبلغ: $${(order.amountTotal / 100).toFixed(2)}`,
    html: `<div dir="rtl" style="font-family:sans-serif">
      <h2>شكراً لشرائك Mini Chat - Pro!</h2>
      <p>رقم الطلب: <b>${order.sessionId}</b></p>
      <p>المبلغ المدفوع: <b>$${(order.amountTotal / 100).toFixed(2)}</b></p>
      <p>هاد إيميل تجريبي (test mode) — ما بينبعث لصندوقك الحقيقي.</p>
    </div>`,
  });

  const previewUrl = nodemailer.getTestMessageUrl(info);
  console.log(`[mailer] confirmation email sent for order ${order.sessionId}`);
  console.log(`[mailer] preview: ${previewUrl}`);
  return previewUrl;
}

module.exports = { sendConfirmationEmail };
