import { AuthenticatedBaseCommand } from '../base/authenticated-base-command'
import { CliUx, Flags } from '@oclif/core'
import * as utils from '../utils'
import * as chrono from 'chrono-node'
import jp from 'jsonpath'
import { splitDedupAndFlatten } from '../utils'

export default class Log extends AuthenticatedBaseCommand<typeof Log> {
  static description = 'Show PagerDuty Domain Log Entries'

  static flags = {
    since: Flags.string({
      description: 'The start of the date range over which you want to search.',
      default: '30 days ago',
    }),
    until: Flags.string({
      description: 'The end of the date range over which you want to search.',
    }),
    overview: Flags.boolean({
      char: 'O',
      description: 'Get only `overview` log entries',
    }),
    keys: Flags.string({
      char: 'k',
      description: 'Additional fields to display. Specify multiple times for multiple fields.',
      multiple: true,
    }),
    json: Flags.boolean({
      char: 'j',
      description: 'output full details as JSON',
      exclusive: ['columns', 'filter', 'sort', 'csv', 'extended'],
    }),
    delimiter: Flags.string({
      char: 'd',
      description: 'Delimiter for fields that have more than one value',
      default: '\\n',
    }),
    ...CliUx.ux.table.flags(),
  }

  public async init(): Promise<void> {
    await super.init()
    if (this.flags.delimiter === '\\n') {
      this.flags.delimiter = '\n'
    }
    if (this.flags.keys) {
      this.flags.keys = splitDedupAndFlatten(this.flags.keys)
    }
  }

  async run() {
    const params: Record<string, any> = {
      is_overview: this.flags.overview,
    }

    if (this.flags.since) {
      const since = chrono.parseDate(this.flags.since)
      if (since) {
        params.since = since.toISOString()
      }
    }
    if (this.flags.until) {
      const until = chrono.parseDate(this.flags.until)
      if (until) {
        params.until = until.toISOString()
      }
    }

    const log_entries = await this.pd.fetchWithSpinner('log_entries', {
      params: params,
      activityDescription: 'Getting log entries',
    })

    if (log_entries.length === 0) {
      this.exit(0)
    }
    if (this.flags.json) {
      await utils.printJsonAndExit(log_entries)
    }

    const columns: Record<string, object> = {
      id: {
        header: 'Log Entry ID',
      },
      type: {
        header: 'Log Entry Type',
      },
      created: {
        get: (row: { created_at: string }) => (new Date(row.created_at)).toLocaleString(),
      },
      summary: {
      },
    }

    if (this.flags.keys) {
      for (const key of this.flags.keys) {
        columns[key] = {
          header: key,
          get: (row: any) => utils.formatField(jp.query(row, key), this.flags.delimiter),
        }
      }
    }
    if (!this.flags.sort) {
      this.flags.sort = 'created'
    }

    const options = {
      ...this.flags, // parsed flags
    }
    CliUx.ux.table(log_entries, columns, options)
  }
}
