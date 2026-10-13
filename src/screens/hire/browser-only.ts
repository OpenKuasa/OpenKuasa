// src/screens/hire/browser-only.ts
/**
 * The two things the interview screens ask of the browser itself. BROWSER-ONLY:
 * these are the only places in the interview code that touch
 * `navigator.clipboard`, `Blob`, `URL.createObjectURL` and a temporary
 * `<a download>`. Call them from an event handler, never while drawing. The
 * tests stand in for the browser; what a real one does (the text really on the
 * clipboard, the file really saved under its name, no Content-Security-Policy
 * violation) is covered by the browser smoke.
 */

/**
 * Puts text on the clipboard. True when the browser took it; false when it
 * refused or has no clipboard (a page not served securely, a permission
 * denied). Never throws. Must be called straight from a press: some browsers
 * allow the clipboard only then.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Saves text as a file through the browser's own download: a blob, and a link
 * to it that is clicked and removed. Nothing is uploaded, fetched or stored;
 * the blob is let go of a minute later, after the browser has had time to
 * start the download.
 */
export function downloadTextFile(name: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
