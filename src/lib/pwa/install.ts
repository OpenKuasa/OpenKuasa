/**
 * Installing OpenKuasa as an app from the website.
 *
 * Chrome and Edge fire `beforeinstallprompt` once, early, often before any install link is on screen,
 * so the event is kept here and the links read it through `subscribe`/`getInstallState`.
 * Safari (iPhone, iPad) has no prompt: people add it from the Share menu, so we show those steps.
 */

/** The `beforeinstallprompt` event: not in TypeScript's DOM types yet. */
export type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

/** What the install link shows: the browser's install prompt, the Safari steps, or nothing. */
export type InstallState = 'prompt' | 'ios-steps' | 'hidden';

/** iPhone, iPod or iPad, including iPads that report a Mac user agent. */
export function isAppleMobile(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

export function installStateFor(input: {
  standalone: boolean;
  hasPrompt: boolean;
  appleMobile: boolean;
}): InstallState {
  if (input.standalone) return 'hidden';
  if (input.hasPrompt) return 'prompt';
  if (input.appleMobile) return 'ios-steps';
  return 'hidden';
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
  return installStateFor({
    standalone: isStandalone(),
    hasPrompt: deferred !== null,
    appleMobile: isAppleMobile(navigator.userAgent, navigator.maxTouchPoints),
  });
}

export function getServerInstallState(): InstallState {
  return 'hidden';
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
