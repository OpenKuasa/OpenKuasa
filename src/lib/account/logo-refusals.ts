/**
 * The sentences for the workspace logo. A leaf module with no imports, so any file that needs one sentence can
 * read it without loading the upload or write paths.
 */

export const LOGO_NOT_IMAGE = 'That file is not a PNG, JPEG or WebP image.';
export const LOGO_TOO_BIG = 'That image is over 1 MB.';
/** The upload did not finish, or the database could not accept the file it was pointed at. */
export const LOGO_UPLOAD_FAILED = 'That image could not be saved. Upload it again.';
/** The demo's own sentence, as the rest of the account area says it. */
export const LOGO_DEMO = 'The demo workspace is read-only. Sign up to save changes.';

/** Each code `set_org_logo` and `clear_org_logo` raise, and what the person is told. */
export const LOGO_REFUSALS: Record<string, string> = {
  LOGO_NOT_ALLOWED: "You can't change the workspace logo.",
  LOGO_BAD_FILE: LOGO_UPLOAD_FAILED,
};
