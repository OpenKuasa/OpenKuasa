// Where the floating "Ask Sari" button sits. The button positions itself from
// these values and the app shell's scrolling area reserves room from the same
// ones, so the last content can always be scrolled clear of the button.

/** Gap between the button and the bottom edge of the viewport, in rem. */
export const ASSISTANT_FAB_OFFSET_REM = 1.25;

/** Minimum height of the button, in rem. */
export const ASSISTANT_FAB_HEIGHT_REM = 2.75;

/** Breathing room kept between the last content and the button, in rem. */
export const ASSISTANT_FAB_GAP_REM = 1;

/** Bottom space the scrolling area reserves so nothing ends up under the button. */
export const ASSISTANT_FAB_CLEARANCE_REM =
  ASSISTANT_FAB_OFFSET_REM + ASSISTANT_FAB_HEIGHT_REM + ASSISTANT_FAB_GAP_REM;

/**
 * The Command page is the assistant at full size, so the button is not drawn
 * there and nothing needs to be reserved for it.
 */
export function showsAssistantFab(pathname: string): boolean {
  return pathname !== '/command';
}
