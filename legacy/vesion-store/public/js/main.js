// FAQ accordion
document.querySelectorAll('.faq-item').forEach(item => {
  const question = item.querySelector('.faq-question');
  const answer = item.querySelector('.faq-answer');
  if (item.classList.contains('open')) {
    answer.style.maxHeight = answer.scrollHeight + 'px';
  }
  question.addEventListener('click', () => {
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item').forEach(i => {
      i.classList.remove('open');
      i.querySelector('.faq-answer').style.maxHeight = null;
    });
    if (!isOpen) {
      item.classList.add('open');
      answer.style.maxHeight = answer.scrollHeight + 'px';
    }
  });
});

// Mobile nav toggle
const navToggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');
if (navToggle && navLinks) {
  navToggle.addEventListener('click', () => {
    const isOpen = navLinks.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', String(isOpen));
  });
  navLinks.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      navLinks.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
    });
  });
}

// Checkout
const buyBtn = document.getElementById('buyBtn');
const checkoutError = document.getElementById('checkoutError');
if (buyBtn) {
  buyBtn.addEventListener('click', async () => {
    buyBtn.disabled = true;
    buyBtn.textContent = 'لحظات...';
    checkoutError.style.display = 'none';
    try {
      const res = await fetch('/api/create-checkout-session', { method: 'POST' });
      if (res.status === 503) {
        checkoutError.textContent = 'الدفع غير مفعّل حالياً. جرب لاحقاً.';
        throw new Error('stripe not configured');
      }
      if (!res.ok) throw new Error('checkout session failed');
      const data = await res.json();
      if (!data.url) throw new Error('no checkout url returned');
      window.location.href = data.url;
    } catch (err) {
      console.error(err);
      checkoutError.style.display = 'block';
      buyBtn.disabled = false;
      buyBtn.textContent = 'شراء';
    }
  });
}
