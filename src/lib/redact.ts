// Lightweight PII redaction. Production-grade redaction needs a real model (Presidio, etc.),
// but for an MVP this catches the common, obvious leaks before logs hit the DB.

const PATTERNS: Array<{ name: string; re: RegExp; replace: string }> = [
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: "[REDACTED_EMAIL]" },
  // E.164-ish phone numbers
  { name: "phone", re: /\b\+?\d{1,3}[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/g, replace: "[REDACTED_PHONE]" },
  // 13–19 digit card numbers. Bounded separators to avoid catastrophic backtracking.
  { name: "card", re: /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,7}\b/g, replace: "[REDACTED_CARD]" },
  // US SSN
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g, replace: "[REDACTED_SSN]" },
  // Indian PAN
  { name: "pan", re: /\b[A-Z]{5}\d{4}[A-Z]\b/g, replace: "[REDACTED_PAN]" },
  // Indian Aadhaar (12 digits, often spaced)
  { name: "aadhaar", re: /\b\d{4}\s?\d{4}\s?\d{4}\b/g, replace: "[REDACTED_AADHAAR]" },
  // API-key-ish tokens
  { name: "secret", re: /\b(sk|pk|api|token|key|secret)[-_][A-Za-z0-9]{16,}\b/gi, replace: "[REDACTED_SECRET]" },
];

export function redactPII(text: string | null | undefined): string | null {
  if (!text) return null;
  let out = text;
  for (const p of PATTERNS) out = out.replace(p.re, p.replace);
  return out;
}

export function preview(text: string | null | undefined, max = 500): string | null {
  const redacted = redactPII(text);
  if (!redacted) return null;
  return redacted.length > max ? redacted.slice(0, max) + "…" : redacted;
}
