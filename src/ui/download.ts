/**
 * A file name that is safe on every OS: letters, digits, '.', '_' and '-' only, no leading dot, at most
 * 120 characters. Names include the bike's advertised name, which comes over the air (untrusted).
 */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-120);
  return cleaned || 'download.txt';
}

/** Downloads are the only way data leaves the app (docs/SPEC.md: stateless, no network). */
export function saveText(fileName: string, text: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFileName(fileName);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
