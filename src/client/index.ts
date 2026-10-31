import { clientJobs, type Context } from './context-types.ts'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ForegroundController } from './foreground.ts'
import { Dock, type DockInjected } from './Dock.tsx'
import { SettingsCard } from './SettingsCard.tsx'
import { en, NS, zh } from './locales.ts'
import { ensureStyles } from './styles.ts'

export const name = 'dsh-background-client'
// connection: the plugin's private RPC channel; jobs: the Host's pushed job rosters and the human kill; locale, slots: copy and placement.
export const inject = ['slots', 'locale', 'connection', 'jobs']
export { NS }
export type { DockInjected, DockProps } from './Dock.tsx'

export function apply(ctx: Context): void {
  ensureStyles()
  const jobs = clientJobs(ctx)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-background: dock dictionaries')

  const rpc = (ctx as unknown as { connection: { rpc: ClientConnectionRpc } }).connection.rpc
  // One controller per session the dock is bound to; its polling only runs while the dock asks for it.
  const controllers = new Map<string, ForegroundController>()
  const controllerFor = (sessionId: string): ForegroundController => {
    let controller = controllers.get(sessionId)
    if (controller === undefined) controllers.set(sessionId, controller = new ForegroundController(rpc, sessionId))
    return controller
  }
  ctx.effect(() => () => { for (const controller of controllers.values()) controller.dispose(); controllers.clear() }, 'dsh-background: dock controllers')

  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'background',
      // Between the todo panel (0) and the queue (20).
      order: 10,
      locale: NS,
      inject: (sessionId): DockInjected => {
        const controller = controllerFor(sessionId)
        return {
          hooks: { foreground: controller, jobs: jobs.state },
          watch: () => controller.watch(),
          ensureStatus: () => { void controller.ensureStatus() },
          watchJobs: () => jobs.watchRows(sessionId as SessionId),
          transfer: callId => controller.act('transfer', callId),
          interrupt: callId => controller.act('interrupt', callId),
          killJob: async jobId => (await jobs.kill(sessionId as SessionId, jobId as JobId)).ok,
        }
      },
    }, Dock)), 'dsh-background: input dock')

  // The plugin's configuration on its Plugins page. The row id is the one `cordis.patch.yml` declares.
  ctx.effect(() => ctx.slots.inject('plugins.row.config', () =>
    ctx.slots.register({ name: 'plugins.row.config', key: '@anweat/dsh-background#background', locale: NS }, SettingsCard)), 'dsh-background: settings page')
}
