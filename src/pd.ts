import axios, {Method} from 'axios'

const BASE_URL = 'https://api.pagerduty.com'
const globalAny: any = global

export class Result<T> {
  public isSuccess: boolean

  public isFailure: boolean

  public error!: string

  public fullError: any

  private _value!: T

  private constructor(isSuccess: boolean, error?: any, value?: T) {
    if (isSuccess && error) {
      throw new Error(`InvalidOperation: A result cannot be 
        successful and contain an error`)
    }
    if (!isSuccess && !error) {
      throw new Error(`InvalidOperation: A failing result 
        needs to contain an error message`)
    }

    this.isSuccess = isSuccess
    this.isFailure = !isSuccess
    if (error) {
      this.fullError = error
      if (typeof error === 'string') {
        this.error = error
      } else if (error.response && error.response.status && error.response.statusText) {
        this.error = `${error.response.status} ${error.response.statusText}`
      }
    }

    if (value) {
      this._value = value
    }

    Object.freeze(this)
  }

  public getValue(): T {
    if (!this.isSuccess) {
      throw new Error('Can\'t retrieve the value from a failed result.')
    }
    return this._value
  }

  public getPDErrorMessage(): string {
    let message = this.error
    if (this.fullError && this.fullError.response && this.fullError.response.data && this.fullError.response.data.error) {
      const pdError = this.fullError.response.data.error
      if (pdError.message) {
        message += `: ${pdError.message}`
        if (pdError.errors) {
          message += `: ${pdError.errors.join(' ')}`
        }
        return message
      }
    }
    return message
  }

  public getFullError(): any {
    return this.fullError
  }

  public static ok<U>(value?: U): Result<U> {
    return new Result<U>(true, undefined, value)
  }

  public static fail<U>(error: string | object): Result<U> {
    return new Result<U>(false, error)
  }

  public static combine(results: Result<any>[]): Result<any> {
    for (const result of results) {
      if (result.isFailure) return result
    }
    return Result.ok<any>()
  }
}

export function isBearerToken(token: string): boolean {
  if (token && token.match(/^[0-9a-fA-F]{64}$/)) {
    return true
  }
  return false
}

export function isLegacyToken(token: string): boolean {
  // eslint-disable-next-line no-useless-escape
  if (token && token.match(/^[0-9a-zA-Z_\-\+\/=]{20}$/)) {
    return true
  }
  return false
}

export function isValidToken(token: string): boolean {
  if (isBearerToken(token) || isLegacyToken(token)) {
    return true
  }
  return false
}

export function authHeaderForToken(token: string): string {
  if (isBearerToken(token)) {
    return `Bearer ${token}`
  // eslint-disable-next-line no-else-return
  } else if (isLegacyToken(token)) {
    return `Token token=${token}`
  }
  throw new Error(`Invalid token ${token}`)
}

// eslint-disable-next-line max-params
export async function request(
  token: string,
  endpoint: string,
  method: Method = 'GET',
  params: object | null = {},
  data?: object,
  headers?: object
): Promise<Result<any>> {
  let h = {
    Accept: 'application/vnd.pagerduty+json;version=2',
    Authorization: authHeaderForToken(token),
    'Content-Type': 'application/json',
    'User-Agent': `pagerduty-cli/${globalAny.config.version}`,
    'X-PagerDuty-Client': `pagerduty-cli ${globalAny.config.version}`,
  }
  if (headers) {
    h = {...h, ...headers}
  }
  const config = {
    method: method,
    baseURL: BASE_URL,
    url: endpoint,
    params: params,
    headers: h,
    data: data,
  }
  let r: any
  try {
    r = await axios.request(config)
  } catch (error) {
    if (error.response) {
      return Result.fail<any>(error)
    }
    return Result.fail<any>('unknown error')
  }
  return Result.ok<any>(r.data)
}

export async function batchedRequest(requests: any[], batchSize = 25): Promise<Result<any>> {
  let promises: any[] = []
  let results: any[] = []
  for (const r of requests) {
    promises.push(request(
      r.token,
      r.endpoint,
      r.method,
      r.params,
      r.data,
      r.headers
    ))
    if (promises.length >= batchSize) {
      // eslint-disable-next-line no-await-in-loop
      const batchResults: Result<any>[] = await Promise.all(promises)
      if (batchResults.some(r => r.isFailure)) {
        return Result.combine(batchResults)
      }
      results = [...results, ...batchResults.map(r => r.getValue())]
      promises = []
    }
  }
  const batchResults: Result<any>[] = await Promise.all(promises)
  if (batchResults.some(r => r.isFailure)) {
    return Result.combine(batchResults)
  }
  results = [...results, ...batchResults.map(r => r.getValue())]
  return Result.ok<any>(results)
}

