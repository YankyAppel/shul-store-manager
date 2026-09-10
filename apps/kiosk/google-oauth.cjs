// Google Cloud OAuth client ("Desktop app" type) used for "Sign in with
// Google" on the kiosk sign-in screen. Desktop clients cannot keep a secret,
// so Google does not treat this value as confidential; the app also uses PKCE.
// Empty values hide the Google sign-in option. The release workflow fills
// them in from the SUMA_GOOGLE_CLIENT_ID / SUMA_GOOGLE_CLIENT_SECRET secrets
// (apps/manager/scripts/set-google-oauth-client.mjs).
module.exports = {
  googleOAuthClient: {
    clientId: '',
    clientSecret: '',
  },
};
