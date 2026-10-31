import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Declares the Plugins page's `plugins.row.config` slot the settings card registers into.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Declares the `conversation.input.dock` slot this dock registers into.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'dsh-background.dock': keyof typeof zh }
}

export type Context = ClientContext

/**
 * The client `ctx.jobs` service (rosters pushed by the Host's `job.list` stream, the human kill). Read through a cast: the
 * Host's server-side `Context.jobs` (the job registry) has the same property name in the same type universe.
 */
export type ClientJobsService = import('@deepseek-ai/dsh-api-job-controller/client').IJobs
export const clientJobs = (ctx: Context): ClientJobsService => (ctx as unknown as { jobs: ClientJobsService }).jobs
