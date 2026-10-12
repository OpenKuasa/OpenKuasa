import 'server-only';
import { clientKey, requestClientAddress } from './client-address';
import { consumeRateLimits, retryMinutes, type RateLimitCheck } from './rate-limit';

/**
 * Every limit the app keeps on attempts, in one place, and the one-line
 * questions the actions ask of them. Each question counts the attempt it is
 * asked about: ask once, before the thing being limited.
 *
 * "Per client" means per address as `client-address.ts` derives it. A request
 * with no address is not waved through: it is counted under one shared name,
 * against `unknownLimit` (ten times the per-client number, since it is every
 * such request together).
 *
 * The numbers are sized so that people sharing one address (an office, a
 * campus) doing ordinary things do not meet them: a sign-in is rare once a
 * session is remembered, and forty in a quarter of an hour is a whole small
 * office arriving at once with typos to spare.
 */
type Rule = {
  bucket: string;
  limit: number;
  /** The limit when the client has no address and everyone unknown shares one count. */
  unknownLimit?: number;
  windowSeconds: number;
};

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Sign-in attempts (right or wrong) from one client, whatever the email. */
export const SIGN_IN_PER_CLIENT: Rule = { bucket: 'signin_client', limit: 40, unknownLimit: 400, windowSeconds: 15 * MINUTE };
/** Sign-in attempts from one client for one email. */
export const SIGN_IN_PER_EMAIL_AND_CLIENT: Rule = { bucket: 'signin_email_client', limit: 10, windowSeconds: 15 * MINUTE };
/** Current-password checks for one signed-in account (changing a password). */
export const PASSWORD_CHECK_PER_ACCOUNT: Rule = { bucket: 'password_check_account', limit: 10, windowSeconds: 15 * MINUTE };
/** Reset emails asked for by one client. */
export const PASSWORD_RESET_PER_CLIENT: Rule = { bucket: 'reset_client', limit: 10, unknownLimit: 100, windowSeconds: HOUR };
/** Reset emails asked for one address, by anyone. */
export const PASSWORD_RESET_PER_EMAIL: Rule = { bucket: 'reset_email', limit: 5, windowSeconds: HOUR };
/** Sign-ups from one client. */
export const SIGN_UP_PER_CLIENT: Rule = { bucket: 'signup_client', limit: 10, unknownLimit: 100, windowSeconds: HOUR };
/** Sign-ups for one address, by anyone (each can send a confirmation email). */
export const SIGN_UP_PER_EMAIL: Rule = { bucket: 'signup_email', limit: 5, windowSeconds: HOUR };
/** Demo sessions started by one client (each makes a guest account). */
export const DEMO_PER_CLIENT: Rule = { bucket: 'demo_client', limit: 20, unknownLimit: 200, windowSeconds: HOUR };

/** Lead-form responses from one client, across every form. */
export const FORM_SUBMIT_PER_CLIENT: Rule = { bucket: 'form_submit_client', limit: 20, unknownLimit: 200, windowSeconds: 10 * MINUTE };
/** Job applications from one client, across every job. */
export const APPLY_PER_CLIENT: Rule = { bucket: 'apply_client', limit: 20, unknownLimit: 200, windowSeconds: HOUR };
/** Applications that carry a CV file from one client: a workspace takes 50 files a day in all. */
export const APPLY_CV_PER_CLIENT: Rule = { bucket: 'apply_cv_client', limit: 10, unknownLimit: 100, windowSeconds: DAY };
/** Counted views of one form by one client: one per window. */
export const FORM_VIEW_PER_CLIENT_AND_FORM: Rule = { bucket: 'form_view_client_form', limit: 1, unknownLimit: 60, windowSeconds: 10 * MINUTE };

/** What a person is told once a limit on signing in, signing up or resetting is used up. */
export const tooManyAttempts = (retryAfterSeconds: number) => {
  const minutes = retryMinutes(retryAfterSeconds);
  return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
};