function endpointIdentifier(endpoint: string): string {
  if (endpoint.match(/users\/P.*\/sessions/)) {
    return 'user_sessions'
  }
  return endpoint.split('/').pop() as string
}
export async function fetch(
  token: string,
  endpoint: string,
  params = {}): Promise<Result<any>> {
  const limit = 25
  const endpoint_identifier = endpointIdentifier(endpoint)
  const commonParams = {
    total: true,
    limit: limit,
  }

  let getParams = Object.assign({}, commonParams, params)
  let r = await request(token, endpoint, 'get', getParams)
  if (r.isFailure) {
    return r
  }
  const firstPage = r.getValue()
  let fetchedData = firstPage[endpoint_identifier]
  if (firstPage.more) {
    // classic pagination
    const requests: any[] = []
    for (let offset = limit; offset < firstPage.total; offset += limit) {
      getParams = Object.assign({}, getParams, {offset: offset})
      requests.push({
        token: token,
        endpoint: endpoint,
        method: 'get',
        params: getParams,
      })
    }
    r = await batchedRequest(requests)
    if (r.isFailure) {
      return r
    }
    const pages = r.getValue()
    for (const page of pages) {
      fetchedData = [...fetchedData, ...page[endpoint_identifier]]
    }
  } else if (firstPage.next_cursor) {
    // cursor-based pagination
    let next_cursor = firstPage.next_cursor
    while (next_cursor) {
      getParams = Object.assign({}, getParams, {cursor: next_cursor})
      // eslint-disable-next-line no-await-in-loop
      r = await request(token, endpoint, 'get', getParams)
      if (r.isFailure) {
        return r
      }
      const page = r.getValue()
      fetchedData = [...fetchedData, ...page[endpoint_identifier]]
      next_cursor = page.next_cursor
    }
  }
  return Result.ok<any>(fetchedData)
}

export async function me(token: string): Promise<Result<any>> {
  const r = await request(token, '/users/me')
  return r
}

export async function userIDForEmail(token: string, email: string): Promise<string | null> {
  const r = await request(token, 'users', 'GET', {query: email})
  if (r.isFailure) {
    return null
  }
  try {
    const users = r.getValue().users
    if (users.length === 1) {
      return users[0].id
    }
    return null
  } catch (error) {
    return null
  }
}

export async function userIDsForEmails(token: string, emails: string[]): Promise<string[]> {
  let fetchedUsers: any[] = []
  for (const email of emails) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch(token, 'users', {query: email})
      if (r.isSuccess) {
        fetchedUsers = [...fetchedUsers, ...r.getValue()]
      }
    } catch (error) {
    }
  }
  const fetchedUserIDs = fetchedUsers.map(x => x.id)
  return [...new Set(fetchedUserIDs)]
}

export async function scheduleIDForName(token: string, name: string): Promise<string | null> {
  const r = await request(token, 'schedules', 'GET', {query: name})
  if (r.isFailure) {
    return null
  }
  try {
    const schedules = r.getValue().schedules
    if (schedules.length === 1) {
      return schedules[0].id
    }
    return null
  } catch (error) {
    return null
  }
}

export async function epIDForName(token: string, name: string): Promise<string | null> {
  const r = await request(token, 'escalation_policies', 'GET', {query: name})
  if (r.isFailure) {
    return null
  }
  try {
    const escalation_policies = r.getValue().escalation_policies
    if (escalation_policies.length === 1) {
      return escalation_policies[0].id
    }
    return null
  } catch (error) {
    return null
  }
}

export async function getPrioritiesMapBy(token: string, attr: string): Promise<Result<any>> {
  if (!isValidToken(token)) {
    return Result.fail<any>(`Invalid token '${token}`)
  }
  const r = await fetch(token, '/priorities')
  if (r.isFailure) {
    if (r.fullError && r.fullError.response.status === 404) {
      // priorities are disabled - return empty map
      return Result.ok<any>({})
    }
    return r
  }
  const priorities = r.getValue()
  const priorities_map: Record<string, any> = {}
  for (const priority of priorities) {
    priorities_map[priority[attr]] = priority
  }
  return Result.ok(priorities_map)
}

export async function getPrioritiesMapByName(token: string): Promise<Result<any>> {
  return getPrioritiesMapBy(token, 'name')
}

export async function getPrioritiesMapByID(token: string): Promise<Result<any>> {
  return getPrioritiesMapBy(token, 'id')
}

export function putBodyForSetAttributes(
  pdObjectType: string,
  pdObjectId: string,
  attributes: { key: string; value: string | null }[],
) {
  const body: Record<string, any> = {
    [pdObjectType]: {
      id: pdObjectId,
      type: `${pdObjectType}_reference`,
    },
  }
  for (const attribute of attributes) {
    body[pdObjectType][attribute.key] = (attribute.value && attribute.value.trim().length > 0) ? attribute.value : null
  }
  return body
}

export function putBodyForSetAttribute(
  pdObjectType: string,
  pdObjectId: string,
  pdAttributeName: string,
  pdAttributeValue: string | null
) {
  return putBodyForSetAttributes(pdObjectType, pdObjectId, [{key: pdAttributeName, value: pdAttributeValue}])
}
