/**
 * The plugin's own page content on the Plugins page (`plugins.row.config`, key `<package>#<row id>`): foreground control, the
 * steering policy, per-tool policies and the auto-background delay. The Host hands the page its configuration values and an
 * atomic `mutate`, so there is no staging here: each control writes its own field when it is committed (switch and select at
 * once, text fields on blur or Enter) and the Host reloads the plugin with the new value.
 * @module dsh-background/client/SettingsCard
 */

import { useState, type ReactNode } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import { styles as css } from './styles.ts'
import { parseDelay, parseToolPolicies, POLICIES } from './parse.ts'

export type SettingsCardProps = PropsRuntime<'plugins.row.config'> & PropsLocale<typeof NS>

function Row(props: { id: string; label: string; hint: string; error?: string | undefined; children: ReactNode }) {
  return (
    <div className={css.setRow} data-setting={props.id}>
      <div className={css.setText}>
        <label htmlFor={`dsbg-${props.id}`} className={css.setLabel}>{props.label}</label>
        <p className={css.setHint}>{props.hint}</p>
        {props.error !== undefined && <p className={css.setError} role="alert">{props.error}</p>}
      </div>
      <div className={css.setControl}>{props.children}</div>
    </div>
  )
}

export function SettingsCard({ view, form, t }: SettingsCardProps) {
  const [error, setError] = useState<Record<string, string>>({})
  const [saveFailed, setSaveFailed] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  if (view === 'summary') return <>{t('settings.summary')}</>
  if (form === undefined || form.state.status === 'unavailable') return <p className={css.setHint} data-setting-unavailable="">{t('settings.unavailable')}</p>

  const value = (form.state.value ?? {}) as Record<string, unknown>
  const writable = form.state.writable
  const write = async (field: string, next: unknown | undefined): Promise<void> => {
    setSaveFailed(false)
    try {
      const ok = await form.mutate([next === undefined ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value: next as never }], form.state.revision)
      if (!ok) setSaveFailed(true)
    } catch { setSaveFailed(true) }
  }
  const draftOf = (field: string, current: string): string => drafts[field] ?? current
  const commit = (field: string, text: string, parse: (text: string) => { ok: true; value: unknown | undefined } | { ok: false }, errorKey: string): void => {
    const parsed = parse(text)
    if (!parsed.ok) { setError(prev => ({ ...prev, [field]: t(errorKey as never) })); return }
    setError(prev => { const { [field]: _gone, ...rest } = prev; return rest })
    setDrafts(prev => { const { [field]: _gone, ...rest } = prev; return rest })
    void write(field, parsed.value)
  }

  const enabled = value.foregroundControl === true
  const policy = typeof value.onUserMessageWhileToolRuns === 'string' ? value.onUserMessageWhileToolRuns : 'wait'
  const policiesText = value.toolPolicies !== undefined && Object.keys(value.toolPolicies as object).length > 0 ? JSON.stringify(value.toolPolicies) : ''
  const delayText = typeof value.autoBackgroundAfterMs === 'number' ? String(value.autoBackgroundAfterMs) : ''

  return (
    <div className={css.settings} data-background-settings="">
      {!writable && <p className={css.setHint}>{t('settings.readOnly')}</p>}
      <Row id="foregroundControl" label={t('settings.foregroundControl')} hint={t('settings.foregroundControl.hint')}>
        <Switch checked={enabled} label={t('settings.foregroundControl')} disabled={!writable} onChange={next => { void write('foregroundControl', next) }} />
      </Row>
      <Row id="onUserMessageWhileToolRuns" label={t('settings.policy')} hint={t('settings.policy.hint')}>
        <select
          id="dsbg-onUserMessageWhileToolRuns" className={css.setSelect} value={policy} disabled={!writable}
          onChange={event => { void write('onUserMessageWhileToolRuns', event.target.value === 'wait' ? undefined : event.target.value) }}
        >
          {POLICIES.map(option => <option key={option} value={option}>{t(`settings.policy.${option}`)}</option>)}
        </select>
      </Row>
      <Row id="toolPolicies" label={t('settings.toolPolicies')} hint={t('settings.toolPolicies.hint')} error={error.toolPolicies}>
        <textarea
          id="dsbg-toolPolicies" className={css.setInput} rows={3} spellCheck={false} disabled={!writable} placeholder='{"web_call": "background"}'
          value={draftOf('toolPolicies', policiesText)}
          onChange={event => { setDrafts(prev => ({ ...prev, toolPolicies: event.target.value })) }}
          onBlur={event => commit('toolPolicies', event.target.value, text => {
            const parsed = parseToolPolicies(text)
            return parsed === undefined ? { ok: false } : { ok: true, value: Object.keys(parsed).length === 0 ? undefined : parsed }
          }, 'settings.toolPolicies.invalid')}
        />
      </Row>
      <Row id="autoBackgroundAfterMs" label={t('settings.autoBackground')} hint={t('settings.autoBackground.hint')} error={error.autoBackgroundAfterMs}>
        <input
          id="dsbg-autoBackgroundAfterMs" className={css.setInput} inputMode="numeric" disabled={!writable} placeholder="—"
          value={draftOf('autoBackgroundAfterMs', delayText)}
          onChange={event => { setDrafts(prev => ({ ...prev, autoBackgroundAfterMs: event.target.value })) }}
          onBlur={event => commit('autoBackgroundAfterMs', event.target.value, text => {
            const parsed = parseDelay(text)
            return parsed === undefined ? { ok: false } : { ok: true, value: parsed === null ? undefined : parsed }
          }, 'settings.autoBackground.invalid')}
          onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
        />
      </Row>
      <p className={css.setHint}>{t('settings.restart')}</p>
      {saveFailed && <p className={css.setError} role="alert">{t('settings.saveFailed')}</p>}
    </div>
  )
}
