import { createContext } from "react";

// Shared auth state object. Created here (and only here) so the provider,
// the useAuth hook, and any future consumer all reference one context.
// This module exports no components, keeping fast-refresh lint clean.
export const AuthContext = createContext(null);
