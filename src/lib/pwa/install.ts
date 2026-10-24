/**
 * Installing OpenKuasa as an app from the website.
 *
 * Chrome and Edge fire `beforeinstallprompt` once, early, often before any install link is on screen,
 * so the event is kept here and the links read it through `subscribe`/`getInstallState`.
 * When there's no prompt (Safari, or Chrome holding it back) the button shows the menu steps for this browser.
 */

/** The `beforeinstallprompt` event: not in TypeScript's DOM types yet. */
export type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

/**
 * What the "Get the app" button does: open the browser's install prompt, or show the steps for this browser.
 * Hidden only inside the installed app.
 */
export type InstallState = 'prompt' | 'steps' | 'hidden';

/** Which browser's install steps to show when there is no install prompt. */
export type InstallGuide = 'chrome-desktop' | 'edge-desktop' | 'android' | 'ios' | 'mac-safari' | 'other';

/** iPhone, iPod or iPad, including iPads that report a Mac user agent. */
export function isAppleMobile(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

export function installGuideFor(userAgent: string, maxTouchPoints: number): InstallGuide {
  if (isAppleMobile(userAgent, maxTouchPoints)) return 'ios';
  if (/Android/.test(userAgent)) return 'android';
  if (/Firefox\//.test(userAgent)) return 'other';
  if (/Edg\//.test(userAgent)) return 'edge-desktop';
  if (/Chrome\//.test(userAgent)) return 'chrome-desktop';
  if (/Macintosh/.test(userAgent) && /Safari\//.test(userAgent)) return 'mac-safari';
  return 'other';
}

export function installStateFor(input: { standalone: boolean; hasPrompt: boolean }): InstallState {
  if (input.standalone) return 'hidden';
  return input.hasPrompt ? 'prompt' : 'steps';
}

let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

function isStandalone(): boolean {
  if (installed) return true;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

/** Starts listening for the browser's install events. Call once, as early as possible. */
export function captureInstallPrompt(): () => void {
  const onPrompt = (event: Event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    notify();
  };
  const onInstalled = () => {
    deferred = null;
    installed = true;
    notify();
  };
  window.addEventListener('beforeinstallprompt', onPrompt);
  window.addEventListener('appinstalled', onInstalled);
  return () => {
    window.removeEventListener('beforeinstallprompt', onPrompt);
    window.removeEventListener('appinstalled', onInstalled);
  };
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getInstallState(): InstallState {
  return installStateFor({ standalone: isStandalone(), hasPrompt: deferred !== null });
}

/** On the server the button renders as "steps", so the header doesn't shift; inside the installed app it then hides. */
export function getServerInstallState(): InstallState {
  return 'steps';
}

export function getInstallGuide(): InstallGuide {
  return installGuideFor(navigator.userAgent, navigator.maxTouchPoints);
}

/** Opens the browser's install prompt. The event can be used only once, so it's dropped afterwards. */
export async function promptInstall(): Promise<void> {
  const event = deferred;
  if (!event) return;
  deferred = null;
  notify();
  await event.prompt();
  await event.userChoice;
}
