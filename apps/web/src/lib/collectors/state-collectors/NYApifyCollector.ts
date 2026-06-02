/**
 * New York UCC Lien Search — Apify Actor Collector
 *
 * Drives the `fortuitous_pirate~ucc-lien-search-ny` Apify actor via the
 * Apify REST API. Each search starts a synchronous actor run and reads the
 * resulting dataset items back into the canonical UCCFiling shape.
 *
 * Required env var:
 *   APIFY_API_TOKEN   — your Apify personal or organisation token
 *
 * Actor input schema (passed as JSON body):
 *   { searchQuery: string, searchType: "businessName" | "filingNumber" }
 *
 * Rate limits follow NY portal guidelines: 30 req/min, 500/hour, 5000/day.
 */

import { RateLimiter } from '../RateLimiter'
import {
  CollectionError,
  type CollectionOptions,
  type CollectorStatus,
  type SearchResult,
  type StateCollector,
  type UCCFiling,
  type ValidationResult,
  type Party,
  type Address,
  type Amendment
} from '../types'

// ─── Apify actor output shape ────────────────────────────────────────────────

interface ApifyUCCItem {
  filingNumber?: string
  fileNumber?: string
  filingType?: string
  type?: string
  filingDate?: string
  dateField?: string
  expirationDate?: string
  lapseDate?: string
  status?: string
  debtorName?: string
  debtorAddress?: string
  debtorCity?: string
  debtorState?: string
  debtorZip?: string
  securedPartyName?: string
  securedPartyAddress?: string
  securedPartyCity?: string
  securedPartyState?: string
  securedPartyZip?: string
  collateral?: string
  collateralDescription?: string
  amendments?: ApifyAmendment[]
  pages?: number
  rawData?: Record<string, unknown>
}

interface ApifyAmendment {
  filingNumber?: string
  date?: string
  type?: string
  description?: string
}

interface ApifyRunResult {
  id: string
  status: 'READY' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED-OUT' | 'ABORTED'
  defaultDatasetId: string
}

// ─── Collector config ─────────────────────────────────────────────────────────

interface NYApifyConfig {
  apifyToken: string
  actorId?: string
  baseUrl?: string
  /** ms to wait before polling a run */
  pollIntervalMs?: number
  /** ms total before giving up on a run */
  runTimeoutMs?: number
  maxRetries?: number
}

// ─── Collector implementation ─────────────────────────────────────────────────

export class NYApifyCollector implements StateCollector {
  private readonly config: Required<NYApifyConfig>
  private readonly rateLimiter: RateLimiter
  private readonly stats: {
    totalCollected: number
    totalErrors: number
    totalRequests: number
    lastCollectionTime?: string
    latencies: number[]
  }

  constructor(config: NYApifyConfig) {
    this.config = {
      apifyToken: config.apifyToken,
      actorId: config.actorId ?? 'fortuitous_pirate~ucc-lien-search-ny',
      baseUrl: config.baseUrl ?? 'https://api.apify.com/v2',
      pollIntervalMs: config.pollIntervalMs ?? 3000,
      runTimeoutMs: config.runTimeoutMs ?? 120_000,
      maxRetries: config.maxRetries ?? 3
    }

    this.rateLimiter = new RateLimiter({
      requestsPerMinute: 30,
      requestsPerHour: 500,
      requestsPerDay: 5000
    })

    this.stats = {
      totalCollected: 0,
      totalErrors: 0,
      totalRequests: 0,
      latencies: []
    }
  }

  // ── Public interface ────────────────────────────────────────────────────────

  async searchByBusinessName(name: string): Promise<SearchResult> {
    const filings = await this.runActor({ searchQuery: name, searchType: 'businessName' })
    return {
      filings,
      total: filings.length,
      hasMore: false
    }
  }

  async searchByFilingNumber(number: string): Promise<UCCFiling | null> {
    const filings = await this.runActor({ searchQuery: number, searchType: 'filingNumber' })
    return filings[0] ?? null
  }

  async getFilingDetails(filingNumber: string): Promise<UCCFiling> {
    const filing = await this.searchByFilingNumber(filingNumber)
    if (!filing) {
      throw new CollectionError(
        'NY',
        'PARSE',
        true,
        `No filing found for number: ${filingNumber}`
      )
    }
    return filing
  }

