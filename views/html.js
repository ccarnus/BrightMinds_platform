// HTML pages (email confirmation, password reset) and transactional emails. All share one layout.
const config = require('../config');
const { MEDIA_DIRS, mediaUrl } = require('../services/media');

const COLORS = { background: '#1c1c1c', text: '#f1f1f1', primary: '#00407A', error: '#cc0000' };

const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  );

const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap');
  body { margin: 0; padding: 0; font-family: 'Montserrat', sans-serif; background-color: ${COLORS.background}; color: ${COLORS.text}; }
  .container { max-width: 600px; margin: 50px auto; padding: 20px; border-radius: 8px; text-align: center; background-color: ${COLORS.background}; }
  .logo { margin-bottom: 20px; } .logo img { max-width: 230px; }
  h2 { color: ${COLORS.primary}; font-weight: 700; } h2.error { color: ${COLORS.error}; }
  p { font-size: 16px; line-height: 1.5; color: ${COLORS.text}; }
  .button { display: inline-block; margin: 20px 0; background-color: ${COLORS.primary}; color: ${COLORS.text}; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-size: 16px; font-weight: 700; border: none; cursor: pointer; }
  form { display: flex; flex-direction: column; align-items: center; margin-top: 20px; }
  label { margin: 10px 0 5px; font-size: 14px; text-align: left; width: 100%; max-width: 400px; }
  input { padding: 10px; width: 100%; max-width: 400px; border: 1px solid #ccc; border-radius: 5px; font-size: 16px; }
  .form-error { color: ${COLORS.error}; margin-top: 10px; font-size: 14px; }
  .footer { margin-top: 30px; } .footer img { max-width: 100px; } .footer p { font-size: 12px; }
`;

const logoUrl = () => mediaUrl(MEDIA_DIRS.emailAssets, 'BrightMinds_title.png');
const iconUrl = () => mediaUrl(MEDIA_DIRS.emailAssets, 'BrightMinds_icon.png');

/**
 * Renders a full HTML document. `paragraphs` are escaped; `bodyHtml` is trusted markup.
 * @param {{title: string, heading: string, paragraphs?: string[], error?: boolean,
 *          button?: {href: string, label: string}, bodyHtml?: string, head?: string}} options
 */
const renderLayout = ({
  title,
  heading,
  paragraphs = [],
  error = false,
  button,
  bodyHtml = '',
  head = '',
}) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - BrightMinds Research</title>
  <style>${STYLES}</style>
  ${head}
</head>
<body>
  <div class="container">
    <div class="logo"><img src="${logoUrl()}" alt="BrightMinds Research"></div>
    <h2${error ? ' class="error"' : ''}>${escapeHtml(heading)}</h2>
    ${paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join('\n    ')}
    ${bodyHtml}
    ${button ? `<a class="button" href="${escapeHtml(button.href)}">${escapeHtml(button.label)}</a>` : ''}
    <div class="footer">
      <img src="${iconUrl()}" alt="BrightMinds">
      <p>&copy; ${new Date().getFullYear()} BrightMinds Research LLC. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`;

const siteButton = () => ({ href: config.websiteUrl, label: 'Visit our Site' });

/** Simple message page (success or error). */
const messagePage = ({
  title,
  heading = title,
  paragraphs,
  error = false,
  button = siteButton(),
}) => renderLayout({ title, heading, paragraphs, error, button });

const resetPasswordFormPage = (token) =>
  renderLayout({
    title: 'Reset Your Password',
    heading: 'Reset Your Password',
    paragraphs: ['Please enter your new password below.'],
    head: `<script>
    function validateForm(event) {
      var password = document.getElementById('password').value;
      var confirmPassword = document.getElementById('confirmPassword').value;
      var errorMessage = document.getElementById('error-message');
      if (password !== confirmPassword) { event.preventDefault(); errorMessage.textContent = 'Passwords do not match.'; return false; }
      if (password.length < 4) { event.preventDefault(); errorMessage.textContent = 'Password must be at least 4 characters long.'; return false; }
      return true;
    }
  </script>`,
    bodyHtml: `<form action="/user/reset-password/${encodeURIComponent(token)}" method="POST" onsubmit="validateForm(event)">
      <label for="password">New Password:</label>
      <input type="password" id="password" name="password" required />
      <label for="confirmPassword">Confirm New Password:</label>
      <input type="password" id="confirmPassword" name="confirmPassword" required />
      <div id="error-message" class="form-error"></div>
      <button class="button" type="submit">Reset Password</button>
    </form>`,
  });

const verificationEmail = (token) =>
  renderLayout({
    title: 'Email Confirmation',
    heading: 'Welcome!',
    paragraphs: [
      'Thank you for signing up with us. To complete your registration, please confirm your email address by clicking the button below.',
    ],
    button: { href: `${config.publicUrl}/user/confirmation/${token}`, label: 'Verify Email' },
    bodyHtml: '<p>If you did not create an account with us, please ignore this email.</p>',
  });

const passwordResetEmail = ({ username, token }) =>
  renderLayout({
    title: 'Password Reset',
    heading: 'Password Reset',
    paragraphs: [
      `Hello ${username},`,
      'You requested a password reset for your BrightMinds Research account.',
      'Please click the button below to set a new password (valid for 1 hour).',
      'If you did not request this, please ignore this email.',
    ],
    button: {
      href: `${config.publicUrl}/user/reset-password/${token}`,
      label: 'Reset Your Password',
    },
  });

module.exports = {
  escapeHtml,
  messagePage,
  resetPasswordFormPage,
  verificationEmail,
  passwordResetEmail,
};
