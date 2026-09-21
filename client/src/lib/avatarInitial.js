// Single source of truth for the avatar fallback initial.
// Prefers the user's name; falls back to the first character of the email
// (uppercased) so Google-only or nameless accounts still get a clean,
// predictable letter instead of a placeholder symbol.
export function avatarInitialFor(user) {
    const name = user?.name?.trim();
    if (name) return name.charAt(0).toUpperCase();
    const email = user?.email?.trim();
    if (email) return email.charAt(0).toUpperCase();
    return "?";
}