  async collectNewFilings(options: CollectionOptions): Promise<UCCFiling[]> {
    const input: Record<string, unknown> = { searchType: 'newFilings' }
    if (options.since) input.since = options.since.toISOString()
    if (options.limit) input.limit = options.limit
    if (options.filingTypes?.length) input.filingTypes = options.filingTypes

    const filings = await this.runActor(input)
    return options.includeInactive
      ? filings
      : filings.filter(f => f.status === 'active')
  }

  validateFiling(filing: UCCFiling): ValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    if (!filing.filingNumber) errors.push('Missing filing number')
    if (!filing.filingDate) errors.push('Missing filing date')
    if (!filing.debtor?.name) errors.push('Missing debtor name')
    if (!filing.securedParty?.name) errors.push('Missing secured party name')
    if (!filing.collateral) warnings.push('Missing collateral description')
    if (filing.state !== 'NY') errors.push(`Invalid state: ${filing.state}, expected NY`)

    return { valid: errors.length === 0, errors, warnings }
  }

  getStatus(): CollectorStatus {
    const rateLimitStats = this.rateLimiter.getStats()
    const latencies = this.stats.latencies
    const averageLatency =
      latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0

    return {
      isHealthy: this.stats.totalErrors === 0 || this.errorRate() < 0.5,
      lastCollectionTime: this.stats.lastCollectionTime,
      totalCollected: this.stats.totalCollected,
      errorRate: this.errorRate(),
      averageLatency,
      rateLimitStats: {
        perMinute: rateLimitStats.perMinute,
        perHour: rateLimitStats.perHour,
        perDay: rateLimitStats.perDay
      }
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private errorRate(): number {
    return this.stats.totalRequests > 0
      ? this.stats.totalErrors / this.stats.totalRequests
      : 0
  }

  /**
   * Start an actor run, poll until finished, return dataset items as UCCFilings.
   */
  private async runActor(input: Record<string, unknown>): Promise<UCCFiling[]> {
    await this.rateLimiter.acquire()
    this.stats.totalRequests++
    const t0 = Date.now()

    let attempt = 0
    while (attempt <= this.config.maxRetries) {
      try {
        const items = await this.executeRun(input)
        const filings = items.map(item => this.transformItem(item))
        this.stats.totalCollected += filings.length
        this.stats.lastCollectionTime = new Date().toISOString()
        this.stats.latencies.push(Date.now() - t0)
        if (this.stats.latencies.length > 100) this.stats.latencies.shift()
        return filings
      } catch (err) {
        attempt++
        if (attempt > this.config.maxRetries) {
          this.stats.totalErrors++
          throw this.wrapError(err)
        }
        await sleep(1000 * attempt)
      }
    }

    /* unreachable but keeps TS happy */ return []
  }

  /**
   * POST to runs endpoint (async), poll status, fetch dataset items.
   */
  private async executeRun(input: Record<string, unknown>): Promise<ApifyUCCItem[]> {
    const { baseUrl, actorId, apifyToken, pollIntervalMs, runTimeoutMs } = this.config
    const tokenParam = `token=${encodeURIComponent(apifyToken)}`

    // Start the run
    const runRes = await fetch(`${baseUrl}/acts/${encodeURIComponent(actorId)}/runs?${tokenParam}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    })

    if (!runRes.ok) {
      throw new CollectionError(
        'NY',
        'NETWORK',
        true,
        `Apify run start failed: ${runRes.status} ${runRes.statusText}`
      )
    }

    const runData = (await runRes.json()) as { data: ApifyRunResult }
    const run = runData.data
    if (!run?.id) {
      throw new CollectionError('NY', 'PARSE', true, 'Apify response missing run id')
    }

    // Poll until terminal state
    const deadline = Date.now() + runTimeoutMs
    let runStatus = run.status

    while (runStatus === 'READY' || runStatus === 'RUNNING') {
      if (Date.now() > deadline) {
        throw new CollectionError('NY', 'TIMEOUT', true, `Apify run ${run.id} timed out`)
      }
      await sleep(pollIntervalMs)

      const statusRes = await fetch(
        `${baseUrl}/actor-runs/${encodeURIComponent(run.id)}?${tokenParam}`
      )
      if (!statusRes.ok) {
        throw new CollectionError(
          'NY',
          'NETWORK',
          true,
          `Apify status poll failed: ${statusRes.status}`
        )
      }
      const statusData = (await statusRes.json()) as { data: ApifyRunResult }
      runStatus = statusData.data.status
    }

    if (runStatus !== 'SUCCEEDED') {
      throw new CollectionError(
        'NY',
        'NETWORK',
        true,
        `Apify run ${run.id} ended with status: ${runStatus}`
      )
    }

    // Fetch dataset items
    const datasetRes = await fetch(
      `${baseUrl}/actor-runs/${encodeURIComponent(run.id)}/dataset/items?${tokenParam}&format=json`
    )
    if (!datasetRes.ok) {
      throw new CollectionError(
        'NY',
        'NETWORK',
        true,
        `Apify dataset fetch failed: ${datasetRes.status}`
      )
    }

    return (await datasetRes.json()) as ApifyUCCItem[]
  }

  /**
   * Map a raw Apify actor item to the canonical UCCFiling shape.
   */
  private transformItem(item: ApifyUCCItem): UCCFiling {
    const filingNumber = item.filingNumber ?? item.fileNumber ?? ''
    const rawDate = item.filingDate ?? item.dateField ?? ''
    const filingDate = normalizeDate(rawDate)
    const expirationDate = item.expirationDate
      ? normalizeDate(item.expirationDate)
      : item.lapseDate
        ? normalizeDate(item.lapseDate)
        : undefined

    const rawStatus = (item.status ?? 'active').toLowerCase()
    const status = mapStatus(rawStatus)

    const debtor: Party = {
      name: item.debtorName ?? '',
      organizationType: 'organization',
      address: buildAddress(
        item.debtorAddress,
        item.debtorCity,
        item.debtorState,
        item.debtorZip
      )
    }

    const securedParty: Party = {
      name: item.securedPartyName ?? '',
      organizationType: 'organization',
      address: buildAddress(
        item.securedPartyAddress,
        item.securedPartyCity,
        item.securedPartyState,
        item.securedPartyZip
      )
    }

    const amendments: Amendment[] | undefined = item.amendments?.map(a => ({
      filingNumber: a.filingNumber ?? '',
      filingDate: normalizeDate(a.date ?? ''),
      amendmentType: mapAmendmentType(a.type ?? ''),
      description: a.description
    }))

    return {
      filingNumber,
      filingType: item.filingType ?? item.type ?? 'UCC-1',
      filingDate,
      expirationDate,
      status,
      state: 'NY',
      debtor,
      securedParty,
      collateral: item.collateral ?? item.collateralDescription ?? '',
      pages: item.pages,
      amendments,
      rawData: item.rawData ?? (item as unknown as Record<string, unknown>)
    }
  }

  private wrapError(err: unknown): CollectionError {
    if (err instanceof CollectionError) return err
    const msg = err instanceof Error ? err.message : String(err)
    return new CollectionError('NY', 'NETWORK', true, msg, err instanceof Error ? err : undefined)
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeDate(raw: string): string {
  if (!raw) return ''
  const d = new Date(raw)
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0]
  return raw
}

function mapStatus(raw: string): UCCFiling['status'] {
  if (raw.includes('terminat') || raw.includes('cancel')) return 'terminated'
  if (raw.includes('amend')) return 'amended'
  if (raw.includes('laps') || raw.includes('expir') || raw.includes('inactiv')) return 'lapsed'
  return 'active'
}

function mapAmendmentType(raw: string): Amendment['amendmentType'] {
  const lower = raw.toLowerCase()
  if (lower.includes('terminat')) return 'termination'
  if (lower.includes('assign')) return 'assignment'
  if (lower.includes('continu')) return 'continuation'
  return 'amendment'
}

function buildAddress(
  street?: string,
  city?: string,
  state?: string,
  zipCode?: string
): Address | undefined {
  if (!street && !city && !state && !zipCode) return undefined
  return { street, city, state, zipCode }
}

// ─── Factory helper ───────────────────────────────────────────────────────────

export function createNYApifyCollector(): NYApifyCollector | null {
  const token = process.env.APIFY_API_TOKEN
  if (!token) return null
  return new NYApifyCollector({ apifyToken: token })
}
