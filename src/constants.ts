/**
 * Canonical server addon id (mirror of `ADDON_ID` in `lib/main.rs`).
 *
 * Pane queries/mutations normally route through the host's `addon: ''` +
 * `pane: <kind>` fallback, but panes that talk to the addon over a raw fetch
 * (e.g. the explorer's remote/SFTP operations) must address it by id.
 */
export const ADDON_ID = 'sh.zem.base'
