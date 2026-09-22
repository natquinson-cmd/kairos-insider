// Interactive access is tied to a verified Firebase identity, never a client flag.
// Internal jobs get this identity only after their API key is verified by the router.
export const ADMIN_EMAILS = Object.freeze(['natquinson@gmail.com']);
export function isAdmin(user) {
  return !!user && user.emailVerified === true && typeof user.email === 'string'
    && ADMIN_EMAILS.includes(user.email.toLowerCase());
}
