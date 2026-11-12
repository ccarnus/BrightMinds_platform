// Web pages opened from the emailed links (email confirmation, password reset). They are shown in a
// phone browser, so the layout is a single responsive card in the app's colors.
const config = require('../config');
const { MIN_PASSWORD_LENGTH, MAX_PASSWORD_BYTES } = require('../services/credentials');
const { MEDIA_DIRS, mediaUrl } = require('../services/media');
const { escapeHtml } = require('./escape');

const COLORS = {
  brand: '#00407A',
  action: '#2E8B57',
  page: '#F2F5F9',
  text: '#1F2937',
  muted: '#6B7280',
  border: '#D1D5DB',
  error: '#B3261E',
  errorSoft: '#FDECEA',
  success: '#1B7F4B',
  successSoft: '#E6F4EC',
};

const STYLES = `
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px;
    font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: ${COLORS.page}; color: ${COLORS.text}; }
  .card { width: 100%; max-width: 440px; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08); }
  .header { background: ${COLORS.brand}; padding: 24px; text-align: center; }
  .header img { max-width: 180px; height: auto; display: block; margin: 0 auto; color: #fff; font-weight: 700; font-size: 20px; }
  .content { padding: 28px 24px; text-align: center; }
  .badge { width: 56px; height: 56px; border-radius: 50%; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center; font-size: 28px; font-weight: 700;
    background: ${COLORS.successSoft}; color: ${COLORS.success}; }
  .badge.error { background: ${COLORS.errorSoft}; color: ${COLORS.error}; }
  h1 { margin: 0 0 12px; font-size: 22px; line-height: 28px; color: ${COLORS.brand}; }
  h1.error { color: ${COLORS.error}; }
  p { margin: 0 0 12px; font-size: 16px; line-height: 24px; }
  .button { display: block; width: 100%; margin-top: 20px; padding: 14px 24px; border: 0; border-radius: 10px; background: ${COLORS.action}; color: #fff;
    font-size: 16px; font-weight: 700; text-align: center; text-decoration: none; cursor: pointer; }
  .button.secondary { background: transparent; color: ${COLORS.brand}; border: 1px solid ${COLORS.border}; }
  form { text-align: left; margin-top: 16px; }
  label { display: block; margin: 14px 0 6px; font-size: 14px; font-weight: 600; }
  .field { position: relative; }
  input { width: 100%; padding: 12px 64px 12px 12px; border: 1px solid ${COLORS.border}; border-radius: 10px; font-size: 16px; color: ${COLORS.text}; }
  input:focus { outline: 2px solid ${COLORS.brand}; outline-offset: 0; border-color: ${COLORS.brand}; }
  .toggle { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); border: 0; background: transparent; color: ${COLORS.brand}; font-size: 14px; font-weight: 600; padding: 8px; cursor: pointer; }
  .hint { margin: 6px 0 0; font-size: 13px; line-height: 18px; color: ${COLORS.muted}; }
  .form-error { margin: 14px 0 0; padding: 10px 12px; border-radius: 10px; background: ${COLORS.errorSoft}; color: ${COLORS.error}; font-size: 14px; line-height: 20px; }
  .footer { padding: 0 24px 20px; text-align: center; font-size: 12px; color: ${COLORS.muted}; }
`;

const logoUrl = () => mediaUrl(MEDIA_DIRS.emailAssets, 'BrightMinds_title.png');

/**
 * Renders a full HTML document. `paragraphs` are escaped; `bodyHtml` is trusted markup.
 * @param {{title: string, heading?: string, paragraphs?: string[], error?: boolean, icon?: string,
 *          button?: {href: string, label: string, secondary?: boolean}, bodyHtml?: string,
 *          script?: string}} options
 */
const renderLayout = ({
  title,
  heading = title,
  paragraphs = [],
  error = false,
  icon,
  button,
  bodyHtml = '',
  script = '',
}) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(title)} - BrightMinds Research</title>
  <style>${STYLES}</style>
</head>
<body>
  <main class="card">
    <div class="header"><img src="${escapeHtml(logoUrl())}" alt="BrightMinds Research"></div>
    <div class="content">
      ${icon ? `<div class="badge${error ? ' error' : ''}" aria-hidden="true">${escapeHtml(icon)}</div>` : ''}
      <h1${error ? ' class="error"' : ''}>${escapeHtml(heading)}</h1>
      ${paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join('\n      ')}
      ${bodyHtml}
      ${button ? `<a class="button${button.secondary ? ' secondary' : ''}" href="${escapeHtml(button.href)}">${escapeHtml(button.label)}</a>` : ''}
    </div>
    <div class="footer">&copy; ${new Date().getFullYear()} BrightMinds Research LLC</div>
  </main>
  ${script ? `<script>${script}</script>` : ''}
</body>
</html>`;

const siteButton = () => ({
  href: config.websiteUrl,
  label: 'Visit our website',
  secondary: true,
});

/** Simple message page (success or error). */
const messagePage = ({
  title,
  heading = title,
  paragraphs,
  error = false,
  icon = error ? '!' : '\u2713',
  button = siteButton(),
}) => renderLayout({ title, heading, paragraphs, error, icon, button });

const FORM_SCRIPT = `
  var form = document.getElementById('reset-form');
  var password = document.getElementById('password');
  var confirm = document.getElementById('confirmPassword');
  var box = document.getElementById('client-error');
  function show(message) { box.textContent = message; box.style.display = message ? 'block' : 'none'; }
  form.addEventListener('submit', function (event) {
    if (password.value !== confirm.value) { event.preventDefault(); show('The two passwords do not match.'); }
    else if (password.value.length < ${MIN_PASSWORD_LENGTH}) { event.preventDefault(); show('Your password must be at least ${MIN_PASSWORD_LENGTH} characters long.'); }
  });
  Array.prototype.forEach.call(document.querySelectorAll('.toggle'), function (button) {
    button.addEventListener('click', function () {
      var input = document.getElementById(button.getAttribute('data-for'));
      var hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      button.textContent = hidden ? 'Hide' : 'Show';
    });
  });
`;

/** The "choose a new password" form; `error` re-displays the reason a submission was refused. */
const resetPasswordFormPage = (token, error = '') =>
  renderLayout({
    title: 'Reset your password',
    paragraphs: ['Choose a new password for your BrightMinds account.'],
    script: FORM_SCRIPT,
    bodyHtml: `<form id="reset-form" action="/user/reset-password/${encodeURIComponent(token)}" method="POST" novalidate>
      <label for="password">New password</label>
      <div class="field">
        <input type="password" id="password" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" maxlength="${MAX_PASSWORD_BYTES}" required autofocus>
        <button type="button" class="toggle" data-for="password">Show</button>
      </div>
      <p class="hint">At least ${MIN_PASSWORD_LENGTH} characters.</p>
      <label for="confirmPassword">Confirm new password</label>
      <div class="field">
        <input type="password" id="confirmPassword" name="confirmPassword" autocomplete="new-password" maxlength="${MAX_PASSWORD_BYTES}" required>
        <button type="button" class="toggle" data-for="confirmPassword">Show</button>
      </div>
      <div id="client-error" class="form-error" role="alert" style="display:${error ? 'block' : 'none'}">${escapeHtml(error)}</div>
      <button class="button" type="submit">Save new password</button>
    </form>`,
  });

module.exports = { escapeHtml, messagePage, resetPasswordFormPage };
