// login.js — KAHE 360 Internal Operations
// Localization now comes from the shared engine (i18n.js) + dictionaries
// (translations/id.js, translations/en.js) — no inline dictionary here.
(function () {
  const t = window.KaheI18n.t;

  // Apply the current/default language immediately, then wire the toggle.
  window.KaheI18n.apply(document);
  window.KaheI18n.initToggle(() => {
    // Login page has no JS-generated content beyond the DOM already
    // covered by [data-i18n]/[data-i18n-placeholder], so no extra
    // re-render is needed on language change.
  });

  function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toast.hidden = true;
    }, 3200);
  }

  // Show/hide password
  const passwordInput = document.getElementById('password');
  const toggleBtn = document.getElementById('togglePassword');
  toggleBtn.addEventListener('click', () => {
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    toggleBtn.textContent = isPassword ? '🙈' : '👁';
    toggleBtn.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
  });

  // Google placeholder (visual prototype only)
  document.getElementById('googleBtn').addEventListener('click', () => {
    showToast(t('google_toast'));
  });

  // Forgot password placeholder
  document.getElementById('forgotPassword').addEventListener('click', (e) => {
    e.preventDefault();
    showToast(t('forgot_toast'));
  });

  // Real login flow against server-side session auth
  const form = document.getElementById('loginForm');
  const errorEl = document.getElementById('loginError');
  const submitBtn = document.getElementById('submitBtn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    submitBtn.disabled = true;

    const email = document.getElementById('email').value.trim();
    const password = passwordInput.value;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();

      if (res.ok && data.ok) {
        window.location.href = '/index.html';
        return;
      }

      if (res.status === 429) {
        errorEl.textContent = t('err_rate_limited');
      } else if (res.status === 401 || res.status === 400) {
        errorEl.textContent = t('err_invalid');
      } else {
        errorEl.textContent = t('err_generic');
      }
      errorEl.hidden = false;
    } catch (err) {
      errorEl.textContent = t('err_generic');
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
