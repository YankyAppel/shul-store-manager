// Writes the Google OAuth client from the environment into google-oauth.cjs
// so packaged builds can offer "Sign in with Google". No-op when unset.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const clientId = process.env.SUMA_GOOGLE_CLIENT_ID ?? '';
const clientSecret = process.env.SUMA_GOOGLE_CLIENT_SECRET ?? '';
if (!clientId) {
  console.log('SUMA_GOOGLE_CLIENT_ID not set; Google sign-in stays disabled.');
  process.exit(0);
}
if (!/^[\w.-]+$/.test(clientId) || !/^[\w-]*$/.test(clientSecret)) {
  console.error('Unexpected characters in the Google OAuth client values.');
  process.exit(1);
}
const target = fileURLToPath(new URL('../google-oauth.cjs', import.meta.url));
writeFileSync(
  target,
  `module.exports = {\n  googleOAuthClient: {\n    clientId: '${clientId}',\n    clientSecret: '${clientSecret}',\n  },\n};\n`,
);
console.log('Google OAuth client written to google-oauth.cjs');
