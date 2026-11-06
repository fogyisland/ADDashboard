export function nowUtcIso() {
  return new Date().toISOString();
}

export function toUtcIso(date) {
  return new Date(date).toISOString();
}
