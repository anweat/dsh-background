/**
 * The dock's stylesheet. It repeats the geometry of the Host's own input docks (QueueDock, TodoDock: the same width, the same
 * 3px tuck under the composer card, the same panel material) using the Host's tokens, so it follows light and dark themes and
 * sits with them. Class names are prefixed so nothing collides with the Host's CSS modules.
 * @module dsh-background/client/styles
 */

export const styles = {
  dock: 'dsbg-dock', panel: 'dsbg-panel', section: 'dsbg-section', header: 'dsbg-header', headerText: 'dsbg-header-text', chevron: 'dsbg-chevron',
  list: 'dsbg-list', row: 'dsbg-row', lead: 'dsbg-lead', tool: 'dsbg-tool', args: 'dsbg-args', label: 'dsbg-label', meta: 'dsbg-meta', time: 'dsbg-time',
  actions: 'dsbg-actions', action: 'dsbg-action', notice: 'dsbg-notice', status: 'dsbg-status', settled: 'dsbg-settled',
} as const

const STYLE_ID = 'dsh-background-dock-styles'

/** Inject the stylesheet, or refresh it in place (a hot-reloaded plugin keeps the page and the `<style>` an older version left). */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(STYLE_ID)
  const style = existing ?? document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.dsbg-dock{box-sizing:border-box;flex:none;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px);padding:0 var(--dsh-composer-dock-inset)}
.dsbg-panel{position:relative;isolation:isolate;overflow:hidden;width:100%;padding:2px 0;border-radius:var(--dsw-radius-lg) var(--dsw-radius-lg) 0 0}
.dsbg-panel::before{position:absolute;z-index:-1;inset:0;border-radius:inherit;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);content:'';pointer-events:none}
.dsbg-panel::after{position:absolute;inset:0;border:0.5px solid var(--dsw-alias-border-l1);border-bottom:none;border-radius:inherit;content:'';pointer-events:none}
.dsbg-section+.dsbg-section{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}
.dsbg-header{box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;height:36px;padding:4px 12px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;font:inherit}
.dsbg-header:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dsbg-header-text{flex:1 1 auto;min-width:0;font-family:Inter,var(--dsw-font-family);font-size:13px;font-weight:500;line-height:24px}
.dsbg-chevron{display:grid;flex:none;place-items:center;width:14px;height:14px;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1}
.dsbg-list{max-height:180px;overflow-y:auto;margin:0;padding:0;list-style:none}
.dsbg-row{box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;min-height:36px;padding:4px 5px 4px 12px;border-radius:var(--dsw-radius-md);font-family:Inter,var(--dsw-font-family);font-size:13px;color:var(--dsw-alias-label-primary)}
.dsbg-row+.dsbg-row{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}
.dsbg-lead{display:grid;flex:none;place-items:center;color:var(--dsw-alias-label-tertiary)}
.dsbg-tool{flex:none;font-weight:500;line-height:24px}
.dsbg-args,.dsbg-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);line-height:24px}
.dsbg-label{color:var(--dsw-alias-label-primary)}
.dsbg-meta{flex:0 1 auto;min-width:0;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsbg-time{flex:none;min-width:38px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsbg-actions{display:flex;flex:none;gap:2px;align-items:center}
.dsbg-action{white-space:nowrap}
.dsbg-notice{margin:0;padding:6px 12px;font-size:12px;color:var(--dsw-alias-state-error-primary)}
.dsbg-status{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsbg-settled .dsbg-label{color:var(--dsw-alias-label-tertiary)}
`
  if (existing === null) document.head.appendChild(style)
}
