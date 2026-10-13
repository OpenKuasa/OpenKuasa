/**
 * The sentences for every document and letter refusal code. A leaf module with no imports, so any file that needs
 * one sentence can read it without loading the write paths.
 */

/** Each refusal code the document and letter functions raise, and what the person is told. */
export const DOCUMENT_REFUSALS: Record<string, string> = {
  DOC_NOT_ALLOWED: "You can't make that change.",
  LETTER_NOT_ALLOWED: "You can't make that change.",
  DOC_NOT_FOUND: 'That document could not be found.',
  LETTER_NOT_FOUND: 'That letter could not be found.',
  DOC_BAD_INPUT: 'Some of that was not accepted. Check it and try again.',
  LETTER_BAD_INPUT: 'Some of that was not accepted. Check it and try again.',
  DOC_TYPE_NOT_ALLOWED: 'You can add identity, medical, certificate or other documents. An owner or admin adds the rest.',
  DOC_TOO_MANY: 'That is 200 documents already. Remove one first.',
  DOC_BAD_FILE: 'That file could not be attached. Upload it again.',
  DOC_ACK_NOT_REQUESTED: 'No acknowledgement is being asked for.',
  LETTER_ACK_NOT_REQUESTED: 'No acknowledgement is being asked for.',
  DOC_ALREADY_ACKNOWLEDGED: 'That has already been acknowledged.',
  LETTER_ALREADY_ACKNOWLEDGED: 'That has already been acknowledged.',
  LETTER_NOT_DRAFT: 'That letter has been issued. Pull it back to draft on the Letters screen to change it.',
  LETTER_NOT_ISSUED: 'That letter is still a draft.',
  LETTER_EMPTY: 'The letter has no text yet.',
  LETTER_PLACEHOLDER: 'The letter still has a placeholder in it. Replace it before issuing.',
  LETTER_TEMPLATE_EXISTS: 'There is already a template with that name.',
  LETTER_TOO_MANY_TEMPLATES: 'That is 50 templates already. Remove one first.',
};

/** The file could not be opened (not a refusal code: signing failed, or the document has no file). */
export const FILE_UNAVAILABLE = 'That file could not be opened. Please try again.';