/** What a visitor is told once their network has sent too many responses or applications. */
export const tooManyFromNetwork = (retryAfterSeconds: number) => {
  const minutes = retryMinutes(retryAfterSeconds);
  return `Too many attempts from your network. Please try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
};

/** Emails are counted as one address however they are typed. */
const normalEmail = (email: string) => email.trim().toLowerCase();

type Client = ReturnType<typeof clientKey>;

/** A rule counted against the client, optionally together with something else (an email, a form). */
const perClient = (rule: Rule, client: Client, withValue?: string): RateLimitCheck => ({
  bucket: rule.bucket,
  value: withValue === undefined ? client.key : `${withValue}|${client.key}`,
  limit: client.known ? rule.limit : (rule.unknownLimit ?? rule.limit),
  windowSeconds: rule.windowSeconds,
});

/** A rule counted against a value alone, whoever the client is. */
const perValue = (rule: Rule, value: string): RateLimitCheck => ({
  bucket: rule.bucket, value, limit: rule.limit, windowSeconds: rule.windowSeconds,
});

/** Counts the attempt against the checks; the seconds to wait when one is used up, else null. */
async function waitFor(build: (client: Client) => RateLimitCheck[]): Promise<number | null> {
  const client = clientKey(await requestClientAddress());
  const verdict = await consumeRateLimits(build(client));
  return verdict.allowed ? null : verdict.retryAfterSeconds;
}

const asAttempts = (seconds: number | null) => (seconds === null ? null : tooManyAttempts(seconds));
const fromNetwork = (seconds: number | null) => (seconds === null ? null : tooManyFromNetwork(seconds));

/**
 * The questions below answer null when the attempt may go ahead, and otherwise
 * the message to show instead of making it. They are asked before the account
 * is looked at, so the answer is the same whether or not the email has one.
 */

/** Before a password is tried for `email`. */
export async function signInLimited(email: string): Promise<string | null> {
  return asAttempts(await waitFor((client) => [
    perClient(SIGN_IN_PER_CLIENT, client),
    perClient(SIGN_IN_PER_EMAIL_AND_CLIENT, client, normalEmail(email)),
  ]));
}

/** Before a signed-in person's current password is checked again. */
export async function passwordCheckLimited(userId: string): Promise<string | null> {
  return asAttempts(await waitFor(() => [perValue(PASSWORD_CHECK_PER_ACCOUNT, userId)]));
}

/** Before a reset email is asked for. */
export async function passwordResetLimited(email: string): Promise<string | null> {
  return asAttempts(await waitFor((client) => [
    perClient(PASSWORD_RESET_PER_CLIENT, client),
    perValue(PASSWORD_RESET_PER_EMAIL, normalEmail(email)),
  ]));
}

/** Before an account is made for `email`. */
export async function signUpLimited(email: string): Promise<string | null> {
  return asAttempts(await waitFor((client) => [
    perClient(SIGN_UP_PER_CLIENT, client),
    perValue(SIGN_UP_PER_EMAIL, normalEmail(email)),
  ]));
}

/** Before a demo guest is made. */
export async function demoLimited(): Promise<string | null> {
  return asAttempts(await waitFor((client) => [perClient(DEMO_PER_CLIENT, client)]));
}

/** Before a lead-form response is sent to the database. */
export async function formSubmitLimited(): Promise<string | null> {
  return fromNetwork(await waitFor((client) => [perClient(FORM_SUBMIT_PER_CLIENT, client)]));
}

/** Before a job application is sent to the database; `withCvFile` before its file is stored. */
export async function applyLimited(withCvFile: boolean): Promise<string | null> {
  return fromNetwork(await waitFor((client) => [
    perClient(APPLY_PER_CLIENT, client),
    ...(withCvFile ? [perClient(APPLY_CV_PER_CLIENT, client)] : []),
  ]));
}

/** Whether this view of a form is one to count: the first by this client in the window. */
export async function formViewCounts(formId: string): Promise<boolean> {
  return (await waitFor((client) => [perClient(FORM_VIEW_PER_CLIENT_AND_FORM, client, formId)])) === null;
}
